// Entry point: wires the model, the transport, the two network views, the chart, the UI and
// the emergency tracker, and runs the single requestAnimationFrame loop that draws everything.

import { Model, SimClock, PROTOCOL_VERSION } from "./model.js";
import { Transport } from "./transport.js";
import { NetworkView } from "./renderer.js";
import { LineChart } from "./charts.js";
import { UI } from "./ui.js";

const model = new Model();
const clock = new SimClock();
const reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

const stages = { rl: document.getElementById("stageRL"), ft: document.getElementById("stageFT") };
const views = {
  rl: new NetworkView(document.getElementById("netRL"), stages.rl, model, "rl"),
  ft: new NetworkView(document.getElementById("netFT"), stages.ft, model, "ft"),
};
const chart = new LineChart(document.getElementById("chart"));

let transport = null;
let lastKey = "";
const ui = new UI({
  command: (cmd) => (transport ? transport.send(cmd) : Promise.resolve({ ok: false, error: "not connected" })),
  chartMetric: (name) => chart.setMetric(name),
  focusChanged: () => { lastKey = ""; },          // redraw the maps with / without the dimming
});

// ---------------------------------------------------------------- build check
// The page embeds the build id it was served with; the server reports its own in `hello`.
// A different id means this tab (or the service-worker copy it came from) predates a
// redeploy: reload once to pick up the new page instead of running old code against it.
function checkBuild(hello) {
  const mine = document.documentElement.dataset.build || "";
  if (!mine || mine.startsWith("__") || !hello.build || hello.build === mine) return false;
  let tried = "";
  try { tried = sessionStorage.getItem("atsc-reloaded-for") || ""; } catch (e) { /* storage blocked */ }
  if (tried === hello.build) return false;               // already tried once: carry on
  try { sessionStorage.setItem("atsc-reloaded-for", hello.build); } catch (e) { /* ignore */ }
  location.reload();
  return true;
}

// ---------------------------------------------------------------- messages
let reloading = false;
function onMessage(msg) {
  if (reloading) return;
  if (msg.t === "hello" && msg.v !== PROTOCOL_VERSION) {
    // this copy of the page cannot read the server's messages: reload to the new version
    reloading = true;
    if (!checkBuild(msg)) ui.toast("This page is out of date - please reload it.");
    return;
  }
  const kind = model.apply(msg);
  if (!kind) return;
  const now = performance.now();
  if (kind === "hello") {
    if (checkBuild(msg)) { reloading = true; return; }
    views.rl.setHello();
    views.ft.setHello();
    const aspect = views.rl.aspect();
    for (const stage of Object.values(stages)) stage.style.setProperty("--aspect", String(aspect));
    ui.setHello(model);
    measureChrome();
    resizeAll();
  }
  if (model.g.sp > 0) {
    // speed = decisions per tick: below 1 a frame still advances one decision at a time
    const dec = +model.hello.dec_s || 5, tick = (+model.hello.tick_ms || 200) / 1000;
    clock.nominal(model.g.sp * dec / tick, Math.max(1, model.g.sp) * dec);
  }
  clock.frame(model.bt, !!model.g.p, now, model.newEpisode);
  ui.update(model);
}

transport = new Transport({
  onMessage: (msg) => {
    try { onMessage(msg); } catch (e) { console.error("frame handling failed:", e); }
  },
  onStatus: (state, info) => ui.setStatus(state, info),
});

// ---------------------------------------------------------------- layout
let chartRev = -1;
let resizes = 0;
function resizeAll() {
  if (!model.hello) return;
  if (views.rl.resize()) resizes += 1;
  if (views.ft.resize()) resizes += 1;
  chart.resize();
  chartRev = -1;
}

// On a laptop the two maps are as big as the screen allows: from the top of the page down to
// the maps (header, controls, the maps' own headers) plus the bottom of their cards must fit
// on one screen; the tracker, the numbers and the chart are under them (styles.css, .stage).
// How tall everything above the maps is depends on how the controls wrap at this width, so
// measure it rather than guess: --chrome = viewport height the maps cannot use.
const root = document.documentElement;
const BELOW = 14;               // a little of the page under the maps stays in view
let chrome = -1;
function measureChrome() {
  const stage = [stages.rl, stages.ft].find((s) => s && s.getBoundingClientRect().height > 0);
  if (!stage) return;
  const s = stage.getBoundingClientRect();
  const card = stage.closest(".gridcard");
  const under = card ? Math.max(0, card.getBoundingClientRect().bottom - s.bottom) : 0;
  const value = Math.ceil(s.top + window.scrollY + under + BELOW);
  if (value > 0 && Math.abs(value - chrome) >= 2) {
    chrome = value;
    root.style.setProperty("--chrome", `${value}px`);
  }
}

