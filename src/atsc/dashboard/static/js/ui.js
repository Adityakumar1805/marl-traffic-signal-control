// Everything in the page that is not a canvas: the toolbar, the live result, the tiles, the
// emergency tracker panel, menus, dialogs, tips, the status pill, toasts and the "waking up"
// screen. Text is only written when it actually changed, so a 5 Hz frame stream causes almost
// no DOM work.

import { thumbnail } from "./sprites.js";
import { Tracker, fmtClock, ordinal } from "./tracker.js";

const $ = (id) => document.getElementById(id);

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
function setClass(el, name, on) {
  if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
}
function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function fmtNum(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : "–";
}
function fmtInt(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "–";
}
/** Replace an element's children with text and emphasised parts: ["a ", ["em", "25%"]]. */
function setRich(el, parts, key) {
  if (!el || el.dataset.rich === key) return;
  el.dataset.rich = key;
  el.replaceChildren(...parts.map((p) => {
    if (typeof p === "string") return document.createTextNode(p);
    const node = document.createElement(p[0]);
    node.textContent = p[1];
    if (p[2]) node.className = p[2];
    return node;
  }));
}

/** "1×", "0.5×". */
export function fmtSpeed(s) {
  return (Number.isInteger(s) ? String(s) : String(+s.toFixed(2))) + "×";
}
const SPEED_NAMES = ["very slow", "slow", "normal", "fast", "faster", "fastest"];
function speedName(speeds, i) {
  if (speeds.length === SPEED_NAMES.length) return SPEED_NAMES[i];
  const s = speeds[i];
  return s < 1 ? "slow" : s === 1 ? "normal" : "fast";
}
const TRAFFIC = { low: "Light", medium: "Normal", high: "Heavy", rush: "Rush hour" };
const trafficName = (name) => TRAFFIC[name] || (name ? name[0].toUpperCase() + name.slice(1) : "");
const ICON = { ambulance: "🚑", police: "🚓", fire: "🚒" };
const iconOf = (kind) => ICON[kind] || "🚨";

const CONN = {
  connecting: ["Connecting…", "off"],
  waking: ["Waking up the server…", "off"],
  reconnecting: ["Reconnecting…", "off"],
  live: ["Live", "live"],
  polling: ["Live · polling", "polling"],
  busy: ["Server full · retrying", "off"],
  hidden: ["Paused while the tab is hidden", "off"],
};
const STATUS_WORD = { moving: "Moving", waiting: "Waiting", stuck: "Not moving", through: "Through", pending: "Starting" };

export class UI {
  /**
   * @param {{command: (cmd: object) => Promise<{ok: boolean, error?: string}>,
   *          chartMetric: (name: string) => void, focusChanged: (on: boolean) => void}} handlers
   */
  constructor(handlers) {
    this.h = handlers;
    this.el = {};
    for (const id of ["playPause", "playText", "resetBtn", "trafficSeg", "speed", "speedTicks", "speedOut",
                      "emGroup", "emSend", "emCount", "emMenu", "bbEmMenu", "bbEmCount", "autoNote",
                      "moreBtn", "moreMenu", "stepBtn", "vehiclesBtn", "helpAuto", "gwRL", "gwFT", "ghRL", "ghFT",
                      "trkAhead",
                      "techBtn", "helpBtn", "presentBtn", "helpDlg", "vehiclesDlg", "techDlg", "timelineDlg",
                      "legendList", "liveState", "statusText", "minuteText", "epBar",
                      "untrained", "trafficPill", "resHead", "wRL", "wFT", "resNote", "qChip", "qRL", "qFT",
                      "qBarRL", "qBarFT", "tChip", "tRL", "tFT", "emTile", "eChip", "eHead", "eText", "tiles",
                      "tracker", "trkIco", "trkTitle", "trkMeta", "trkVerdict", "trkPick", "trkFocus",
                      "trkTimeline", "trkClose", "laneRL", "laneFT", "tlTitle", "tlRL", "tlFT", "chWait",
                      "chQueue", "chCaption", "cardRL", "cardFT",
                      "bbPlay", "bbPlayText", "bbReset", "bbEm", "bbMore", "toolbar", "tipPop", "toast",
                      "announce", "wake", "wakeTitle", "wakeText", "wakeElapsed", "wakeAttempt", "ckpt",
                      "nnBackend", "gridLabel", "decS", "elapsed", "epLen", "connText", "rtt", "buildId",
                      "eTimeline"]) {
      this.el[id] = $(id);
    }
    this.tracker = new Tracker();
    this.snaps = [];                // the tracker's inputs of the last few frames (see syncTracker)
    this.vt = 0;                    // simulated time the maps are showing
    this.speeds = [1];
    this.playing = true;
    this.speedTouchedAt = -1e9;
    this.emKind = "ambulance";
    this.maxEm = 4;
    this.legendItems = [];
    this.legendAt = 0;
    this.trackerAt = 0;
    this.dismissed = null;          // key of the trip whose panel the viewer closed
    this.shownKey = null;
    this.am = 0;                    // the server's automatic mode (g.am) and since when
    this.amSince = 0;
    this.auto = [0, 0];             // its slow-motion speed and pause on a result (s)
    this.state = "connecting";
    this.attempts = 0;
    this.notLiveSince = performance.now();
    this.wakeSince = 0;
    this.toastTimer = 0;
    this.focus = true;
    try { this.focus = localStorage.getItem("atsc-focus") !== "0"; } catch (e) { /* storage blocked */ }
    this.model = null;
    this.wire();
    setInterval(() => this.tickWake(), 500);
  }

