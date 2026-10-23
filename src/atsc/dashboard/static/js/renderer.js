// Network renderer: four stacked canvases per controller.
//
// The roads, blocks and markings are painted once per resize into the bottom canvas, and the
// edge fade once into the third one; every animation frame clears the second canvas and draws
// only what moves: lamps, queued vehicles, vehicles on links, vehicles crossing junctions and
// vehicles leaving the grid. The browser composites the layers, so the static picture costs
// nothing per frame. Positions come from `Side.display(vt)` (model.js), i.e. from the exact
// simulator state at the interpolated display time - nothing here invents traffic.
//
// India drives on the LEFT: traffic heading in direction d keeps to the left of the road's
// centre line, which on screen (y pointing down) is the side (d.y, -d.x).
//
// Emergency tracking (setTracking): every emergency vehicle the tracker follows (tracker.js)
// gets a pulsing halo, a label saying whether it is moving, waiting or through, a fading trail
// of where it has just been and its route ahead to the edge of the grid; the signal it waits
// at (or drives to) is ringed in the colour it shows, and the rest of the map can be dimmed
// around it ("focus"). One that waits too far back in a long queue to be drawn, or drives onto
// a link already full of queued vehicles, is marked at that queue's "+n" badge (or where its
// link comes into view), so it is never lost from view. Once it has left the grid a "Through"
// marker stays where it left for THROUGH_MS. The vehicles, halos, rings and labels go on the
// top canvas, above the edge fade.

import { SpriteCache, drawVehicle } from "./sprites.js";
import { fmtClock } from "./tracker.js";

const AP = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N E S W: from the junction towards that arm
const STUB = 0.62;                                // boundary arms are drawn 0.62 links long
// slow / heavy vehicles keep to the kerb lane, emergency vehicles take the inner lane
const KERB_KINDS = new Set(["bicycle", "cycle_rickshaw", "erick", "tractor", "tempo", "truck",
                            "bus", "school_bus"]);
const TWO_WHEELERS = new Set(["bike", "scooter", "bicycle"]);
const COLORS = { go: "#22d47b", amber: "#ffb020", stop: "#ff4d5e" };
// tracking overlay: the vehicle's own colour (halo, route, trail) and one colour per status
const TRACK = { halo: "#ff3d6e", route: "rgba(255,92,128,.9)", dim: "rgba(3,6,14,.70)" };
const STATUS_COLOR = { moving: "#22d47b", through: "#22d47b", waiting: "#ffb020", stuck: "#ff4d5e",
                       pending: "#9aaccc" };
const TRAIL_MS = 2600;
const THROUGH_MS = 10000;          // how long the "Through" marker stays where it left the grid

const leftOf = (d) => [d[1], -d[0]];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

export class NetworkView {
  /**
   * @param {HTMLCanvasElement} canvas  the visible canvas
   * @param {HTMLElement} stage          its sized container
   * @param {import("./model.js").Model} model
   * @param {"rl"|"ft"} sideName
   */
  constructor(canvas, stage, model, sideName) {
    this.canvas = canvas;
    this.stage = stage;
    this.model = model;
    this.sideName = sideName;
    this.ctx = canvas.getContext("2d");
    const layer = (where) => {
      const c = document.createElement("canvas");
      c.className = "layer";
      c.setAttribute("aria-hidden", "true");
      canvas.insertAdjacentElement(where, c);
      return c;
    };
    this.bg = layer("beforebegin");          // roads, blocks, markings
    this.fg = layer("afterend");             // edge fade over the moving traffic
    // the tracked emergency vehicles, their halos and labels: on a layer of their own above
    // the edge fade, so one at the very edge of the map is still plain to see
    this.ov = document.createElement("canvas");
    this.ov.className = "layer";
    this.ov.setAttribute("aria-hidden", "true");
    this.fg.insertAdjacentElement("afterend", this.ov);
    this.ovUsed = false;
    this.sprites = new SpriteCache();
    this.g = null;
    this.built = false;
    this.qpos = new Map();          // smoothed queue positions: ai * 2^20 + abs -> back distance
    this.lastVt = null;
    this.stats = { counts: [], emergency: [], queued: 0, moving: 0 };
    this.tracks = [];               // tracker.js Track objects of this grid
    this.focus = true;              // dim the map around tracked vehicles
    this.statusText = null;         // (track, slot) -> label text, set by the page
    this.trails = new Map();        // track id -> [{x, y, at}] recent positions (CSS px)
    this.overflowAt = new Map();    // approach index -> [n hidden, far] of the last frame
    this.tracked = [];              // where each tracked vehicle was drawn in the last frame
    this.selectedKey = null;        // the trip shown in the tracker panel (full label)
    this.order = [];                // trip keys in the panel's tab order (numbered tags)
    this.lastAt = new Map();        // track id -> where it was last drawn {x, y, ang, track}
    this.marks = new Map();         // track id -> {x, y, ang, track, at}: "Through" markers
  }

  /** True while something on the map still changes by itself (a "Through" marker). */
  busy() {
    return this.marks.size > 0;
  }

  /**
   * The emergency vehicles to highlight and whether to dim the rest of the map. With several
   * on the road, the one shown in the tracker panel (`selected`, a trip key) gets the full
   * label and the others a numbered tag matching the panel's tabs (`order`: trip keys).
   */
  setTracking(tracks, focus, statusText, selected = null, order = []) {
    this.tracks = tracks || [];
    this.focus = !!focus;
    if (statusText) this.statusText = statusText;
    this.selectedKey = selected;
    this.order = order;
  }

  /** Geometry that only depends on `hello` (call after every hello). */
  setHello() {
    const hello = this.model.hello;
    const grid = hello.grid;
    this.ids = grid.ids;
    this.xy = grid.xy;
    const index = new Map();
    grid.ids.forEach((id, j) => {
      const m = /^J(\d+)_(\d+)$/.exec(id);
      index.set(m ? `${m[1]}_${m[2]}` : id, j);
    });
    // neighbour junction per arm (or -1 at the boundary), from the J<row>_<col> ids
    this.neigh = grid.ids.map((id) => {
      const m = /^J(\d+)_(\d+)$/.exec(id);
      const r = m ? +m[1] : 0, c = m ? +m[2] : 0;
      return [[r - 1, c], [r, c + 1], [r + 1, c], [r, c - 1]]
        .map(([rr, cc]) => (index.has(`${rr}_${cc}`) ? index.get(`${rr}_${cc}`) : -1));
    });
    this.greens = grid.phases.map(([, approaches]) => new Set([...approaches].map((ch) => "NESW".indexOf(ch))));
    const xs = this.xy.map((p) => p[0]), ys = this.xy.map((p) => p[1]);
    const link = +grid.link;
    this.world = { minX: Math.min(...xs) - STUB * link, maxX: Math.max(...xs) + STUB * link,
                   minY: Math.min(...ys) - STUB * link, maxY: Math.max(...ys) + STUB * link, link };
    this.qpos.clear();
    this.lastVt = null;
    this.g = null;
  }

