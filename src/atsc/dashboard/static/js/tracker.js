// Emergency tracker: follows every emergency vehicle on both grids and says, at every frame,
// whether it is moving, waiting (and why) or through - so anyone watching can confirm at a
// glance that it is getting through, and see exactly where the two systems differ.
//
// It reads only what the server sends (protocol in src/atsc/dashboard/session.py):
//   ed   each dispatch: the same vehicle's id on both grids, its kind, when it was sent and
//        the junctions on its route
//   ev   where each emergency vehicle is: waiting at which junction and how far back in the
//        queue, or driving along a link (it covers vehicles the browser is not sent, deep in
//        a long queue)
//   evx  the vehicles that have left a grid, with the exact time it took
// plus what the model already keeps: the lamps, the pre-empted junctions and the link events.
//
// The page feeds it the frame that matches the moment the maps are showing (the maps play a
// frame or so behind the newest one, see SimClock in model.js), so what the panel and the
// labels say always matches the picture.
//
// Nothing here touches the DOM: tests/test_tracker_js.py runs this file in Node.

/** Simulated seconds without any progress after which a vehicle is reported "not moving". */
export const STUCK_S = 30;
const EDGE = ["the north", "the east", "the south", "the west"];

export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/** "0:43", "2:05" (simulated time). */
export function fmtClock(s) {
  if (!Number.isFinite(s) || s < 0) return "–";
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * What approach `ai` of a grid is being shown right now: "green", "ending" (its own amber),
 * "switching" (the junction is between greens, or the cross street is on amber) or "red".
 */
export function lightAt(model, side, ai) {
  const j = ai >> 2;
  const code = (side.s.charCodeAt(j) || 97) - 97;
  const phase = Math.floor(code / 3), state = code % 3;
  const greens = ((model.hello.grid.phases || [])[phase] || ["", ""])[1];
  const mine = greens.includes("NESW"[ai & 3]);
  if (state === 2) return "switching";
  if (state === 1) return mine ? "ending" : "switching";
  return mine ? "green" : "red";
}

/** One emergency vehicle on one grid. */
export class Track {
  constructor(trip, sideName, id) {
    this.trip = trip;
    this.side = sideName;
    this.id = id;
    this.kind = trip.kind;
    this.where = null;          // "queued" | "driving" | "through" | null (not seen yet)
    this.ai = -1;               // approach it waits on, or the one its link leads to
    this.pos = 0;               // place in the queue (1 = at the stop line)
    this.qlen = 0;
    this.leg = 0;               // junctions behind it
    this.legs = trip.route.length;
    this.wait = 0;              // accumulated waiting time (s, from the server)
    this.age = 0;               // time since dispatch (s, from the server)
    this.rem = 0;               // link time left (s) while driving
    this.best = -1;             // furthest progress seen (see progressKey)
    this.bestAge = 0;           // when it got there (s since dispatch)
    this.stopped = 0;           // s since it last made progress (while queued)
    this.light = null;          // lightAt() of the approach it waits on
    this.preempted = false;     // its junction is pre-empted for an emergency vehicle
    this.clearance = null;      // s from dispatch to leaving the grid
    this.events = [];           // [{t, text}] in time order
    this.logged = new Set();
  }

  /** "moving", "waiting", "stuck", "through" or "pending". */
  status() {
    if (this.where === "through") return "through";
    if (this.where === "driving") return "moving";
    if (this.where === "queued") {
      if (this.light === "green") return "moving";        // the queue ahead of it is clearing
      return this.stopped >= STUCK_S ? "stuck" : "waiting";
    }
    return "pending";
  }

  junction(model, ai = this.ai) {
    return ai >= 0 ? model.hello.grid.ids[ai >> 2] : "";
  }

  /** One plain sentence: where it is and why it is (not) moving. */
  reason(model) {
    const J = this.junction(model);
    if (this.where === "through") {
      const names = this.trip.route.map((ai) => this.junction(model, ai));
      return names.length ? `Crossed ${names.join(" → ")} · out of the grid` : "Out of the grid";
    }
    if (this.where === "driving") return `Driving to ${J}`;
    if (this.where !== "queued") return "Joining the road…";
    const ahead = this.pos - 1;
    const line = ahead <= 0 ? "first in line" : `${ahead} vehicle${ahead === 1 ? "" : "s"} ahead`;
    switch (this.light) {
      case "green": return ahead <= 0 ? `Crossing ${J} now` : `Green at ${J} · ${line}, clearing`;
      case "switching": return `${J} is switching to green for it · ${line}`;
      case "ending": return `Its light at ${J} is changing · ${line}`;
      default: return this.preempted ? `Green requested at ${J} · ${line}` : `Red light at ${J} · ${line}`;
    }
  }

  /** 0 at the entry edge, 1 out of the grid; junctions sit at k / (legs + 1). Between two
   *  junctions the first half is the drive along the link and the second half the queue, so
   *  the marker never moves backwards. */
  progress(model) {
    const n = Math.max(1, this.legs), seg = 1 / (n + 1);
    if (this.where === "through") return 1;
    if (this.where === "driving") {
      const travel = model.travelOf[this.trip.kindCode] || 1;
      const done = Math.min(1, Math.max(0, 1 - this.rem / travel));
      return Math.min(1, this.leg * seg + 0.5 * seg * done);
    }
    if (this.where === "queued") {
      const back = Math.min(1, Math.max(0, this.pos - 1) / 10);    // 10+ vehicles ahead: the back
      return Math.min(1, this.leg * seg + 0.5 * seg + 0.46 * seg * (1 - back));
    }
    return 0;
  }

  log(t, text, key) {
    if (key) {
      if (this.logged.has(key)) return false;
      this.logged.add(key);
    }
    this.events.push({ t: Math.max(0, t), text });
    this.events.sort((a, b) => a.t - b.t);
    return true;
  }
}

/** Orders positions along the route: driving to junction k < queued there (further forward is
 *  more) < driving to junction k + 1. */
function progressKey(where, leg, pos) {
  return leg * 10000 + (where === "driving" ? 0 : 10000 - Math.min(Math.max(pos, 1), 9999));
}

/** The moment (s since dispatch) a vehicle crossed the stop line of approach `src`, from the
 *  link / exit events the model keeps, or null if they are no longer known. */
function crossedAt(model, side, id, src, t0) {
  const step = model.stepS;
  for (const v of side.mv.values()) if (v[4] === id && v[1] === src) return v[3] / 10 - step - t0;
  for (const v of side.x.values()) if (v[4] === id && v[1] === src) return v[3] / 10 - step - t0;
  return null;
}

export class Tracker {
  constructor() {
    this.trips = [];
    this.ep = null;
    this.pinned = null;         // key of the trip the viewer chose to look at
  }

  /** Follow the model (or a view of it at the moment the maps show: the same fields, with
   *  `g.ed` and each side's `ev`, `evx`, `pr` and `s` from that moment). `dt` is how far the
   *  maps are past that frame (s): running clocks are moved on by it. Returns what changed,
   *  for screen readers: [{trip, side, status, text}] (started waiting, got stuck or through). */
  update(model, dt = 0) {
    const notes = [];
    if (!model.hello) return notes;
    if (model.ep !== this.ep) {
      this.ep = model.ep;
      this.trips = [];
      this.pinned = null;
    }
    const ed = model.g.ed || [];
    const keep = new Set();
    for (const [rlId, ftId, kindCode, t10, route] of ed) {
      const key = `${rlId}:${ftId}:${t10}`;
      keep.add(key);
      if (this.trips.some((t) => t.key === key)) continue;
      const spec = model.kinds[kindCode] || {};
      const trip = { key, kindCode, kind: spec.kind || "emergency", label: spec.label || "Emergency vehicle",
                     t0: t10 / 10, route: route.slice(), sides: {} };
      trip.sides.rl = new Track(trip, "rl", rlId);
      trip.sides.ft = new Track(trip, "ft", ftId);
      const a = route.length ? route[0] & 3 : 3;
      trip.corridor = route.length ? `from ${EDGE[a]}` : "";
      trip.direction = [0, 2].includes(a) ? "north–south" : "east–west";
      this.trips.push(trip);
    }
    // the server keeps the last few dispatches of the episode; so do we
    this.trips = this.trips.filter((t) => keep.has(t.key));
    if (this.pinned && !keep.has(this.pinned)) this.pinned = null;

    for (const trip of this.trips) {
      for (const name of ["rl", "ft"]) {
        const track = trip.sides[name];
        const before = track.status();
        this.follow(model, model.sides[name], track, dt);
        const after = track.status();
        if (after !== before && ["waiting", "stuck", "through"].includes(after)) {
          notes.push({ trip, side: name, status: after, text: track.reason(model) });
        }
      }
    }
    return notes;
  }

  follow(model, side, t, dt = 0) {
    const trip = t.trip;
    const e = side.ev.find((v) => v[0] === t.id);
    if (e) {
      const [, , where, ai, pos, qlen, leg, legs, wait10, age10, rem10] = e;
      const was = { where: t.where, leg: t.leg, ai: t.ai };
      t.where = where === 0 ? "queued" : "driving";
      t.ai = ai; t.pos = pos; t.qlen = qlen; t.leg = leg; t.legs = legs || t.legs;
      t.wait = wait10 / 10; t.age = age10 / 10 + dt; t.rem = Math.max(0, rem10 / 10 - dt);
      const key = progressKey(t.where, leg, pos);
      if (t.best < 0) {
        t.best = key;
        t.bestAge = 0;                       // it has been where it is since it was sent
      } else if (key > t.best) {
        t.best = key;
        t.bestAge = t.age;
      }
      t.stopped = t.where === "queued" ? Math.max(0, t.age - t.bestAge) : 0;
      t.light = t.where === "queued" ? lightAt(model, side, ai) : null;
      t.preempted = t.where === "queued" && (side.pr || []).includes(ai >> 2);

      if (was.where === null) {
        const J = t.junction(model, trip.route[0] ?? ai);
        t.log(0, `Sent in ${trip.corridor} towards ${J}`, "sent");
      }
      for (let k = was.where === null ? 0 : was.leg; k < leg; k++) this.logCross(model, side, t, k);
      if (t.where === "queued" && (was.where !== "queued" || was.ai !== ai)) {
        t.log(t.age, `Waiting at ${t.junction(model)} · ${ordinal(pos)} in line`, `reach:${leg}`);
      }
      if (t.where === "queued") {
        if (t.preempted) t.log(t.age, `Green requested at ${t.junction(model)}`, `pre:${leg}`);
        if (t.light === "green") t.log(t.age, `Green light at ${t.junction(model)}`, `green:${leg}`);
      }
      return;
    }
    const done = (side.evx || []).find((v) => v[0] === t.id);
    if (done && t.where !== "through") {
      if (t.where === null) t.log(0, `Sent in ${trip.corridor} towards ${t.junction(model, trip.route[0] ?? -1)}`, "sent");
      for (let k = t.leg; k < t.legs; k++) this.logCross(model, side, t, k);
      t.where = "through";
      t.clearance = done[2] / 10;
      t.age = t.clearance;
      t.stopped = 0;
      t.light = null;
      t.preempted = false;
      t.log(t.clearance, `Out of the grid · through in ${fmtClock(t.clearance)}`, "through");
    }
  }

  logCross(model, side, t, k) {
    const src = t.trip.route[k];
    if (src === undefined) return;
    const at = crossedAt(model, side, t.id, src, t.trip.t0);
    t.log(at === null ? t.age : at, `Crossed ${t.junction(model, src)}`, `cross:${k}`);
  }

  /** Tracks of one grid that are worth drawing (in the grid or just through). */
  tracksFor(name) {
    return this.trips.map((trip) => trip.sides[name]).filter((t) => t.where !== null);
  }

  active() {
    return this.trips.filter((t) => t.sides.rl.where !== "through" || t.sides.ft.where !== "through");
  }

  /** The trip the panel shows: the one the viewer picked, else the newest still on the road,
   *  else the newest. */
  selected() {
    if (this.pinned) {
      const p = this.trips.find((t) => t.key === this.pinned);
      if (p) return p;
    }
    const live = this.active();
    return live.length ? live[live.length - 1] : this.trips[this.trips.length - 1] || null;
  }

  pin(key) {
    this.pinned = key;
  }

  /** Which system has the vehicle further along while it is on the road in both grids:
   *  {who: "rl" | "ft" | null (level), text}. null while there is nothing to compare yet, or
   *  once it is through on either grid (the verdict says how that went). */
  static ahead(trip, model) {
    const r = trip.sides.rl, f = trip.sides.ft;
    if (!r.where || !f.where || r.where === "through" || f.where === "through") return null;
    const NAME = { rl: "RL Agent System", ft: "Traditional System" };
    const lead = (who, text) => ({ who, text: `${NAME[who]} is ahead · ${text}` });
    if (r.leg !== f.leg) {
      const who = r.leg > f.leg ? "rl" : "ft";
      const front = who === "rl" ? r : f, back = who === "rl" ? f : r;
      const past = trip.route.slice(back.leg, front.leg).map((ai) => front.junction(model, ai));
      const d = front.leg - back.leg;
      return lead(who, `${d} junction${d === 1 ? "" : "s"} further along (past ${past.join(" and ")})`);
    }
    const J = r.junction(model, trip.route[r.leg] ?? r.ai);
    if (r.where === "queued" && f.where === "queued") {
      if (r.pos === f.pos) return { who: null, text: `Level · both ${ordinal(r.pos)} in line at ${J}` };
      const who = r.pos < f.pos ? "rl" : "ft";
      const [a, b] = who === "rl" ? [r, f] : [f, r];
      return lead(who, `${ordinal(a.pos)} in line at ${J}, the other ${ordinal(b.pos)}`);
    }
    if (r.where !== f.where) {                 // one has reached the junction, the other not yet
      return lead(r.where === "queued" ? "rl" : "ft", `already at ${J}, the other is still driving there`);
    }
    const gap = Math.round(Math.abs(r.rem - f.rem));
    if (gap < 1) return { who: null, text: `Level · both driving to ${J}` };
    return lead(r.rem < f.rem ? "rl" : "ft", `${gap} s closer to ${J}`);
  }

  /** The comparison once there is one: {tone: "good"|"bad"|null, text}. */
  static verdict(trip) {
    const r = trip.sides.rl.clearance, f = trip.sides.ft.clearance;
    if (r !== null && f !== null && r > 0) {
      const ratio = f / r, gap = Math.round(Math.abs(f - r));
      const sooner = gap >= 60 ? `${fmtClock(gap)} sooner` : `${gap} s sooner`;
      if (ratio >= 1.05) return { tone: "good", text: `RL Agent System got it through ${ratio.toFixed(1)}× faster · ${sooner}` };
      if (ratio <= 0.95) return { tone: "bad", text: `Traditional System got it through ${(1 / ratio).toFixed(1)}× faster · ${sooner}` };
      return { tone: null, text: "Both got it through in about the same time" };
    }
    if (r !== null) return { tone: "good", text: `Through the RL grid in ${fmtClock(r)} · still in traditional traffic` };
    if (f !== null) return { tone: "bad", text: `Through the traditional grid first, in ${fmtClock(f)}` };
    return null;
  }
}