if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => resizeAll());
  for (const stage of Object.values(stages)) ro.observe(stage);
  ro.observe(chart.canvas.parentElement);
  // everything above the maps whose height can change: wrapping controls, the notice, the
  // maps' headers
  const around = new ResizeObserver(() => measureChrome());
  for (const sel of [".top", "#toolbar", "#untrained", ".gridcard header"]) {
    for (const node of document.querySelectorAll(sel)) around.observe(node);
  }
}
window.addEventListener("resize", () => { measureChrome(); resizeAll(); });
measureChrome();

// ---------------------------------------------------------------- the frame loop
let last = performance.now();
let lastStats = views.rl.stats;
let lastStatsFT = views.ft.stats;
let dpr = window.devicePixelRatio || 1;
const frameMs = [];
const label = (track, slot, status) => ui.mapLabel(track, slot, status);
// where the map drew a tracked vehicle in the last frame (the panel follows the picture)
ui.shownAs = (track) => {
  const placed = views[track.side] && views[track.side].tracked.find((p) => p.t === track);
  return placed ? { slot: placed.slot, ai: placed.e && Number.isInteger(placed.e.ai) ? placed.e.ai : -1 } : null;
};
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  frameMs.push(now - last);
  if (frameMs.length > 240) frameMs.shift();
  last = now;
  if (!model.hello) return;
  try {
    if ((window.devicePixelRatio || 1) !== dpr) { dpr = window.devicePixelRatio || 1; resizeAll(); }
    const vt = clock.advance(dt);
    const motion = !reduceMotion.matches;
    // the emergency vehicles the tracker follows: highlighted on both maps
    const tracker = ui.tracker;
    const shown = tracker.selected(), order = tracker.trips.map((t) => t.key);
    views.rl.setTracking(tracker.tracksFor("rl"), ui.focus, label, shown && shown.key, order);
    views.ft.setTracking(tracker.tracksFor("ft"), ui.focus, label, shown && shown.key, order);
    // nothing moves while paused: redraw only when something changed, or while beacons flash,
    // junctions are pre-empted or a tracked vehicle's halo pulses
    const key = `${vt}|${model.rev}|${resizes}|${ui.focus}`;
    const animated = (motion && (views.rl.stats.emergency.length || views.ft.stats.emergency.length ||
                                 views.rl.tracked.length || views.ft.tracked.length ||
                                 tracker.active().length ||
                                 (model.sides.rl && model.sides.rl.pr.length) ||
                                 (model.sides.ft && model.sides.ft.pr.length))) ||
                     views.rl.busy() || views.ft.busy();       // a "Through" marker counts down
    if (key !== lastKey || animated) {
      lastKey = key;
      lastStats = views.rl.draw(vt, now, motion);
      lastStatsFT = views.ft.draw(vt, now, motion);
    }
    ui.frame(lastStats, lastStatsFT, model, now, vt);
    if (model.hRev !== chartRev) {
      chartRev = model.hRev;
      chart.draw(model.h);
    }
  } catch (e) {
    console.error("draw failed:", e);
  }
}
requestAnimationFrame(loop);
transport.start();

// ---------------------------------------------------------------- service worker
// Lets a returning visitor see the "waking up" screen instantly while a sleeping free
// instance boots, instead of a blank tab. Network-first, so it never serves stale code
// while the server answers.
if ("serviceWorker" in navigator && window.isSecureContext) {
  if (new URLSearchParams(location.search).has("nosw")) {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()), () => {});
  } else {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.info("service worker not registered:", e && e.message));
  }
}

// a small debugging / testing hook (read-only use)
window.__ATSC__ = {
  model, clock, views, chart, ui,
  get transport() { return transport; },
  get tracker() { return ui.tracker; },
  fps() {
    const recent = frameMs.slice(-120).filter((x) => x > 0);
    return recent.length ? 1000 / (recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
  },
  status() { return transport ? transport.state : "none"; },
};