  /** Width / height of the drawn world (the stage uses it as its aspect ratio). */
  aspect() {
    const w = this.world;
    return w ? (w.maxX - w.minX) / (w.maxY - w.minY) : 1;
  }

  /** Re-measure the stage; rebuilds the static layer when the size or pixel ratio changed. */
  resize() {
    if (!this.world) return false;
    const rect = this.stage.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
    // full device resolution, but at most ~2.2 megapixels per canvas (phones get their 3x,
    // a big 4K window is drawn slightly softer rather than slowly)
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(2.2e6 / (W * H))));
    if (this.g && this.g.W === W && this.g.H === H && this.g.dpr === dpr) return false;
    for (const c of [this.bg, this.canvas, this.fg, this.ov]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    this.layout(W, H, dpr);
    this.buildStatic();
    return true;
  }

  layout(W, H, dpr) {
    const w = this.world;
    const s = Math.min(W / (w.maxX - w.minX), H / (w.maxY - w.minY));
    const ox = (W - (w.maxX - w.minX) * s) / 2, oy = (H - (w.maxY - w.minY) * s) / 2;
    const S = w.link * s;                                  // junction spacing in px
    // Vehicles are drawn about 3x larger than the distances between junctions (at true scale
    // a car would be a few pixels long); roads and lanes use the vehicle scale so they fit.
    const ppm = clamp(S / 40, 1.5, 9);                     // vehicle-body px per metre
    const laneW = 2.75 * ppm, median = 0.8 * ppm;
    const hr = median / 2 + 2 * laneW;                     // half road width (2 lanes each way)
    const zebra = 2.0 * ppm;
    const stopD = hr + zebra + 0.5 * ppm;                  // centre -> stop line
    const centres = this.xy.map(([x, y]) => [ox + (x - w.minX) * s, oy + (y - w.minY) * s]);
    const linkLen = S - stopD - hr;                        // stop line -> upstream box edge
    const stubLen = STUB * S;
    const room = [];
    for (let j = 0; j < centres.length; j++) {
      for (let a = 0; a < 4; a++) room.push(this.neigh[j][a] >= 0 ? linkLen : stubLen - stopD - 2);
    }
    this.g = { W, H, dpr, s, S, ppm, laneW, median, hr, zebra, stopD, centres, linkLen, stubLen,
               room, ox, oy };
    this.sprites.configure(ppm, dpr);
    this.qpos.clear();
    this.trails.clear();
  }

  laneU(lane) {                       // lateral offset of a lane centre (0 = kerb, 1 = inner)
    const g = this.g;
    return g.median / 2 + g.laneW * (lane === 0 ? 1.5 : 0.5);
  }

  // ------------------------------------------------------------------ static layer
  buildStatic() {
    const g = this.g;
    const ctx = this.bg.getContext("2d");
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.fillStyle = "#0a1220";
    ctx.fillRect(0, 0, g.W, g.H);

    const xs = [...new Set(g.centres.map((c) => Math.round(c[0] * 100) / 100))].sort((a, b) => a - b);
    const ys = [...new Set(g.centres.map((c) => Math.round(c[1] * 100) / 100))].sort((a, b) => a - b);
    const x0 = xs[0] - g.stubLen, x1 = xs[xs.length - 1] + g.stubLen;
    const y0 = ys[0] - g.stubLen, y1 = ys[ys.length - 1] + g.stubLen;

    // city blocks between the roads
    const cuts = (vals, lo, hi) => {
      const out = [];
      let prev = lo - 4000;
      for (const v of vals) { out.push([prev, v - g.hr]); prev = v + g.hr; }
      out.push([prev, hi + 4000]);
      return out;
    };
    const colCuts = cuts(xs, x0, x1), rowCuts = cuts(ys, y0, y1);
    let cell = 0;
    for (const [by0, by1] of rowCuts) {
      for (const [bx0, bx1] of colCuts) {
        this.paintBlock(ctx, Math.max(-20, bx0), Math.max(-20, by0),
                        Math.min(g.W + 20, bx1), Math.min(g.H + 20, by1), cell++,
                        rowCuts.length, colCuts.length);
      }
    }

    // roads: one horizontal road per row and one vertical road per column, edge to edge;
    // kerbs first, then asphalt, then markings, so crossing roads never draw over each other
    for (let pass = 0; pass < 3; pass++) {
      for (const y of ys) this.paintRoad(ctx, [-10, y], [g.W + 10, y], xs, true, pass);
      for (const x of xs) this.paintRoad(ctx, [x, -10], [x, g.H + 10], ys, false, pass);
    }
    for (let j = 0; j < g.centres.length; j++) this.paintJunction(ctx, j);

    // edge fade over the moving traffic: the stubs (and the queues on them) melt into the
    // dark, so the grid reads as part of a larger city
    const fctx = this.fg.getContext("2d");
    fctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    fctx.clearRect(0, 0, g.W, g.H);
    const fade = Math.max(12, g.stubLen * 0.35);
    g.fade = fade;
    const edge = (gx0, gy0, gx1, gy1, x, y, w, h) => {
      const grad = fctx.createLinearGradient(gx0, gy0, gx1, gy1);
      grad.addColorStop(0, "rgba(10,18,32,.9)");
      grad.addColorStop(1, "rgba(10,18,32,0)");
      fctx.fillStyle = grad;
      fctx.fillRect(x, y, w, h);
    };
    edge(0, 0, fade, 0, 0, 0, fade, g.H);
    edge(g.W, 0, g.W - fade, 0, g.W - fade, 0, fade, g.H);
    edge(0, 0, 0, fade, 0, 0, g.W, fade);
    edge(0, g.H, 0, g.H - fade, 0, g.H - fade, g.W, fade);
    this.built = true;
  }

  paintBlock(ctx, x0, y0, x1, y1, seed, nRows, nCols) {
    const g = this.g;
    const w = x1 - x0, h = y1 - y0;
    if (w < 6 || h < 6) return;
    const foot = 1.8 * g.ppm;
    roundRect(ctx, x0, y0, w, h, foot);
    ctx.fillStyle = "#1a2538"; ctx.fill();                       // footpath
    const ix0 = x0 + foot, iy0 = y0 + foot, iw = w - 2 * foot, ih = h - 2 * foot;
    if (iw < 4 || ih < 4) return;
    roundRect(ctx, ix0, iy0, iw, ih, foot * 0.6);
    const rnd = mulberry32(seed * 7919 + 17);
    const inner = seed % (nCols) !== 0 && seed % nCols !== nCols - 1 && seed >= nCols &&
                  seed < nCols * (nRows - 1);
    const park = inner && rnd() < 0.5;
    ctx.fillStyle = park ? "#0f2a20" : "#0f1828"; ctx.fill();
    if (park) {
      ctx.save(); ctx.clip();
      ctx.strokeStyle = "rgba(160,190,150,.18)"; ctx.lineWidth = Math.max(1, g.ppm * 0.6);
      ctx.beginPath(); ctx.moveTo(ix0, iy0); ctx.lineTo(ix0 + iw, iy0 + ih);
      ctx.moveTo(ix0 + iw, iy0); ctx.lineTo(ix0, iy0 + ih); ctx.stroke();      // footpaths
      const n = Math.round((iw * ih) / (g.ppm * g.ppm * 60));
      for (let i = 0; i < n; i++) {
        const tx = ix0 + rnd() * iw, ty = iy0 + rnd() * ih, r = g.ppm * (1.6 + rnd() * 1.8);
        ctx.beginPath(); ctx.arc(tx + r * 0.25, ty + r * 0.3, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();
        ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2);
        ctx.fillStyle = ["#1d5a3a", "#22663f", "#18503a"][i % 3]; ctx.fill();
        ctx.beginPath(); ctx.arc(tx - r * 0.3, ty - r * 0.3, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(140,220,150,.18)"; ctx.fill();
      }
      ctx.restore();
      return;
    }
    // buildings with rooftop water tanks
    ctx.save(); ctx.clip();
    const cols = Math.max(1, Math.round(iw / (g.ppm * 14))), rows = Math.max(1, Math.round(ih / (g.ppm * 14)));
    const cw = iw / cols, ch = ih / rows;
    const roofs = ["#1b2739", "#1e2b40", "#18233a", "#222f45", "#1a2a33"];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rnd() < 0.12) continue;                                    // an empty plot
        const m = g.ppm * (0.8 + rnd() * 1.4);
        const bx = ix0 + c * cw + m, by = iy0 + r * ch + m, bw = cw - 2 * m, bh = ch - 2 * m;
        if (bw < 3 || bh < 3) continue;
        ctx.fillStyle = "rgba(0,0,0,.35)";
        ctx.fillRect(bx + g.ppm * 0.6, by + g.ppm * 0.8, bw, bh);       // shadow
        ctx.fillStyle = roofs[Math.floor(rnd() * roofs.length)];
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = "rgba(120,150,200,.12)"; ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        if (rnd() < 0.8 && bw > g.ppm * 3 && bh > g.ppm * 3) {          // water tank
          const tr = g.ppm * (0.7 + rnd() * 0.4);
          const tx = bx + tr + rnd() * (bw - 2 * tr), ty = by + tr + rnd() * (bh - 2 * tr);
          ctx.beginPath(); ctx.arc(tx, ty, tr, 0, Math.PI * 2);
          ctx.fillStyle = rnd() < 0.7 ? "#111827" : "#1d4ed8"; ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  paintRoad(ctx, p0, p1, crossings, horizontal, pass) {
    const g = this.g;
    const along = (t) => (horizontal ? [t, p0[1]] : [p0[0], t]);
    const a0 = horizontal ? p0[0] : p0[1], a1 = horizontal ? p1[0] : p1[1];
    const rect = (t0, t1, off0, off1, color) => {
      ctx.fillStyle = color;
      if (horizontal) ctx.fillRect(t0, p0[1] + off0, t1 - t0, off1 - off0);
      else ctx.fillRect(p0[0] + off0, t0, off1 - off0, t1 - t0);
    };
    if (pass === 0) { rect(a0, a1, -g.hr - 1.2, g.hr + 1.2, "#3a4558"); return; }   // kerb stones
    if (pass === 1) { rect(a0, a1, -g.hr, g.hr, "#242d3b"); return; }               // asphalt
    // segments between junction boxes get the markings
    const stops = [a0, ...crossings.flatMap((c) => [c - g.hr - g.zebra, c + g.hr + g.zebra]), a1];
    for (let i = 0; i + 1 < stops.length; i += 2) {
      const t0 = stops[i], t1 = stops[i + 1];
      if (t1 - t0 < 4) continue;
      // raised median with the yellow-and-black kerb paint of Indian roads
      rect(t0, t1, -g.median / 2, g.median / 2, "#3d4452");
      const dash = Math.max(3, g.ppm * 1.4);
      for (let t = t0, k = 0; t < t1; t += dash, k++) {
        const e = Math.min(t1, t + dash);
        const col = k % 2 ? "#151515" : "#d9a90a";
        rect(t, e, -g.median / 2, -g.median / 2 + Math.max(0.8, g.median * 0.22), col);
        rect(t, e, g.median / 2 - Math.max(0.8, g.median * 0.22), g.median / 2, col);
      }
      // dashed lane dividers and solid edge lines
      ctx.strokeStyle = "rgba(226,234,246,.42)";
      ctx.lineWidth = Math.max(0.8, g.ppm * 0.18);
      ctx.setLineDash([g.ppm * 2.2, g.ppm * 2.6]);
      for (const off of [-(g.median / 2 + g.laneW), g.median / 2 + g.laneW]) {
        ctx.beginPath();
        const [sx, sy] = along(t0), [ex, ey] = along(t1);
        if (horizontal) { ctx.moveTo(sx, sy + off); ctx.lineTo(ex, ey + off); }
        else { ctx.moveTo(sx + off, sy); ctx.lineTo(ex + off, ey); }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(226,234,246,.22)";
      for (const off of [-(g.hr - g.ppm * 0.35), g.hr - g.ppm * 0.35]) {
        ctx.beginPath();
        const [sx, sy] = along(t0), [ex, ey] = along(t1);
        if (horizontal) { ctx.moveTo(sx, sy + off); ctx.lineTo(ex, ey + off); }
        else { ctx.moveTo(sx + off, sy); ctx.lineTo(ex + off, ey); }
        ctx.stroke();
      }
    }
  }

  paintJunction(ctx, j) {
    const g = this.g;
    const [cx, cy] = g.centres[j];
    ctx.fillStyle = "#262f3e";
    ctx.fillRect(cx - g.hr, cy - g.hr, g.hr * 2, g.hr * 2);
    for (let a = 0; a < 4; a++) {
      const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
      // zebra crossing across the whole road, just outside the box
      ctx.fillStyle = "rgba(232,238,248,.72)";
      const bars = 7, span = 2 * g.hr, bw = span / (bars * 2 - 1);
      for (let k = 0; k < bars; k++) {
        const u = -g.hr + bw * (2 * k) + bw / 2;
        const d = g.hr + g.zebra / 2;
        const px = cx + v[0] * d + L[0] * u, py = cy + v[1] * d + L[1] * u;
        const w = v[0] ? g.zebra * 0.82 : bw, h = v[0] ? bw : g.zebra * 0.82;
        ctx.fillRect(px - w / 2, py - h / 2, w, h);
      }
      // stop line across the inbound half (the left of inbound traffic)
      ctx.fillStyle = "rgba(240,244,250,.85)";
      const d = g.stopD - g.ppm * 0.25, th = Math.max(1, g.ppm * 0.45);
      const u0 = g.median / 2, u1 = g.hr;
      const ax = cx + v[0] * d + L[0] * u0, ay = cy + v[1] * d + L[1] * u0;
      const bx = cx + v[0] * d + L[0] * u1, by = cy + v[1] * d + L[1] * u1;
      if (v[0]) ctx.fillRect(ax - th / 2, Math.min(ay, by), th, Math.abs(by - ay));
      else ctx.fillRect(Math.min(ax, bx), ay - th / 2, Math.abs(bx - ax), th);
    }
    // junction label on the block corner
    ctx.fillStyle = "rgba(143,162,196,.55)";
    ctx.font = `600 ${clamp(g.ppm * 2.1, 8, 12)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(this.ids[j], cx + g.hr + g.ppm * 3.4, cy - g.hr - g.ppm * 2.4);
  }

  // ------------------------------------------------------------------ per frame
  laneOf(spec, n) {
    if (spec.em) return 1;
    if (KERB_KINDS.has(spec.kind)) return 0;
    return n & 1;
  }

  /**
   * Draw the network at display time `vt`. `now` is performance.now() (beacon flashing),
   * `motion` false under prefers-reduced-motion. Returns per-kind counts for the legend.
   */
  draw(vt, now, motion) {
    const g = this.g;
    if (!g || !this.built) return this.stats;
    const ctx = this.ctx;
    const model = this.model;
    const side = model.sides[this.sideName];
    const kinds = model.kinds;
    const nv = model.nv;
    const dpr = g.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!side) return this.stats;

    const disp = side.display(vt);
    const lamps = side.lampsAt(vt);
    const counts = new Array(kinds.length).fill(0);
    let queued = 0, moving = 0;

    // smoothing budget: how far a queued vehicle may creep forward this frame
    let dtSim = this.lastVt === null ? 0 : vt - this.lastVt;
    if (dtSim < 0 || dtSim > 120) { this.qpos.clear(); dtSim = 0; }
    this.lastVt = vt;
    const creep = Math.max(0, dtSim) * model.hello.free_mps * g.s * 1.3 + 0.01;
    const nextPos = new Map();
    const flashOf = (id) => (motion ? ((now / 520 + id * 0.137) % 1) : null);
    const overflow = [];
    const em = [];                      // emergency vehicles drawn this frame (for tracking)

    // 1) stop-line lamps (a coloured bar on the stop line; heads are drawn last)
    const aspects = new Array(g.centres.length * 4);
    for (let j = 0; j < g.centres.length; j++) {
      const code = (lamps.charCodeAt(j) || 97) - 97;
      const phase = Math.floor(code / 3), state = code % 3;
      const greens = this.greens[phase] || new Set();
      for (let a = 0; a < 4; a++) {
        aspects[j * 4 + a] = state === 2 || !greens.has(a) ? "stop" : state === 0 ? "go" : "amber";
      }
    }
    for (let ai = 0; ai < aspects.length; ai++) this.stopBar(ctx, ai, aspects[ai]);

    // 2) queues, then the vehicles still driving towards them
    const cursorsOf = [];
    for (let ai = 0; ai < disp.queues.length; ai++) {
      const q = disp.queues[ai];
      const j = ai >> 2, a = ai & 3;
      const [cx, cy] = g.centres[j];
      const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
      const ang = Math.atan2(tin[1], tin[0]);
      const room = g.room[ai];
      const target = [[0, 0], [0, 0]];
      const shown = [[0, 0], [0, 0]];
      let drawn = 0, far = 0;
      for (let i = 0; i < q.codes.length; i++) {
        const code = q.codes[i];
        const spec = kinds[Math.floor(code / nv)] || kinds[0];
        const abs = q.abs0 + i;
        const lane = this.laneOf(spec, abs);
        const two = TWO_WHEELERS.has(spec.kind);
        const sub = (abs >> 1) & 1;
        const len = spec.len * g.ppm, gap = (two ? 0.45 : 0.9) * g.ppm;
        const tb = two ? target[lane][sub] : Math.max(target[lane][0], target[lane][1]);
        const key = ai * 1048576 + (abs & 1048575);
        const prev = this.qpos.get(key);
        let b = prev === undefined ? tb : Math.max(tb, prev - creep);
        b = Math.max(b, two ? shown[lane][sub] : Math.max(shown[lane][0], shown[lane][1]));
        if (two) target[lane][sub] = tb + len + gap; else target[lane][0] = target[lane][1] = tb + len + gap;
        if (b + len > room) {                                   // does not fit on screen
          if (two) shown[lane][sub] = Infinity; else shown[lane][0] = shown[lane][1] = Infinity;
          continue;
        }
        if (two) shown[lane][sub] = b + len + gap; else shown[lane][0] = shown[lane][1] = b + len + gap;
        nextPos.set(key, b);
        const u = this.laneU(lane) + (two ? (sub ? -1 : 1) * g.laneW * 0.24 : 0);
        const d = g.stopD + b + len / 2;
        const id = q.ids[i] >= 0 ? q.ids[i] : abs;
        const x = cx + v[0] * d + L[0] * u, y = cy + v[1] * d + L[1] * u, fl = spec.em ? flashOf(id) : null;
        drawVehicle(ctx, this.sprites, spec, code % nv, x, y, ang, fl, dpr);
        if (spec.em) em.push({ slot: "queue", ai, id: q.ids[i] >= 0 ? q.ids[i] : null, kind: spec.code,
                               x, y, ang, len, spec, variant: code % nv, flash: fl });
        counts[spec.code] += 1;
        drawn += 1;
        far = Math.max(far, b + len);
      }
      queued += q.total;
      if (q.total > drawn) overflow.push([ai, q.total - drawn, Math.min(far, room)]);
      cursorsOf.push(shown);
    }

    for (let ai = 0; ai < disp.movers.length; ai++) {
      const list = disp.movers[ai];
      if (!list.length) continue;
      const q = disp.queues[ai];
      const shown = cursorsOf[ai];
      const j = ai >> 2, a = ai & 3;
      const [cx, cy] = g.centres[j];
      const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
      const ang = Math.atan2(tin[1], tin[0]);
      for (let r = 0; r < list.length; r++) {
        const [, id, kind, , t0] = list[r];
        const spec = kinds[kind] || kinds[0];
        const abs = q.abs0 + q.total + r;
        const lane = this.laneOf(spec, abs);
        const two = TWO_WHEELERS.has(spec.kind);
        const sub = (abs >> 1) & 1;
        const len = spec.len * g.ppm, gap = (two ? 0.45 : 0.9) * g.ppm;
        const p = clamp((vt - t0) / model.travelOf[kind], 0, 1);
        let b = (1 - p) * g.linkLen;
        b = Math.max(b, two ? shown[lane][sub] : Math.max(shown[lane][0], shown[lane][1]));
        if (!(b <= g.linkLen)) continue;                       // the link is full on screen
        if (two) shown[lane][sub] = b + len + gap; else shown[lane][0] = shown[lane][1] = b + len + gap;
        const u = this.laneU(lane) + (two ? (sub ? -1 : 1) * g.laneW * 0.24 : 0);
        const d = g.stopD + b + len / 2;
        const x = cx + v[0] * d + L[0] * u, y = cy + v[1] * d + L[1] * u, fl = spec.em ? flashOf(id) : null;
        drawVehicle(ctx, this.sprites, spec, id % nv, x, y, ang, fl, dpr);
        if (spec.em) em.push({ slot: "link", ai, id, kind: spec.code, x, y, ang, len, spec, variant: id % nv, flash: fl });
        counts[spec.code] += 1;
        moving += 1;
      }
    }

    // 3) vehicles crossing a junction this second (stop line -> exit of the box)
    const bySrc = new Map();
    for (const c of disp.crossing) {
      if (!bySrc.has(c[2])) bySrc.set(c[2], []);
      bySrc.get(c[2]).push(c);
    }
    for (const [src, list] of bySrc) {
      list.sort((p, q) => q[4] - p[4]);                        // most recent departure first
      for (let k = 0; k < list.length; k++) {
        const [id, kind, , dst, d] = list[k];
        const spec = kinds[kind] || kinds[0];
        const absIn = disp.queues[src].abs0 - 1 - k;
        let outArm, absOut;
        if (dst >= 0) {
          outArm = ((dst & 3) + 2) & 3;
          absOut = disp.queues[dst].abs0 + disp.queues[dst].total + disp.movers[dst].length;
        } else {
          outArm = -1 - dst;
          absOut = id;
        }
        const fl = flashOf(id);
        const at = this.drawCrossing(ctx, spec, id, src, outArm, absIn, absOut, clamp((vt - d) / model.stepS, 0, 1), fl);
        if (spec.em) em.push({ slot: "cross", ai: src, id, kind: spec.code, x: at[0], y: at[1], ang: at[2],
                               len: spec.len * g.ppm, spec, variant: id % nv, flash: fl });
        counts[spec.code] += 1;
        moving += 1;
      }
    }

    // 4) vehicles leaving the grid
    for (const [id, kind, src, dir, t] of disp.exiting) {
      const spec = kinds[kind] || kinds[0];
      const j = src >> 2;
      const [cx, cy] = g.centres[j];
      const v = AP[dir], L = leftOf(v);
      const len = spec.len * g.ppm;
      const along = g.hr + len / 2 + (vt - t) * model.hello.free_mps * spec.sf * g.s;
      if (along - len > g.stubLen + 8) continue;
      const lane = this.laneOf(spec, id);
      const u = this.laneU(lane);
      const x = cx + v[0] * along + L[0] * u, y = cy + v[1] * along + L[1] * u, ang = Math.atan2(v[1], v[0]);
      const fl = spec.em ? flashOf(id) : null;
      drawVehicle(ctx, this.sprites, spec, id % nv, x, y, ang, fl, dpr);
      if (spec.em) em.push({ slot: "exit", ai: src, id, kind: spec.code, x, y, ang, len, spec, variant: id % nv, flash: fl });
      counts[spec.code] += 1;
      moving += 1;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 5) signal heads, pre-emption rings, overflow badges
    for (let ai = 0; ai < aspects.length; ai++) this.signalHead(ctx, ai, aspects[ai]);
    for (const j of side.pr || []) this.preemptRing(ctx, j, now, motion);
    for (const [ai, n, far] of overflow) this.badge(ctx, ai, n, far);

    // 6) the tracked emergency vehicles: focus, route ahead and trail on this layer ...
    this.overflowAt = new Map(overflow.map(([ai, n, far]) => [ai, [n, far]]));
    const labels = this.drawTracking(ctx, now, motion, em);

    // 7) ... and on the top layer the vehicle itself again (so no badge, lamp or edge fade
    //    hides it), its halo and its label
    const octx = this.ov.getContext("2d");
    if (this.ovUsed) {
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, this.ov.width, this.ov.height);
      this.ovUsed = false;
    }
    if (labels.length) {
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the signal each one waits at (or drives to), above the dimming and ringed
      const heads = new Set();
      for (const { p } of labels) {
        const ai = p.t.ai;
        if ((p.t.where === "queued" || p.t.where === "driving") && ai >= 0 && !heads.has(ai) && aspects[ai]) {
          heads.add(ai);
          this.signalHead(octx, ai, aspects[ai]);
          this.headRing(octx, ai, aspects[ai], now, motion);
        }
      }
      for (const { p } of labels) {
        const e = p.e;
        if (p.slot !== "hidden" && e.spec) drawVehicle(octx, this.sprites, e.spec, e.variant, e.x, e.y, e.ang, e.flash, dpr);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);            // drawVehicle leaves its own transform
        this.halo(octx, p, now, motion);
      }
      for (const l of labels) if (!l.main) this.trackTag(octx, l);
      for (const l of labels) if (l.main) this.trackLabel(octx, l);
      this.ovUsed = true;
    }
    if (this.marks.size) {
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [id, m] of this.marks) {
        if (now - m.at >= THROUGH_MS) { this.marks.delete(id); continue; }
        this.throughMark(octx, m, now);
      }
      this.ovUsed = true;
    }

    this.qpos = nextPos;
    const emergency = [];
    kinds.forEach((k, i) => { if (k.em && counts[i]) emergency.push(k.kind); });
    this.stats = { counts, emergency, queued, moving };
    return this.stats;
  }

  // ------------------------------------------------------------------ emergency tracking
  /**
   * Find this frame's drawing of every vehicle the tracker follows, then dim the map around
   * them (focus) and draw each one's route ahead and trail. Returns one label per vehicle
   * ({p: where it is, text, color}); draw() puts the vehicles, halos and labels on top.
   */
  drawTracking(ctx, now, motion, em) {
    const live = this.tracks.filter((t) => t.where === "queued" || t.where === "driving" ||
                                           (t.where === "through" && em.some((e) => e.id === t.id)));
    // through and no longer drawn: leave a "Through" marker where it was last seen
    for (const t of this.tracks) {
      if (t.where !== "through" || live.includes(t) || this.marks.has(t.id)) continue;
      const last = this.lastAt.get(t.id);
      if (last && last.track === t) this.marks.set(t.id, { ...last, at: now });
      this.lastAt.delete(t.id);
    }
    for (const id of [...this.marks.keys()]) {
      if (!this.tracks.some((t) => t.id === id && t.where === "through")) this.marks.delete(id);   // new run
    }
    if (!live.length) {
      this.tracked = [];
      if (this.trails.size) this.trails.clear();
      return [];
    }
    const used = new Set();
    const placed = [];
    const take = (t, e, slot = e.slot) => {
      used.add(t.id);
      placed.push({ t, x: e.x, y: e.y, ang: e.ang, len: e.len, slot, e });
    };
    // drawn with a known vehicle id: on a link, crossing, leaving, or next to leave a queue
    for (const e of em) {
      if (e.id === null) continue;
      const t = live.find((x) => x.id === e.id && !used.has(x.id));
      if (t) { take(t, e); e.taken = true; }
    }
    // queued: the k-th emergency vehicle drawn in a queue is the k-th one the tracker has there
    for (const e of em) {
      if (e.taken) continue;
      const here = live.filter((t) => !used.has(t.id) && t.where === "queued" && t.ai === e.ai)
                       .sort((a, b) => a.pos - b.pos);
      const t = here[0] || live.find((x) => !used.has(x.id) && x.trip.kindCode === e.kind && x.where !== "through");
      if (t) take(t, e);
    }
    // in the grid but not drawn: waiting too far back in a long queue, or driving onto a link
    // whose visible part is already full of queued vehicles. Mark it at that queue's "+n"
    // badge, or where its link comes into view, so it is never lost from sight.
    for (const t of live) {
      if (used.has(t.id) || (t.where !== "queued" && t.where !== "driving") || t.ai < 0) continue;
      const of = this.overflowAt.get(t.ai);
      if (of) {
        const b = this.badgeXY(ctx, t.ai, of[0], of[1]);
        take(t, { x: b.x, y: b.y, ang: b.ang, len: Math.max(b.tw, b.th) }, "hidden");
      } else {
        take(t, this.linkEntry(t.ai), "hidden");
      }
    }
    this.tracked = placed;
    for (const p of placed) {
      if (p.slot !== "hidden") this.lastAt.set(p.t.id, { x: p.x, y: p.y, ang: p.ang, track: p.t });
    }
    if (!placed.length) return [];

    if (this.focus) this.dimAround(ctx, placed);
    for (const p of placed) if (p.slot !== "hidden" && p.t.where !== "through") this.routeAhead(ctx, p, now, motion);
    if (motion) this.drawTrails(ctx, placed, now);        // no trails under "reduce motion"
    else if (this.trails.size) this.trails.clear();
    const labels = [];
    for (const p of placed) {
      let st = p.slot === "exit" ? "through" : (p.slot === "link" || p.slot === "cross") ? "moving" : p.t.status();
      if (p.slot === "queue" && st === "through") st = "moving";
      const text = this.statusText ? this.statusText(p.t, p.slot, st) : `${p.t.trip.label} · ${st}`;
      const main = !this.selectedKey || placed.length === 1 || p.t.trip.key === this.selectedKey;
      labels.push({ p, text, main, n: this.order.indexOf(p.t.trip.key) + 1, color: STATUS_COLOR[st] || STATUS_COLOR.pending });
    }
    return labels;
  }

  /** Darken everything but a soft circle around each tracked vehicle. */
  dimAround(ctx, placed) {
    const g = this.g;
    const c = this.dimCanvas || (this.dimCanvas = document.createElement("canvas"));
    if (c.width !== this.canvas.width || c.height !== this.canvas.height) {
      c.width = this.canvas.width;
      c.height = this.canvas.height;
    }
    const d = c.getContext("2d");
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.globalCompositeOperation = "source-over";
    d.clearRect(0, 0, c.width, c.height);
    d.fillStyle = TRACK.dim;
    d.fillRect(0, 0, c.width, c.height);
    d.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    d.globalCompositeOperation = "destination-out";
    const R = Math.max(g.S * 0.42, 40);
    const hole = (x, y, r) => {
      const grad = d.createRadialGradient(x, y, r * 0.45, x, y, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      d.fillStyle = grad;
      d.beginPath(); d.arc(x, y, r, 0, Math.PI * 2); d.fill();
    };
    for (const p of placed) {
      hole(p.x, p.y, R);
      const t = p.t, next = t.where !== "through" ? t.trip.route[Math.max(0, t.leg)] : undefined;
      if (next !== undefined) {
        const [cx, cy] = g.centres[next >> 2];
        hole(cx, cy, R * 0.85);
      }
    }
    d.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(c, 0, 0);
    ctx.restore();
  }

  /** The way ahead: a marching dashed line along its lane to the edge of the grid, with a
   *  ring on the stop line of every junction it still has to cross. */
  routeAhead(ctx, p, now, motion) {
    const g = this.g, t = p.t, route = t.trip.route;
    if (!route.length) return;
    const a0 = route[0] & 3;                          // a straight corridor: one arrival side
    const v = AP[a0], dir = [-v[0], -v[1]];
    const u = this.laneU(1);
    const lead = p.len * 0.55;
    const x0 = p.x + dir[0] * lead, y0 = p.y + dir[1] * lead;
    const reach = dir[0] > 0 ? (g.W - x0) : dir[0] < 0 ? x0 : dir[1] > 0 ? (g.H - y0) : y0;
    if (reach <= 2) return;
    const x1 = x0 + dir[0] * reach, y1 = y0 + dir[1] * reach;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, g.ppm * 0.75);
    ctx.setLineDash([g.ppm * 2.4, g.ppm * 1.9]);
    ctx.lineDashOffset = motion ? -((now / 45) % (g.ppm * 43)) : 0;
    ctx.strokeStyle = TRACK.route;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.setLineDash([]);
    for (let k = Math.max(0, t.leg); k < route.length; k++) {
      const ai = route[k], [cx, cy] = g.centres[ai >> 2];
      const vv = AP[ai & 3], LL = leftOf([-vv[0], -vv[1]]);
      const px = cx + vv[0] * g.stopD + LL[0] * u, py = cy + vv[1] * g.stopD + LL[1] * u;
      if ((px - p.x) * dir[0] + (py - p.y) * dir[1] < -1) continue;     // already behind it
      const r = Math.max(4, g.ppm * 1.35);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(8,12,22,.9)"; ctx.fill();
      ctx.lineWidth = Math.max(1.5, g.ppm * 0.45); ctx.strokeStyle = TRACK.halo; ctx.stroke();
    }
    ctx.restore();
  }

  /** Where each tracked vehicle has just been: a short trail that fades out. */
  drawTrails(ctx, placed, now) {
    const g = this.g;
    const seen = new Set();
    ctx.save();
    ctx.lineCap = "round";
    for (const p of placed) {
      if (p.slot === "hidden") continue;
      seen.add(p.t.id);
      let tr = this.trails.get(p.t.id);
      if (!tr) { tr = []; this.trails.set(p.t.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1.2) tr.push({ x: p.x, y: p.y, at: now });
      while (tr.length && now - tr[0].at > TRAIL_MS) tr.shift();
      for (let i = 1; i < tr.length; i++) {
        const a = Math.max(0, 1 - (now - tr[i].at) / TRAIL_MS);
        ctx.strokeStyle = `rgba(255,61,110,${(0.6 * a).toFixed(3)})`;
        ctx.lineWidth = Math.max(2, g.ppm * 1.3) * (0.35 + 0.65 * a);
        ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke();
      }
    }
    ctx.restore();
    for (const id of [...this.trails.keys()]) if (!seen.has(id)) this.trails.delete(id);
  }

  /** A pulsing double ring around the vehicle (dashed when it is only marked at a badge). */
  halo(ctx, p, now, motion) {
    const g = this.g;
    const pulse = motion ? 0.5 + 0.5 * Math.sin(now / 210 + p.t.id) : 0.6;
    const r = Math.max(p.len * 0.62, g.ppm * 3.3, 9) + pulse * Math.max(1.5, g.ppm * 0.8);
    ctx.save();
    if (p.slot === "hidden") ctx.setLineDash([4, 3]);
    ctx.lineWidth = Math.max(1.5, g.ppm * 0.5);
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = Math.max(2.5, g.ppm * 0.85);
    ctx.strokeStyle = TRACK.halo;
    ctx.globalAlpha = 0.55 + 0.45 * pulse;
    ctx.shadowColor = TRACK.halo;
    ctx.shadowBlur = (6 + 10 * pulse) * g.dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + Math.max(2.5, g.ppm * 0.9), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /** The label beside a tracked vehicle: status dot + text, on the far side of its lane,
   *  joined to it by a thin line. */
  trackLabel(ctx, { p, text, color }) {
    const g = this.g;
    const fs = clamp(g.ppm * 3.05, 13.5, 18);
    ctx.font = `750 ${fs}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    const pad = fs * 0.62, dot = fs * 0.56, gap = fs * 0.45;
    const tw = ctx.measureText(text).width + pad * 2 + dot + gap, th = fs * 1.75;
    const route = p.t.trip.route;
    const v = AP[route.length ? route[0] & 3 : 3], L = leftOf([-v[0], -v[1]]);
    const off = Math.max(p.len * 0.62, g.ppm * 3.3, 9) + th * 0.85 + g.ppm * 1.6;
    const x = clamp(p.x + L[0] * off, tw / 2 + 4, g.W - tw / 2 - 4);
    const y = clamp(p.y + L[1] * off, th / 2 + 4, g.H - th / 2 - 4);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = "rgba(7,11,20,.95)";
    roundRect(ctx, x - tw / 2, y - th / 2, tw, th, th / 2);
    ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x - tw / 2 + pad + dot / 2, y, dot / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f4f7ff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, x - tw / 2 + pad + dot + gap, y + 0.5);
    ctx.restore();
  }

  /** Another tracked vehicle's tag: its number in the panel's tabs, in its status colour. */
  trackTag(ctx, { p, n, color }) {
    const g = this.g;
    const r = clamp(g.ppm * 1.95, 9, 13);
    const off = Math.max(p.len * 0.62, g.ppm * 3.3, 9) * 0.78;
    const x = clamp(p.x + off, r + 2, g.W - r - 2), y = clamp(p.y - off, r + 2, g.H - r - 2);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(7,11,20,.94)"; ctx.fill();
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = "#f4f7ff";
    ctx.font = `800 ${Math.round(r * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(n > 0 ? String(n) : "•", x, y + 0.5);
    ctx.restore();
  }

  /** A ring around the signal head of approach `ai`, in the colour it shows (pulsing on red). */
  headRing(ctx, ai, aspect, now, motion) {
    const g = this.g;
    const j = ai >> 2, a = ai & 3;
    const [cx, cy] = g.centres[j];
    const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
    const r = clamp(g.ppm * 0.62, 1.6, 4.2), step = r * 2.35;
    const u = g.hr + r * 2.1, d0 = g.stopD + r * 1.3;
    const hx = cx + v[0] * (d0 + step) + L[0] * u, hy = cy + v[1] * (d0 + step) + L[1] * u;
    const hl = step * 2 + r * 2.6, hw = r * 2.7;
    const pad = Math.max(4, g.ppm * 0.9);
    const w = (v[0] ? hl : hw) + pad * 2, h = (v[0] ? hw : hl) + pad * 2;
    const pulse = motion && aspect !== "go" ? 0.5 + 0.5 * Math.sin(now / 180) : 1;
    ctx.save();
    ctx.strokeStyle = COLORS[aspect];
    ctx.lineWidth = Math.max(2, g.ppm * 0.55);
    ctx.shadowColor = COLORS[aspect];
    ctx.shadowBlur = (4 + 8 * pulse) * g.dpr;
    ctx.globalAlpha = 0.6 + 0.4 * pulse;
    roundRect(ctx, hx - w / 2, hy - h / 2, w, h, Math.min(w, h) / 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Where a tracked vehicle left the grid: "✓ Through in m:ss" for THROUGH_MS, then gone. */
  throughMark(ctx, m, now) {
    const g = this.g, t = m.track;
    const left = THROUGH_MS - (now - m.at);
    const alpha = clamp(left / 1000, 0, 1);              // fades out in the last second
    const fs = clamp(g.ppm * 3.05, 13.5, 18);
    const text = t.clearance === null ? `${t.trip.label} · through` : `${t.trip.label} · Through in ${fmtClock(t.clearance)}`;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `750 ${fs}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    const r = fs * 0.62, pad = fs * 0.62, gap = fs * 0.45;
    const tw = ctx.measureText(text).width + pad * 2 + r * 2 + gap, th = fs * 1.75;
    // inside the map, just before the edge it left by
    const m2 = th * 0.7 + 6;
    const x = clamp(m.x - Math.cos(m.ang) * th, tw / 2 + 6, g.W - tw / 2 - 6);
    const y = clamp(m.y - Math.sin(m.ang) * th, m2, g.H - m2);
    ctx.fillStyle = "rgba(7,11,20,.95)";
    roundRect(ctx, x - tw / 2, y - th / 2, tw, th, th / 2);
    ctx.fill();
    ctx.strokeStyle = STATUS_COLOR.through; ctx.lineWidth = 2.2; ctx.stroke();
    const ccx = x - tw / 2 + pad + r;
    ctx.fillStyle = STATUS_COLOR.through;
    ctx.beginPath(); ctx.arc(ccx, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#04281b"; ctx.lineWidth = Math.max(1.6, fs * 0.13); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(ccx - r * 0.45, y + r * 0.02); ctx.lineTo(ccx - r * 0.1, y + r * 0.36); ctx.lineTo(ccx + r * 0.48, y - r * 0.34); ctx.stroke();
    ctx.fillStyle = "#f4f7ff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(text, ccx + r + gap, y + 0.5);
    ctx.restore();
  }

  drawCrossing(ctx, spec, id, src, outArm, absIn, absOut, c, flash) {
    const g = this.g;
    const j = src >> 2, aIn = src & 3;
    const [cx, cy] = g.centres[j];
    const vIn = AP[aIn], tin = [-vIn[0], -vIn[1]], Lin = leftOf(tin);
    const vOut = AP[outArm], Lout = leftOf(vOut);
    const len = spec.len * g.ppm;
    const two = TWO_WHEELERS.has(spec.kind);
    const uIn = this.laneU(this.laneOf(spec, absIn)) + (two ? (((absIn >> 1) & 1) ? -1 : 1) * g.laneW * 0.24 : 0);
    const uOut = this.laneU(this.laneOf(spec, absOut));
    const dIn = g.stopD + len / 2, dOut = g.hr + len / 2;
    const P0 = [cx + vIn[0] * dIn + Lin[0] * uIn, cy + vIn[1] * dIn + Lin[1] * uIn];
    const P1 = [cx + vOut[0] * dOut + Lout[0] * uOut, cy + vOut[1] * dOut + Lout[1] * uOut];
    let x, y, ang;
    if (vOut[0] === tin[0] && vOut[1] === tin[1]) {          // straight on
      x = P0[0] + (P1[0] - P0[0]) * c; y = P0[1] + (P1[1] - P0[1]) * c;
      ang = Math.atan2(tin[1], tin[0]);
    } else {                                                  // a turn: quadratic curve
      const Q = tin[0] !== 0 ? [P1[0], P0[1]] : [P0[0], P1[1]];
      const m = 1 - c;
      x = m * m * P0[0] + 2 * m * c * Q[0] + c * c * P1[0];
      y = m * m * P0[1] + 2 * m * c * Q[1] + c * c * P1[1];
      const dx = 2 * m * (Q[0] - P0[0]) + 2 * c * (P1[0] - Q[0]);
      const dy = 2 * m * (Q[1] - P0[1]) + 2 * c * (P1[1] - Q[1]);
      ang = Math.atan2(dy, dx);
    }
    drawVehicle(ctx, this.sprites, spec, id % this.model.nv, x, y, ang, spec.em ? flash : null, g.dpr);
    return [x, y, ang];
  }

  stopBar(ctx, ai, aspect) {
    const g = this.g;
    const j = ai >> 2, a = ai & 3;
    const [cx, cy] = g.centres[j];
    const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
    const d = g.stopD - g.ppm * 0.25, th = Math.max(1.4, g.ppm * 0.55);
    const u0 = g.median / 2 + 0.5, u1 = g.hr - 0.5;
    const ax = cx + v[0] * d + L[0] * u0, ay = cy + v[1] * d + L[1] * u0;
    const bx = cx + v[0] * d + L[0] * u1, by = cy + v[1] * d + L[1] * u1;
    ctx.fillStyle = COLORS[aspect];
    ctx.globalAlpha = aspect === "stop" ? 0.75 : 0.95;
    if (v[0]) ctx.fillRect(ax - th / 2, Math.min(ay, by), th, Math.abs(by - ay));
    else ctx.fillRect(Math.min(ax, bx), ay - th / 2, Math.abs(bx - ax), th);
    ctx.globalAlpha = 1;
  }

  signalHead(ctx, ai, aspect) {
    const g = this.g;
    const j = ai >> 2, a = ai & 3;
    const [cx, cy] = g.centres[j];
    const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
    const r = clamp(g.ppm * 0.62, 1.6, 4.2);
    const step = r * 2.35;
    const u = g.hr + r * 2.1;
    const d0 = g.stopD + r * 1.3;
    const order = ["stop", "amber", "go"];
    // housing
    const hx = cx + v[0] * (d0 + step) + L[0] * u, hy = cy + v[1] * (d0 + step) + L[1] * u;
    const hl = step * 2 + r * 2.6, hw = r * 2.7;
    ctx.fillStyle = "#060a12"; ctx.strokeStyle = "#3a4b6a"; ctx.lineWidth = 1;
    roundRect(ctx, hx - (v[0] ? hl : hw) / 2, hy - (v[0] ? hw : hl) / 2, v[0] ? hl : hw, v[0] ? hw : hl, r);
    ctx.fill(); ctx.stroke();
    for (let k = 0; k < 3; k++) {
      const d = d0 + k * step;
      const x = cx + v[0] * d + L[0] * u, y = cy + v[1] * d + L[1] * u;
      const on = order[k] === aspect;
      if (on) {
        const glow = this.sprites.glowSprite(COLORS[aspect], r * 3.2);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.85;
        ctx.drawImage(glow, x - glow.r, y - glow.r, glow.r * 2, glow.r * 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = on ? COLORS[aspect] : "rgba(120,140,175,.2)";
      ctx.fill();
    }
  }

  preemptRing(ctx, j, now, motion) {
    const g = this.g;
    const [cx, cy] = g.centres[j];
    const pulse = motion ? 0.5 + 0.5 * Math.sin(now / 160) : 1;
    const pad = g.ppm * 1.4 + 2;
    ctx.lineWidth = Math.max(2, g.ppm * 0.6);
    ctx.strokeStyle = motion && Math.floor(now / 320) % 2 ? "#3d7bff" : "#ff3355";
    ctx.globalAlpha = 0.55 + 0.45 * pulse;
    roundRect(ctx, cx - g.hr - pad, cy - g.hr - pad, (g.hr + pad) * 2, (g.hr + pad) * 2, g.ppm * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Where the link leading to approach `ai` comes into view (its far end, inner lane). */
  linkEntry(ai) {
    const g = this.g;
    const [cx, cy] = g.centres[ai >> 2];
    const v = AP[ai & 3], tin = [-v[0], -v[1]], L = leftOf(tin), u = this.laneU(1);
    const len = 4.5 * g.ppm, d = g.stopD + Math.max(len, g.room[ai] - len * 0.6);
    const m = (g.fade || 0) * 0.6;
    return { x: clamp(cx + v[0] * d + L[0] * u, m + 6, g.W - m - 6), y: clamp(cy + v[1] * d + L[1] * u, m + 6, g.H - m - 6),
             ang: Math.atan2(tin[1], tin[0]), len };
  }

  /** Where the "+n" badge of approach `ai` goes (CSS px), and its size. */
  badgeXY(ctx, ai, n, far) {
    const g = this.g;
    const j = ai >> 2, a = ai & 3;
    const [cx, cy] = g.centres[j];
    const v = AP[a], tin = [-v[0], -v[1]], L = leftOf(tin);
    const text = "+" + n;
    const fs = clamp(g.ppm * 2.2, 9, 13);
    ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    const tw = ctx.measureText(text).width + fs * 0.9, th = fs * 1.45;
    let d = g.stopD + far + th * 0.9;
    d = Math.min(d, g.stopD + g.room[ai] - th * 0.3);
    const u = this.laneU(1) + g.laneW * 0.5;
    const m = (g.fade || 0) * 0.6;                       // keep it on screen, clear of the fade
    const x = clamp(cx + v[0] * d + L[0] * u, m + tw / 2 + 2, g.W - m - tw / 2 - 2);
    const y = clamp(cy + v[1] * d + L[1] * u, m + th / 2 + 2, g.H - m - th / 2 - 2);
    return { x, y, tw, th, fs, text, ang: Math.atan2(tin[1], tin[0]) };
  }

  badge(ctx, ai, n, far) {
    const { x, y, tw, th, fs, text } = this.badgeXY(ctx, ai, n, far);
    ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = n > 20 ? "rgba(255,77,94,.95)" : n > 8 ? "rgba(255,176,32,.95)" : "rgba(20,30,50,.92)";
    roundRect(ctx, x - tw / 2, y - th / 2, tw, th, th / 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = n > 8 ? "#111" : "#e8eefc";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
  }
}
