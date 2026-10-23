// The run-so-far chart (no library): RL Agent System vs Traditional Traffic System over the
// episode, for one measure at a time (waiting time or cars queued). The area between the two
// lines is shaded where the RL agents are ahead ("time saved by RL"); hovering shows the exact
// values at that moment.

const RL = "#34d399";
const TR = "#aab4c3";
const GRID = "#1f2a44";
const TICK = "#7f8ca5";

export const METRICS = {
  // indices inside each history point [e, rl wait, ft wait, rl queue, ft queue]
  wait: { rl: 1, ft: 2, unit: " s", digits: 1, label: "Average waiting time", gap: "time saved by RL" },
  queue: { rl: 3, ft: 4, unit: "", digits: 1, label: "Cars queued per junction", gap: "fewer cars waiting" },
};

function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function fmtMinutes(s) {
  const m = s / 60;
  if (m === 0) return "0";
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
}

export class LineChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = null;
    this.metric = "wait";
    this.points = [];
    this.hover = null;          // CSS x of the pointer, or null
    this.lastLabel = "";
    this.geo = null;
    const move = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = ev.clientX - r.left;
      this.draw(this.points);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", move);
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(this.points); });
  }

  setMetric(name) {
    if (!METRICS[name] || name === this.metric) return;
    this.metric = name;
    this.draw(this.points);
  }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
    if (this.size && this.size.w === w && this.size.h === h && this.size.dpr === dpr) return false;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.size = { w, h, dpr };
    return true;
  }

  draw(points) {
    this.points = points || [];
    if (!this.size) this.resize();
    const { w, h, dpr } = this.size;
    const ctx = this.ctx;
    const spec = METRICS[this.metric];
    const { rl, ft, unit, digits } = spec;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const font = "11px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.font = font;
    const x0 = 30, x1 = w - 56, yt = 10, yb = h - 22;
    if (x1 - x0 < 40 || yb - yt < 30) return;
    const pts = this.points;
    if (pts.length < 2) {
      ctx.fillStyle = TICK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("collecting data…", (x0 + x1) / 2, (yt + yb) / 2);
      return;
    }
    const e0 = pts[0][0], e1 = pts[pts.length - 1][0];
    let ymax = 0;
    for (const p of pts) ymax = Math.max(ymax, p[rl], p[ft]);
    const step = niceStep(Math.max(ymax, 1e-6) * 1.1, 4);
    const top = Math.max(step, Math.ceil((ymax * 1.08) / step) * step);
    const X = (e) => x0 + ((e - e0) / Math.max(1e-9, e1 - e0)) * (x1 - x0);
    const Y = (v) => yb - (v / top) * (yb - yt);

    // grid + y labels
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = 0; v <= top + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = TICK;
      ctx.fillText(v.toFixed(step < 1 ? 1 : 0), x0 - 6, y);
    }
    // x labels (minutes into the run): whole minutes, at most four gaps
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const span = Math.max(1, e1 - e0);
    let xs = 60;
    for (const m of [1, 2, 3, 5, 10, 15, 30]) {
      xs = m * 60;
      if (span / xs <= 4) break;
    }
    for (let e = Math.ceil(e0 / xs) * xs; e <= e1 + 1e-9; e += xs) {
      ctx.fillStyle = TICK;
      ctx.fillText(fmtMinutes(e), X(e), yb + 6);
    }

    // the gap between the lines: green where the RL agents are ahead, faint grey elsewhere
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ahead = a[ft] + b[ft] >= a[rl] + b[rl];
      ctx.fillStyle = ahead ? "rgba(52,211,153,.14)" : "rgba(170,180,195,.08)";
      ctx.beginPath();
      ctx.moveTo(X(a[0]), Y(a[ft])); ctx.lineTo(X(b[0]), Y(b[ft]));
      ctx.lineTo(X(b[0]), Y(b[rl])); ctx.lineTo(X(a[0]), Y(a[rl]));
      ctx.closePath(); ctx.fill();
    }
    const series = (idx, color, dash, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round";
      ctx.setLineDash(dash);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[idx])) : ctx.moveTo(X(p[0]), Y(p[idx]))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    series(ft, TR, [5, 4], 2);
    series(rl, RL, [], 2.5);

    // label the gap where it is widest (in the newer half of the run)
    let best = -1, bestGap = 0;
    for (let i = Math.floor(pts.length / 2); i < pts.length - 1; i++) {
      const gap = Y(pts[i][rl]) - Y(pts[i][ft]);
      if (gap > bestGap) { bestGap = gap; best = i; }
    }
    if (best >= 0 && bestGap > 22) {
      ctx.font = "600 10.5px Inter, ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#7ef0c4"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const gx = clamp(X(pts[best][0]), x0 + 50, x1 - 50);
      ctx.fillText(spec.gap, gx, (Y(pts[best][rl]) + Y(pts[best][ft])) / 2);
    }

    // end dots + values
    const last = pts[pts.length - 1];
    const ends = [[last[rl], RL, "#34d399"], [last[ft], TR, "#d5dbe5"]].sort((a, b) => b[0] - a[0]);
    let prevY = -1e9;
    ctx.font = "700 11.5px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const [v, color, ink] of ends) {
      const yDot = Y(v);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(X(last[0]), yDot, 3.5, 0, Math.PI * 2); ctx.fill();
      let y = yDot;
      if (y - prevY < 14) y = prevY + 14;
      prevY = y;
      ctx.fillStyle = ink;
      ctx.fillText(`${v.toFixed(digits)}${unit}`, X(last[0]) + 8, Math.min(yb, y));
    }

    // hover: crosshair, dots and the exact values at that moment
    if (this.hover !== null && this.hover >= x0 - 4 && this.hover <= x1 + 4) {
      const ex = e0 + ((clamp(this.hover, x0, x1) - x0) / (x1 - x0)) * (e1 - e0);
      let k = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - ex) < Math.abs(pts[k][0] - ex)) k = i;
      const p = pts[k], x = X(p[0]);
      ctx.strokeStyle = "#55627c"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yt); ctx.lineTo(x, yb); ctx.stroke(); ctx.setLineDash([]);
      for (const [v, color] of [[p[ft], TR], [p[rl], RL]]) {
        ctx.fillStyle = color; ctx.strokeStyle = "#0f1628"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, Y(v), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const lines = [`Minute ${(p[0] / 60).toFixed(p[0] % 60 ? 1 : 0)}`,
                     `RL Agent System  ${p[rl].toFixed(digits)}${unit}`,
                     `Traditional  ${p[ft].toFixed(digits)}${unit}`];
      ctx.font = "600 11.5px Inter, ui-sans-serif, system-ui, sans-serif";
      const bw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 30, bh = 58;
      const bx = x + 10 + bw < x1 ? x + 10 : x - 10 - bw;
      const by = Math.max(yt, Math.min(yb - bh, (Y(p[rl]) + Y(p[ft])) / 2 - bh / 2));
      ctx.fillStyle = "#0b1222"; ctx.strokeStyle = "#334160"; ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 8); ctx.fill(); ctx.stroke();
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#e6ebf3"; ctx.fillText(lines[0], bx + 10, by + 14);
      ctx.font = "11px Inter, ui-sans-serif, system-ui, sans-serif";
      [[lines[1], RL], [lines[2], TR]].forEach(([text, color], i) => {
        const y = by + 31 + i * 15;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(bx + 14, y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c9d2e3"; ctx.fillText(text, bx + 24, y);
      });
    }

    const label = `${spec.label} over the run so far: RL Agent System ${last[rl].toFixed(digits)}${unit}, ` +
                  `Traditional Traffic System ${last[ft].toFixed(digits)}${unit}`;
    if (label !== this.lastLabel) {
      this.canvas.setAttribute("aria-label", label);
      this.lastLabel = label;
    }
  }
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