  // ------------------------------------------------------------------ controls
  wire() {
    const el = this.el;
    const play = () => this.send({ a: this.playing ? "pause" : "play" });
    const reset = () => this.send({ a: "reset" });
    el.playPause.addEventListener("click", play);
    el.bbPlay.addEventListener("click", play);
    el.resetBtn.addEventListener("click", reset);
    el.bbReset.addEventListener("click", reset);
    el.stepBtn.addEventListener("click", () => { this.closeMenus(); this.send({ a: "step" }); });

    // speed slider: six stops; the value is sent after the knob settles
    let debounce = 0;
    const speedValue = () => this.speeds[Math.max(0, Math.min(this.speeds.length - 1, +el.speed.value))];
    el.speed.addEventListener("input", () => {
      this.speedTouchedAt = performance.now();
      this.paintSpeed(+el.speed.value);
      clearTimeout(debounce);
      debounce = setTimeout(() => this.send({ a: "speed", v: speedValue() }), 120);
    });
    el.speed.addEventListener("change", () => {
      clearTimeout(debounce);
      this.speedTouchedAt = performance.now();
      this.send({ a: "speed", v: speedValue() });
    });

    // emergency vehicles: the button opens the choice (ambulance, police car, fire engine)
    this.sendEm = (kind, fromPhone) => {
      this.send({ a: "inject", kind }, fromPhone ? el.bbEm : el.emSend);
      if (!fromPhone) return;
      // phone: bring the first map into view, where the vehicle is about to appear
      const r = el.cardRL.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.45) {
        const smooth = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        el.cardRL.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      }
    };
    el.emSend.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleMenu(el.emSend, el.emMenu); });
    el.bbEm.addEventListener("click", (ev) => { ev.stopPropagation(); this.sheet(false); this.toggleMenu(el.bbEm, el.bbEmMenu); });
    el.eTimeline.addEventListener("click", () => this.openTimeline());
    el.moreBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleMenu(el.moreBtn, el.moreMenu); });
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".menu")) this.closeMenus();
      if (document.body.classList.contains("sheet-open") && !ev.target.closest("#toolbar, #bbMore")) this.sheet(false);
      if (!ev.target.closest(".tip")) this.hideTip();
    });
    for (const menu of [el.emMenu, el.bbEmMenu, el.moreMenu]) {
      menu.addEventListener("keydown", (ev) => {
        const items = [...menu.querySelectorAll("[role=menuitem]")];
        const i = items.indexOf(document.activeElement);
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const next = items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
          if (next) next.focus();
        }
      });
    }

    // dialogs
    el.helpBtn.addEventListener("click", () => this.open(el.helpDlg));
    el.vehiclesBtn.addEventListener("click", () => { this.closeMenus(); this.open(el.vehiclesDlg); });
    el.techBtn.addEventListener("click", () => { this.closeMenus(); this.open(el.techDlg); });
    for (const b of document.querySelectorAll("dialog [data-close]")) {
      b.addEventListener("click", () => b.closest("dialog").close());
    }
    for (const d of document.querySelectorAll("dialog")) {
      d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });   // backdrop click
    }

    // presentation mode (full screen, no footer)
    el.presentBtn.addEventListener("click", () => {
      const doc = document.documentElement;
      if (!document.fullscreenElement && doc.requestFullscreen) doc.requestFullscreen().catch(() => this.present(!document.body.classList.contains("present")));
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else this.present(!document.body.classList.contains("present"));
    });
    document.addEventListener("fullscreenchange", () => this.present(!!document.fullscreenElement));

    // chart tabs
    const chart = (name) => {
      setAttr(el.chWait, "aria-selected", String(name === "wait"));
      setAttr(el.chQueue, "aria-selected", String(name === "queue"));
      setText(el.chCaption, name === "wait" ? "Shaded area = time saved by RL · lower is better"
                                            : "Shaded area = fewer cars waiting with RL · lower is better");
      this.h.chartMetric(name);
    };
    el.chWait.addEventListener("click", () => chart("wait"));
    el.chQueue.addEventListener("click", () => chart("queue"));

    // phone: the controls in a sheet
    el.bbMore.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.closeMenus();
      this.sheet(!document.body.classList.contains("sheet-open"));
    });

    // tracker panel
    setAttr(el.trkFocus, "aria-pressed", String(this.focus));
    el.trkFocus.addEventListener("click", () => this.setFocus(!this.focus));
    el.trkTimeline.addEventListener("click", () => this.openTimeline());
    el.trkClose.addEventListener("click", () => {
      const trip = this.tracker.selected();
      this.dismissed = trip ? trip.key : null;
      this.renderTracker(true);
    });

    // tips
    for (const b of document.querySelectorAll(".tip[data-tip]")) {
      b.addEventListener("click", (ev) => { ev.stopPropagation(); this.showTip(b); });
      b.addEventListener("mouseenter", () => this.showTip(b));
      b.addEventListener("mouseleave", () => this.hideTip());
      b.addEventListener("blur", () => this.hideTip());
    }

    // keyboard shortcuts
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { this.closeMenus(); this.hideTip(); this.sheet(false); return; }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target;
      if (t && (t.closest("input, select, textarea, [contenteditable]") || t.isContentEditable)) return;
      if (document.querySelector("dialog[open]")) return;
      const k = ev.key;
      if (k === " " && !(t && t.closest("button, a, [role=tab], [role=menuitem]"))) { ev.preventDefault(); play(); }
      else if (k === "r" || k === "R") reset();
      else if (k === "e" || k === "E") this.openEmMenu();
      else if (k === "f" || k === "F") this.setFocus(!this.focus);
      else if (k === "t" || k === "T") this.openTimeline();
      else if (k === "?") this.open(el.helpDlg);
    });
  }

  async send(cmd, button) {
    if (button) button.disabled = true;
    try {
      const res = await this.h.command(cmd);
      if (!res.ok) this.toast(res.error || "the server rejected that");
      return res;
    } finally {
      if (button) setTimeout(() => { button.disabled = false; }, 350);
    }
  }

  toggleMenu(button, menu) {
    const open = menu.hidden;
    this.closeMenus();
    if (!open) return;
    menu.hidden = false;
    setAttr(button, "aria-expanded", "true");
    const first = menu.querySelector("[role=menuitem]");
    if (first) first.focus({ preventScroll: true });
  }

  closeMenus() {
    const el = this.el;
    for (const [b, m] of [[el.emSend, el.emMenu], [el.bbEm, el.bbEmMenu], [el.moreBtn, el.moreMenu]]) {
      if (!m.hidden) { m.hidden = true; setAttr(b, "aria-expanded", "false"); }
    }
  }

  /** The E key: open the emergency choice wherever its button is on screen. */
  openEmMenu() {
    const el = this.el;
    if (el.emGroup.hidden) return;
    const phone = !el.emSend.getClientRects().length;
    const [button, menu] = phone ? [el.bbEm, el.bbEmMenu] : [el.emSend, el.emMenu];
    if (menu.hidden) this.toggleMenu(button, menu);
  }

  open(dialog) {
    if (!dialog || dialog.open) return;
    this.closeMenus();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  }

  present(on) {
    setClass(document.body, "present", on);
    setAttr(this.el.presentBtn, "aria-pressed", String(on));
  }

  sheet(open) {
    setClass(document.body, "sheet-open", open);
    setAttr(this.el.bbMore, "aria-expanded", String(open));
  }

  setFocus(on) {
    this.focus = on;
    try { localStorage.setItem("atsc-focus", on ? "1" : "0"); } catch (e) { /* storage blocked */ }
    setAttr(this.el.trkFocus, "aria-pressed", String(on));
    this.h.focusChanged(on);
  }

  showTip(button) {
    const pop = this.el.tipPop;
    pop.textContent = button.dataset.tip;
    pop.hidden = false;
    setAttr(button, "aria-expanded", "true");
    const r = button.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8;
    if (y + h > window.innerHeight - 8) y = r.top - h - 8;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    this.tipFor = button;
  }

  hideTip() {
    if (this.el.tipPop.hidden) return;
    this.el.tipPop.hidden = true;
    if (this.tipFor) setAttr(this.tipFor, "aria-expanded", "false");
  }

  // ------------------------------------------------------------------ hello
  setHello(model) {
    const hello = model.hello;
    const el = this.el;
    this.model = model;
    this.tracker = new Tracker();
    this.snaps = [];
    this.dismissed = null;
    // traffic level: one button per scenario
    el.trafficSeg.replaceChildren(...hello.scen.map(([name, description]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.scenario = name;
      b.textContent = trafficName(name);
      b.title = `${description} (restarts the run)`;
      b.addEventListener("click", () => {
        if (this.model && this.model.g.sc === name) return;
        this.send({ a: "scenario", v: name });
      });
      return b;
    }));
    // speeds
    this.speeds = hello.speeds.slice();
    el.speed.min = "0";
    el.speed.max = String(this.speeds.length - 1);
    el.speed.step = "1";
    el.speedTicks.replaceChildren(...this.speeds.map((_, i) => {
      const t = document.createElement("i");
      t.style.left = `${(100 * i) / Math.max(1, this.speeds.length - 1)}%`;
      return t;
    }));
    this.showSpeed(model.g.sp, true);
    // emergency vehicles: one menu item per configured type
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const kinds = hello.emg.map((e) => e[0]);
    this.emKind = kinds.includes("ambulance") ? "ambulance" : (kinds[0] || "ambulance");
    this.maxEm = +(hello.meta && hello.meta.max_em) || 4;
    const items = (phone) => hello.emg.map(([kind, label, corridor]) => {
      const spec = model.kinds.find((k) => k.kind === kind);
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset.kind = kind;
      const ico = document.createElement("span");
      ico.className = "mico";
      ico.setAttribute("aria-hidden", "true");
      ico.textContent = iconOf(kind);
      b.append(ico);
      const t = document.createElement("span");
      t.className = "mname";
      t.textContent = `Send ${label.toLowerCase()}`;
      const sub = document.createElement("span");
      sub.className = "msub";
      sub.textContent = corridor === "ew" ? "east–west" : "north–south";
      b.append(t, sub);
      if (spec) {
        const c = document.createElement("canvas");
        c.setAttribute("aria-hidden", "true");
        thumbnail(c, spec, 0, 34, 16, dpr);
        b.append(c);
      }
      b.addEventListener("click", (ev) => { ev.stopPropagation(); this.closeMenus(); this.sendEm(kind, phone); });
      return b;
    });
    const head = () => Object.assign(document.createElement("p"), { className: "mhead", textContent: "Which emergency vehicle?" });
    el.emMenu.replaceChildren(head(), ...items(false));
    el.bbEmMenu.replaceChildren(head(), ...items(true));
    for (const m of [el.emMenu, el.bbEmMenu]) m.firstChild.setAttribute("aria-hidden", "true");
    const noEm = hello.emg.length === 0;
    for (const node of [el.emGroup, el.bbEm.parentElement, el.emTile]) if (node) node.hidden = noEm;
    // the automatic slow motion and pause on a result (0 = off)
    this.auto = (hello.meta && Array.isArray(hello.meta.auto)) ? hello.meta.auto.map(Number) : [0, 0];
    this.am = -1;
    const [slow, pause] = this.auto;
    el.helpAuto.hidden = noEm || !(slow > 0 || pause > 0);
    if (!el.helpAuto.hidden) {
      const parts = [Object.assign(document.createElement("b"), { textContent: "Slow motion and a pause on the result: " })];
      const text = [];
      if (slow > 0) text.push(`while an emergency vehicle is on the road the race plays at ${fmtSpeed(slow)} so you can follow it (choosing a speed yourself turns this off)`);
      if (pause > 0) text.push(`once it is through both grids the race stops for ${pause} s on the result, then carries on`);
      parts.push(document.createTextNode(text.join("; ") + "."));
      el.helpAuto.replaceChildren(...parts);
    }
    // vehicle types (dialog)
    this.legendItems = model.kinds.map((spec) => {
      const li = document.createElement("li");
      const c = document.createElement("canvas");
      c.setAttribute("aria-hidden", "true");
      thumbnail(c, spec, 0, 44, 20, dpr);
      const name = document.createElement("span");
      name.className = "lg-name";
      name.textContent = spec.label;
      const share = hello.mix[spec.kind];
      if (share) name.title = `${(share * 100).toFixed(1)} % of the configured traffic mix`;
      else if (spec.em) name.title = "emergency vehicle - sent with the emergency button";
      const count = document.createElement("b");
      count.className = "lg-count";
      count.textContent = "0";
      li.className = spec.em ? "em" : "";
      li.append(c, name, count);
      return { li, count, last: -1 };
    });
    el.legendList.replaceChildren(...this.legendItems.map((x) => x.li));
    // static facts
    setText(el.epLen, String(hello.ep_s));
    setText(el.gridLabel, `${hello.grid.rows}×${hello.grid.cols}`);
    setText(el.decS, String(hello.dec_s));
    setText(el.ckpt, hello.meta.ckpt ? (hello.meta.ckpt_name || "loaded") : "untrained");
    setText(el.nnBackend, hello.meta.nn || "–");
    setText(el.buildId, hello.build || "–");
    if (el.untrained) el.untrained.hidden = !!hello.meta.ckpt;
  }

  paintSpeed(i) {
    const el = this.el;
    const n = Math.max(1, this.speeds.length - 1);
    const s = this.speeds[i];
    // the automatic slow motion says so beside the speed it chose
    const auto = this.am === 1 && this.model && this.model.g.sp === s;
    const name = auto ? "slow motion" : speedName(this.speeds, i);
    const text = fmtSpeed(s);
    if (el.speedOut.dataset.i !== `${i}|${name}`) {
      el.speedOut.dataset.i = `${i}|${name}`;
      el.speedOut.replaceChildren(document.createTextNode(text), ...(name ? [Object.assign(document.createElement("small"), { textContent: name })] : []));
    }
    setAttr(el.speed, "aria-valuetext", name ? `${text}, ${name}` : text);
    el.speed.style.setProperty("--fill", `${(100 * i) / n}%`);
    [...el.speedTicks.children].forEach((t, k) => { setClass(t, "on", k <= i); setClass(t, "cur", k === i); });
  }

  showSpeed(sp, force) {
    if (sp === undefined) return;
    const el = this.el;
    let idx = this.speeds.indexOf(sp);
    if (idx < 0) idx = this.speeds.reduce((best, s, i) => (Math.abs(s - sp) < Math.abs(this.speeds[best] - sp) ? i : best), 0);
    if (force || (performance.now() - this.speedTouchedAt > 1500 && document.activeElement !== el.speed)) {
      if (el.speed.value !== String(idx)) el.speed.value = String(idx);
      this.paintSpeed(idx);
    }
  }

  // ------------------------------------------------------------------ frames
  /** After every applied message: controls, the live result, the tiles, the tracker. */
  update(model) {
    this.model = model;
    const g = model.g, el = this.el;
    this.playing = !!g.p;
    for (const [b, t] of [[el.playPause, el.playText], [el.bbPlay, el.bbPlayText]]) {
      setText(t, this.playing ? "Pause" : "Play");
      setClass(b, "paused", !this.playing);
      setAttr(b, "aria-pressed", String(this.playing));
    }
    for (const b of el.trafficSeg.children) setAttr(b, "aria-checked", String(b.dataset.scenario === g.sc));
    setText(el.trafficPill, `${trafficName(g.sc)} traffic`);
    this.showAuto(g.am | 0);
    this.showConn();

    const e = Math.round(g.e || 0), epS = +model.hello.ep_s || 1800;
    setText(el.minuteText, `Minute ${Math.floor(e / 60)} of ${Math.round(epS / 60)}`);
    el.epBar.style.width = `${Math.min(100, (100 * e) / epS).toFixed(1)}%`;
    setText(el.elapsed, String(e));

    const rl = model.sides.rl.m, ft = model.sides.ft.m;
    if (rl.length && ft.length) this.showResults(rl, ft, e);

    // the tracker follows the frame the maps are showing, not the newest one (syncTracker)
    if (model.newEpisode) this.snaps = [];
    const side = (s) => ({ ev: s.ev, evx: s.evx, pr: s.pr });
    this.snaps.push({ bt: model.bt, ep: model.ep, ed: g.ed || [],
                      sides: { rl: side(model.sides.rl), ft: side(model.sides.ft) } });
    if (this.snaps.length > 10) this.snaps.shift();
  }

  /** Bring the tracker to the moment the maps show (`vt`): the newest frame at or before it,
   *  with the lamps of that very second. The maps play a frame or so behind the newest data,
   *  so following the newest frame would say "through" before the picture shows it leave. */
  syncTracker(model, vt) {
    if (!model.hello || !this.snaps.length) return;
    let snap = this.snaps[0];
    for (const s of this.snaps) if (s.bt <= vt + 1e-6) snap = s;
    const dt = Math.max(0, Math.min(model.stepS || 5, vt - snap.bt));
    const at = (n) => ({ ...snap.sides[n], s: model.sides[n].lampsAt(vt), mv: model.sides[n].mv, x: model.sides[n].x });
    const view = { hello: model.hello, kinds: model.kinds, travelOf: model.travelOf, stepS: model.stepS,
                   ep: snap.ep, bt: vt, g: { ed: snap.ed }, sides: { rl: at("rl"), ft: at("ft") } };
    for (const n of this.tracker.update(view, dt)) this.noteTrack(n);
  }

  showResults(rl, ft, e) {
    const el = this.el;
    // m: [wait, queue, throughput, speed, clearance, cleared, paired clearance, pairs]
    const [rlW, rlQ, rlT] = rl;
    const [ftW, ftQ, ftT] = ft;
    setText(el.wRL, fmtNum(rlW, 1));
    setText(el.wFT, fmtNum(ftW, 1));
    setText(el.gwRL, Number.isFinite(rlW) ? `${rlW.toFixed(1)} s` : "–");
    setText(el.gwFT, Number.isFinite(ftW) ? `${ftW.toFixed(1)} s` : "–");
    if (e < 120 || !(ftW > 0)) {
      setRich(el.resHead, ["Measuring the first two minutes…"], "measuring");
      setRich(el.resNote, ["The verdict appears once both grids have had some traffic."], "measuring");
    } else {
      const pct = ((ftW - rlW) / ftW) * 100;
      if (pct >= 1) setRich(el.resHead, ["The RL Agent System is cutting waiting time by ", ["em", `${Math.round(pct)}%`]], `g${Math.round(pct)}`);
      else if (pct <= -1) setRich(el.resHead, ["The Traditional System is ahead right now, by ", ["em", `${Math.round(-pct)}%`, "bad"]], `b${Math.round(-pct)}`);
      else setRich(el.resHead, ["Both systems are about even right now"], "even");
      const d = ftW - rlW;
      if (d >= 0.05) setRich(el.resNote, ["Every vehicle waits ", ["b", `${d.toFixed(1)} s less`], " at red lights with the RL Agent System."], `l${d.toFixed(1)}`);
      else if (d <= -0.05) setRich(el.resNote, ["Vehicles wait ", ["b", `${(-d).toFixed(1)} s more`], " with the RL Agent System right now."], `m${d.toFixed(1)}`);
      else setRich(el.resNote, ["Both keep vehicles waiting about the same time."], "same");
    }
    // cars queued per junction
    setText(el.qRL, fmtNum(rlQ, 1));
    setText(el.qFT, fmtNum(ftQ, 1));
    const qMax = Math.max(rlQ, ftQ, 1e-9);
    el.qBarRL.style.width = `${(100 * rlQ) / qMax}%`;
    el.qBarFT.style.width = `${(100 * ftQ) / qMax}%`;
    this.chip(el.qChip, ftQ > 0 ? ((ftQ - rlQ) / ftQ) * 100 : null, "shorter", "longer");
    // trips completed
    setText(el.tRL, fmtInt(rlT));
    setText(el.tFT, fmtInt(ftT));
    this.chip(el.tChip, ftT > 0 ? ((rlT - ftT) / ftT) * 100 : null, "more", "fewer", 1);
  }

  chip(node, pct, better, worse, digits = 0) {
    if (pct === null || !Number.isFinite(pct)) { setText(node, "–"); setClass(node, "good", false); setClass(node, "bad", false); return; }
    const mag = Math.abs(pct);
    const shown = mag.toFixed(mag < 10 ? digits : 0);
    if (Number(shown) === 0) { setText(node, "about even"); setClass(node, "good", false); setClass(node, "bad", false); return; }
    setText(node, `${shown}% ${pct > 0 ? better : worse}`);
    setClass(node, "good", pct > 0);
    setClass(node, "bad", pct < 0);
  }

  /** The note beside the speed (and in the status row on a phone) while the server is in an
   *  automatic mode: slow motion while an emergency vehicle is on the road, or the pause on a
   *  result with its countdown. */
  showAuto(am) {
    const el = this.el, now = performance.now();
    if (am !== this.am) { this.am = am; this.amSince = now; }
    let long = "", short = "", title = "";
    if (am === 1) {
      long = "Slow motion until it is through";
      short = "Slow motion";
      title = "An emergency vehicle is on the road, so the race plays slowly until it is through both grids. Choose a speed to turn this off.";
    } else if (am === 2) {
      const left = Math.max(1, Math.ceil((this.auto[1] || 5) - (now - this.amSince) / 1000));
      long = `Paused on the result · ${left} s`;
      short = `Result · ${left} s`;
      title = "The emergency vehicle is through both grids: the race stops here for a moment, then carries on. Press Play to carry on now.";
    }
    const note = el.autoNote;
    if (note) {
      if (note.dataset.text !== long) {
        note.dataset.text = long;
        note.replaceChildren(Object.assign(document.createElement("span"), { className: "an-l", textContent: long }),
                             Object.assign(document.createElement("span"), { className: "an-s", textContent: short }));
      }
      note.hidden = !long;
      if (note.title !== title) note.title = title;
      if (note.dataset.am !== String(am)) note.dataset.am = String(am);
    }
    if (this.model) this.showSpeed(this.model.g.sp);   // "slow motion" beside the speed too
  }

  /** Per animation frame (throttled): vehicle counts, and the tracker's running clocks. */
  frame(stats, ftStats, model, now, vt) {
    if (Number.isFinite(vt)) this.vt = vt;
    if (now - this.legendAt >= 400) {
      this.legendAt = now;
      const counts = stats.counts || [];
      this.legendItems.forEach((item, i) => {
        const n = counts[i] || 0;
        if (n !== item.last) { item.count.textContent = String(n); item.last = n; }
      });
    }
    if (now - this.trackerAt >= 120) {
      this.trackerAt = now;
      this.syncTracker(model, this.vt);
      this.renderTracker(false);
      if (this.am === 2) this.showAuto(2);       // the countdown
    }
  }

  // ------------------------------------------------------------------ emergency tracker
  /** Text of the label drawn beside a tracked vehicle on the map. */
  mapLabel(track, slot, status) {
    const name = slot === "hidden" && track.where === "queued" && track.pos > 0
      ? `${track.trip.label} · ${ordinal(track.pos)} in line` : track.trip.label;
    switch (status) {
      case "moving": return `${name} · Moving`;
      case "waiting": return `${name} · Waiting ${fmtClock(track.stopped)}`;
      case "stuck": return `${name} · Not moving ${fmtClock(track.stopped)}`;
      case "through": return track.clearance === null ? `${name} · Leaving the grid`
                                                     : `${name} · Through in ${fmtClock(track.clearance)}`;
      default: return name;
    }
  }

  noteTrack({ trip, side, status, text }) {
    const grid = side === "rl" ? "RL" : "traditional";
    const word = status === "through" ? "through" : status === "stuck" ? "not moving" : "waiting";
    this.announce(`${trip.label} ${word} on the ${grid} grid. ${text}.`);
  }

  renderTracker(full) {
    const el = this.el, model = this.model;
    if (!model || !model.hello) return;
    const tracker = this.tracker;
    const trip = tracker.selected();
    const active = tracker.active().length;
    for (const badge of [el.emCount, el.bbEmCount]) {
      if (!badge) continue;
      setText(badge, active ? String(active) : "");
      badge.title = active ? `${active} emergency vehicle${active === 1 ? "" : "s"} on the road` : "";
      badge.hidden = !active;
    }
    // the panel stays until the viewer closes it (or the next vehicle is sent)
    const show = !!trip && trip.key !== this.dismissed;
    if (el.tracker.classList.contains("on") !== show) {
      setClass(el.tracker, "on", show);
      setAttr(el.tracker, "aria-hidden", String(!show));
    }
    setClass(el.tiles, "tracking", show);
    this.renderTile();
    this.renderGridLine("rl", show ? trip : null, model);
    this.renderGridLine("ft", show ? trip : null, model);
    if (!show) { this.shownKey = null; return; }

    if (this.shownKey !== trip.key) {
      this.shownKey = trip.key;
      setText(el.trkIco, iconOf(trip.kind));
      setText(el.trkTitle, trip.label);
      this.buildTrack(el.laneRL, trip, model);
      this.buildTrack(el.laneFT, trip, model);
    }
    const r = trip.sides.rl, f = trip.sides.ft;
    const done = r.where === "through" && f.where === "through";
    const since = Math.max(r.age, f.age);           // the same clock as the two lanes
    setText(el.trkMeta, `${trip.corridor} · ${done ? "through both grids" : `sent ${fmtClock(since)} ago`}`);
    el.trkMeta.title = `${trip.direction} corridor, ${trip.corridor}`;
    const verdict = Tracker.verdict(trip);
    el.trkVerdict.hidden = !verdict;
    if (verdict) {
      setText(el.trkVerdict, verdict.text);
      setClass(el.trkVerdict, "good", verdict.tone === "good");
      setClass(el.trkVerdict, "bad", verdict.tone === "bad");
    }
    // while both are on the road: which system has it further along
    const ahead = Tracker.ahead(trip, model);
    el.trkAhead.hidden = !ahead;
    if (ahead) {
      setText(el.trkAhead, ahead.text);
      const tone = ahead.who || "level";
      if (el.trkAhead.dataset.who !== tone) el.trkAhead.dataset.who = tone;
    }
    // several vehicles: one tab each
    const trips = tracker.trips;
    el.trkPick.hidden = trips.length < 2;
    if (trips.length > 1) {
      const sig = trips.map((t) => t.key).join(",") + "|" + trip.key;
      if (el.trkPick.dataset.sig !== sig) {
        el.trkPick.dataset.sig = sig;
        el.trkPick.replaceChildren(...trips.map((t, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.setAttribute("role", "tab");
          b.setAttribute("aria-selected", String(t.key === trip.key));
          b.textContent = `${iconOf(t.kind)} ${i + 1}`;
          b.title = `${t.label} #${i + 1}`;
          b.addEventListener("click", () => { this.tracker.pin(t.key); this.dismissed = null; this.renderTracker(true); });
          return b;
        }));
      }
    }
    this.renderLane(el.laneRL, r, model);
    this.renderLane(el.laneFT, f, model);
  }

  /** What one grid's lane (and the line above its map) says - the status, the reason, the
   *  junction counter and the progress - kept in step with what the map is drawing: the frame
   *  the tracker follows can be up to one step behind the animation. */
  laneState(t, model) {
    let st = t.status();
    let reason = t.reason(model);
    const shown = this.shownAs ? this.shownAs(t) : null;
    const live = shown && t.where !== "through";
    if (live && ["cross", "link", "exit"].includes(shown.slot)) {
      st = "moving";
      const J = shown.ai >= 0 ? t.junction(model, shown.ai) : "";
      reason = shown.slot === "cross" ? `Crossing ${J} now` : shown.slot === "link" ? `Driving to ${J}` : "Leaving the grid";
    }
    let word = STATUS_WORD[st] || "–";
    if (st === "waiting" || st === "stuck") word += ` ${fmtClock(t.stopped)}`;
    const n = Math.max(1, t.legs);
    // the junction the picture shows it at or heading for (0-based place on its route)
    const at = live && shown.ai >= 0 ? t.trip.route.indexOf(shown.ai) : -1;
    let jn = "";
    if (t.where === "through") jn = `${n} of ${n} junction${n === 1 ? "" : "s"}`;
    else if (t.where !== null) {
      const k = live && shown.slot === "exit" ? n : at >= 0 ? at + 1 : t.leg + 1;
      jn = `Junction ${Math.min(n, k)} of ${n}`;
    }
    let p = Math.max(0, Math.min(1, t.progress(model)));
    if (live) {                                           // keep the marker with the picture
      // junction j (0-based) sits at (j + 1) / (n + 1): crossing it is at least there, driving
      // to it at least past the one before
      const k = shown.slot === "exit" ? n + 0.5 : shown.slot === "cross" ? (at >= 0 ? at : t.leg) + 1
              : shown.slot === "link" && at >= 0 ? at : 0;
      p = Math.max(p, Math.min(1, k / (n + 1)));
    }
    return { st, word, reason, jn, p };
  }

  /** The second line of a map's header: that grid's tracker line while a vehicle is tracked,
   *  else the description of the system. */
  renderGridLine(name, trip, model) {
    const sub = name === "rl" ? this.el.ghRL : this.el.ghFT;
    if (!sub) return;
    const line = sub.querySelector(".gtrk"), desc = sub.querySelector(".desc");
    const t = trip ? trip.sides[name] : null;
    const on = !!t;
    if (line.hidden === on) { line.hidden = !on; desc.hidden = on; setClass(sub, "trk", on); }
    if (!on) return;
    const s = this.laneState(t, model);
    let reason = s.reason, jn = s.jn;
    if (s.st === "through") {
      reason = t.clearance === null ? "Leaving the grid" : `Through in ${fmtClock(t.clearance)} · waited ${fmtClock(t.wait)} in all`;
      jn = "";
    } else if (t.where === null) {
      reason = "Joining the road…";
    }
    setText(line.querySelector(".gico"), iconOf(trip.kind));
    const chip = line.querySelector(".trk-status");
    if (chip.dataset.status !== s.st) chip.dataset.status = s.st;
    setText(chip.firstElementChild, s.word.toUpperCase());
    const why = line.querySelector(".greason");
    setText(why, reason);
    setText(line.querySelector(".gjn"), jn);
    const title = `${trip.label}: ${reason}${jn ? ` · ${jn}` : ""}`;
    if (line.title !== title) line.title = title;
  }

  buildTrack(lane, trip, model) {
    const track = lane.querySelector(".trk-track");
    const n = trip.route.length;
    const nodes = [track.querySelector(".rail"), track.querySelector(".fill")];
    const edge = (x, title) => {
      const c = document.createElement("span");
      c.className = "cp edge";
      c.style.left = `${x}%`;
      c.title = title;
      return c;
    };
    nodes.push(edge(0, `Entry, ${trip.corridor}`));
    trip.route.forEach((ai, k) => {
      const x = (100 * (k + 1)) / (n + 1);
      const c = document.createElement("span");
      c.className = "cp";
      c.dataset.k = String(k);
      c.style.left = `${x}%`;
      const name = model.hello.grid.ids[ai >> 2];
      c.title = name;
      const l = document.createElement("span");
      l.className = "cpl";
      l.style.left = `${x}%`;
      l.textContent = name;
      nodes.push(c, l);
    });
    nodes.push(edge(100, "Exit"), track.querySelector(".marker"));
    track.replaceChildren(...nodes);
  }

  renderLane(lane, t, model) {
    const state = this.laneState(t, model);
    const { st, word, reason, jn } = state;
    let p = state.p;
    if (lane.dataset.status !== st) lane.dataset.status = st;
    const chip = lane.querySelector(".trk-status");
    if (chip.dataset.status !== st) chip.dataset.status = st;
    setText(chip.firstElementChild || chip, word.toUpperCase());
    const why = lane.querySelector(".trk-reason");
    setText(why, reason);
    if (why.title !== reason) why.title = reason;
    setText(lane.querySelector(".trk-jn"), jn);
    // the marker only ever moves forward along the route
    const id = `${t.trip.key}:${t.side}`;
    if (lane.dataset.track !== id) { lane.dataset.track = id; lane.pmax = 0; }
    p = Math.max(p, lane.pmax || 0);
    lane.pmax = p;
    lane.querySelector(".marker").style.left = `${(100 * p).toFixed(2)}%`;
    lane.querySelector(".fill").style.width = `${(100 * p).toFixed(2)}%`;
    for (const c of lane.querySelectorAll(".cp[data-k]")) {
      const k = +c.dataset.k;
      setClass(c, "passed", t.where === "through" || k < t.leg);
      setClass(c, "next", t.where !== "through" && t.where !== null && k === t.leg);
    }
    const time = lane.querySelector(".trk-time");
    const key = `${st}|${Math.round(t.age)}|${Math.round(t.wait)}`;
    if (time.dataset.key !== key) {
      time.dataset.key = key;
      const big = document.createElement("b");
      const small = document.createElement("small");
      if (st === "through") {
        big.textContent = fmtClock(t.clearance);
        small.textContent = `waited ${fmtClock(t.wait)}`;
        time.title = "Time from being sent to leaving the grid · time it stood in queues";
      } else if (t.where === null) {
        big.textContent = "–";
        small.textContent = "";
        time.title = "";
      } else {
        big.textContent = fmtClock(t.age);
        small.textContent = `waited ${fmtClock(t.wait)}`;
        time.title = "Time since it was sent · time it has stood in queues so far";
      }
      time.replaceChildren(big, small);
    }
  }

  /** The small emergency tile (shown when the tracker panel is not): the last result. */
  renderTile() {
    const el = this.el;
    const done = this.tracker.trips.filter((t) => t.sides.rl.clearance !== null && t.sides.ft.clearance !== null);
    const last = done[done.length - 1];
    setClass(el.emTile, "done", !!last);
    el.eTimeline.hidden = !last;
    if (!last) {
      setClass(el.eHead, "muted", true);
      setRich(el.eHead, ["Not run yet"], "none");
      el.eChip.hidden = true;
      setText(el.eText, "Send one and see which system gets it through faster. It is circled and tracked on both grids.");
      return;
    }
    // the last finished test: time to get through on each grid
    const r = last.sides.rl.clearance, f = last.sides.ft.clearance;
    setClass(el.eHead, "muted", false);
    setRich(el.eHead, [["span", fmtClock(r), "a"], ["span", "vs", "vs2"], ["span", fmtClock(f), "b"]], `${last.key}|${r}|${f}`);
    const ratio = f / Math.max(1e-9, r);
    el.eChip.hidden = false;
    setText(el.eChip, ratio >= 1.05 ? `${ratio.toFixed(1)}× faster` : ratio <= 0.95 ? `${(1 / ratio).toFixed(1)}× slower` : "about even");
    setClass(el.eChip, "good", ratio >= 1.05);
    setClass(el.eChip, "bad", ratio <= 0.95);
    setText(el.eText, `${last.label}: time to get through the grid, RL vs traditional.`);
  }

  openTimeline() {
    const trip = this.tracker.selected();
    const el = this.el;
    if (!trip) { this.toast("No emergency vehicle yet - send one with the 🚨 button.", "info"); return; }
    setText(el.tlTitle, `${trip.label} · timeline`);
    const fill = (list, track) => {
      list.replaceChildren(...track.events.map((ev, i) => {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = fmtClock(ev.t);
        li.append(t, document.createTextNode(` ${ev.text}`));
        if (track.where === "through" && i === track.events.length - 1) li.className = "last";
        return li;
      }));
      if (!track.events.length) {
        const li = document.createElement("li");
        li.textContent = "Not on this grid yet.";
        list.append(li);
      }
    };
    fill(el.tlRL, trip.sides.rl);
    fill(el.tlFT, trip.sides.ft);
    this.open(el.timelineDlg);
  }

  // ------------------------------------------------------------------ status
  setStatus(state, info) {
    this.state = state;
    this.attempts = info.attempts || 0;
    this.connInfo = info;
    if ((state === "live" || state === "polling") !== (this.wasLive || false)) {
      this.notLiveSince = performance.now();
      this.wasLive = state === "live" || state === "polling";
    }
    this.showConn();
    this.tickWake();
  }

  showConn() {
    const el = this.el;
    const info = this.connInfo || {};
    let [text, dot] = CONN[this.state] || [this.state, "off"];
    if (this.state === "busy" && info.retryAt) text = `Server full · retrying in ${Math.max(1, Math.round((info.retryAt - Date.now()) / 1000))} s`;
    const live = this.state === "live" || this.state === "polling";
    if (live && !this.playing) {
      dot = "paused";
      if (this.am !== 2) text = `${text} · paused`;     // else the note says why it paused
    }
    setText(el.statusText, text);
    if (el.liveState.dataset.state !== dot) el.liveState.dataset.state = dot;
    setText(el.connText, text);
    setText(el.rtt, info.rtt != null && this.state === "live" ? `· ping ${Math.round(info.rtt)} ms` : "");
  }

  tickWake() {
    const live = this.state === "live" || this.state === "polling";
    const waitedMs = performance.now() - this.notLiveSince;
    const show = !live && this.state !== "hidden" && (this.state === "waking" || waitedMs > 3000);
    const el = this.el;
    if (show && el.wake.hidden) {
      el.wake.hidden = false;
      this.wakeSince = performance.now();
    } else if (!show && !el.wake.hidden) {
      el.wake.hidden = true;
    }
    if (show) {
      const everLive = el.wake.dataset.everLive === "1";
      setText(el.wakeTitle, everLive ? "Reconnecting…" : "Waking up the server…");
      setText(el.wakeText, everLive
        ? "The connection to the simulation dropped. The page reconnects by itself as soon as the server answers again."
        : "This free demo goes to sleep when nobody is watching. Starting it again takes up to a minute — the page connects by itself as soon as it is up.");
      setText(el.wakeElapsed, String(Math.round((performance.now() - this.wakeSince) / 1000)));
      setText(el.wakeAttempt, String(Math.max(1, this.attempts)));
    }
    if (live) el.wake.dataset.everLive = "1";
  }

  toast(message, kind) {
    const el = this.el.toast;
    el.textContent = message;
    setClass(el, "info", kind === "info");
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }

  announce(text) {
    const el = this.el.announce;
    el.textContent = "";
    setTimeout(() => { el.textContent = text; }, 30);
  }
}
