"""The emergency tracker (static/js/tracker.js) says where each emergency vehicle really is.

A rush-hour run with an ambulance (east-west) and a police car (north-south) is recorded from
the real DashboardSession, together with the simulator's own view of both vehicles at every
frame. The stream is replayed through model.js + tracker.js in Node, and the tracker must:

* place each vehicle exactly where the simulator has it (waiting at which junction, how far
  back in the queue, or driving along a link), on both grids, at every frame;
* call it "moving", "waiting", "not moving" or "through" consistently with that position and
  the light it faces, and never move its progress marker backwards;
* report the same time to get through as the simulator, write a timeline that starts with the
  dispatch and ends with the exit, and give a verdict that matches the two times;
* while the vehicle is on the road in both grids, name the grid where it is further along.

Skipped when Node.js is not installed.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from atsc.dashboard.runtime import encode
from atsc.dashboard.session import DashboardSession
from atsc.sim.backend import APPROACHES
from atsc.sim.mini_backend import vehicle_number

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "src" / "atsc" / "dashboard" / "static" / "js"
NODE = shutil.which("node")

RUNNER = r"""
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [jsDir, streamPath] = process.argv.slice(2);
const { Model } = await import(pathToFileURL(`${jsDir}/model.js`).href);
const { Tracker, STUCK_S } = await import(pathToFileURL(`${jsDir}/tracker.js`).href);
const stream = JSON.parse(readFileSync(streamPath, "utf8"));
const model = new Model();
const tracker = new Tracker();
const later = new Tracker();             // the same frames, shown 1.5 s after each of them
const out = [];
for (const msg of stream) {
  model.apply(msg);
  const notes = tracker.update(model);
  later.update(model, 1.5);
  const side = (t, n, k = t.sides[n]) => ({
    id: k.id, where: k.where, ai: k.ai, pos: k.pos, qlen: k.qlen, leg: k.leg, light: k.light, rem: k.rem,
    status: k.status(), stopped: k.stopped, clearance: k.clearance, age: k.age, wait: k.wait,
    reason: k.reason(model), progress: k.progress(model), events: k.events.map((e) => [e.t, e.text]),
    laterAge: later.trips.find((x) => x.key === t.key).sides[n].age,
  });
  out.push({
    bt: model.bt, ep: model.ep, stuckS: STUCK_S,
    notes: notes.map((n) => [n.trip.key, n.side, n.status]),
    selected: tracker.selected() ? tracker.selected().key : null,
    active: tracker.active().length,
    trips: tracker.trips.map((t) => ({
      key: t.key, label: t.label, kind: t.kind, route: t.route, corridor: t.corridor,
      direction: t.direction, verdict: Tracker.verdict(t), ahead: Tracker.ahead(t, model),
      rl: side(t, "rl"), ft: side(t, "ft"),
    })),
  });
}
process.stdout.write(JSON.stringify(out));
"""


def _config(tmp_path):
    raw = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    raw.setdefault("dashboard", {}).update(keyframe_every_s=3600)
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    return str(path)


def _truth(runner):
    """Every emergency vehicle as the simulator has it: number -> (where, ai, pos, qlen, leg)."""
    backend = runner.env.backend
    ai_of = {(tls, a): j * 4 + k for j, tls in enumerate(runner.env.topo.order)
             for k, a in enumerate(APPROACHES)}
    out = {}
    for (tls, approach), q in backend._queues.items():
        for i, veh in enumerate(q):
            if veh.is_emergency:
                out[vehicle_number(veh.id)] = ("queued", ai_of[(tls, approach)], i + 1, len(q),
                                               veh.leg_index)
    for veh, _remaining, tls, approach in backend._transit:
        if veh.is_emergency:
            out[vehicle_number(veh.id)] = ("driving", ai_of[(tls, approach)], 0, 0, veh.leg_index)
    return out


def _record(tmp_path):
    s = DashboardSession(_config(tmp_path))
    s.set_scenario("rush")
    s.play()
    for _ in range(12):                              # let the queues build up first
        s.tick()
    stream = [json.loads(encode(s.hello()))]
    truth = []
    script = {0: {"a": "inject", "kind": "ambulance"}, 3: {"a": "inject", "kind": "police"}}
    for tick in range(600):
        if tick in script:
            s.submit(script[tick])
        frame = s.tick()
        if frame is None:
            continue
        stream.append(json.loads(encode(frame)))
        truth.append({"rl": _truth(s.rl), "ft": _truth(s.ft)})
        if tick > 3 and not s.rl.active_emergencies() and not s.ft.active_emergencies():
            break
    cleared = {name: {vehicle_number(v): t for v, t in runner.recorder.em_times.items()}
               for name, runner in (("rl", s.rl), ("ft", s.ft))}
    return s, stream, truth, cleared


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    if NODE is None:
        pytest.skip("Node.js is not installed")
    tmp = tmp_path_factory.mktemp("tracker")
    s, stream, truth, cleared = _record(tmp)
    path = tmp / "stream.json"
    path.write_text(json.dumps(stream), encoding="utf-8")
    runner = tmp / "runner.mjs"
    runner.write_text(RUNNER, encoding="utf-8")
    res = subprocess.run([NODE, str(runner), str(JS), str(path)], capture_output=True, text=True,
                         timeout=180)
    assert res.returncode == 0, res.stderr
    frames = json.loads(res.stdout)[1:]               # one entry per frame (the hello first)
    assert len(frames) == len(truth)
    return s, frames, truth, cleared


def test_both_dispatches_are_followed_on_both_grids(run):
    s, frames, _truth_, _cleared = run
    trips = frames[-1]["trips"]
    assert [t["kind"] for t in trips] == ["ambulance", "police"]
    j = {tls: i for i, tls in enumerate(s.rl.env.topo.order)}
    west, north = APPROACHES.index("W"), APPROACHES.index("N")
    amb, pol = trips
    assert amb["route"] == [j["J1_0"] * 4 + west, j["J1_1"] * 4 + west]
    assert (amb["corridor"], amb["direction"]) == ("from the west", "east–west")
    assert pol["route"] == [j["J0_1"] * 4 + north, j["J1_1"] * 4 + north]
    assert (pol["corridor"], pol["direction"]) == ("from the north", "north–south")
    assert amb["label"] == "Ambulance" and pol["label"]


def test_every_frame_places_each_vehicle_where_the_simulator_has_it(run):
    _s, frames, truth, _cleared = run
    seen = set()
    for frame, real in zip(frames, truth):
        for trip in frame["trips"]:
            for name in ("rl", "ft"):
                t = trip[name]
                if t["id"] in real[name]:
                    where, ai, pos, qlen, leg = real[name][t["id"]]
                    assert (t["where"], t["ai"], t["leg"]) == (where, ai, leg), (name, t)
                    if where == "queued":
                        assert (t["pos"], t["qlen"]) == (pos, qlen), (name, t)
                    seen.add((trip["kind"], name, where))
                else:
                    assert t["where"] in ("through", None), (name, t)
    # both vehicles were seen waiting and driving on both grids
    for kind in ("ambulance", "police"):
        for name in ("rl", "ft"):
            assert {(kind, name, "queued"), (kind, name, "driving")} <= seen, (kind, name)


def test_status_and_reason_agree_with_the_position_and_the_light(run):
    _s, frames, _truth_, _cleared = run
    words = {"moving", "waiting", "stuck", "through", "pending"}
    statuses = set()
    for frame in frames:
        for trip in frame["trips"]:
            for name in ("rl", "ft"):
                t = trip[name]
                st = t["status"]
                assert st in words
                statuses.add(st)
                if t["where"] == "driving":
                    assert st == "moving" and t["reason"].startswith("Driving to J")
                elif t["where"] == "queued":
                    if t["light"] == "green":
                        assert st == "moving" and t["reason"].startswith(("Green at J", "Crossing J"))
                    else:
                        assert st == ("stuck" if t["stopped"] >= frame["stuckS"] else "waiting"), t
                        ahead = t["pos"] - 1
                        assert ("first in line" in t["reason"]) == (ahead == 0)
                        if ahead > 0:
                            assert f"{ahead} vehicle" in t["reason"]
                elif t["where"] == "through":
                    assert st == "through" and t["reason"].endswith("out of the grid")
    assert {"moving", "waiting", "through"} <= statuses


def test_progress_marker_never_moves_backwards(run):
    _s, frames, _truth_, _cleared = run
    last = {}
    for frame in frames:
        for trip in frame["trips"]:
            for name in ("rl", "ft"):
                key = (trip["key"], name)
                p = trip[name]["progress"]
                assert 0 <= p <= 1
                assert p >= last.get(key, 0) - 1e-9, (key, p, last.get(key))
                last[key] = p
    assert all(p == 1 for p in last.values())


def test_time_to_get_through_and_timeline_match_the_simulator(run):
    _s, frames, _truth_, cleared = run
    final = frames[-1]
    for trip in final["trips"]:
        for name in ("rl", "ft"):
            t = trip[name]
            assert t["where"] == "through" and t["status"] == "through"
            assert t["clearance"] == pytest.approx(round(cleared[name][t["id"]] * 10) / 10)
            texts = [text for _at, text in t["events"]]
            times = [at for at, _text in t["events"]]
            assert texts[0].startswith(f"Sent in {trip['corridor']}")
            assert texts[-1].startswith("Out of the grid · through in")
            assert times == sorted(times) and times[-1] == pytest.approx(t["clearance"])
            crossed = [x for x in texts if x.startswith("Crossed ")]
            assert len(crossed) == len(trip["route"])
            assert any(x.startswith("Waiting at J") for x in texts)
        r, f = trip["rl"]["clearance"], trip["ft"]["clearance"]
        v = trip["verdict"]
        if f / r >= 1.05 or f / r <= 0.95:
            # the faster system is named, with how many times faster and how much sooner
            faster = "RL Agent System" if f > r else "Traditional System"
            assert v["tone"] == ("good" if f > r else "bad")
            assert v["text"].startswith(f"{faster} got it through ")
            ratio = float(v["text"].split(" got it through ")[1].split("×")[0])
            assert ratio == pytest.approx(max(f, r) / min(f, r), abs=0.051)
            assert f"{round(abs(f - r))} s sooner" in v["text"] or abs(f - r) >= 60
        else:
            assert v["tone"] is None
    assert final["active"] == 0


def test_screen_reader_notes_once_per_arrival(run):
    _s, frames, _truth_, _cleared = run
    through = [tuple(n) for f in frames for n in f["notes"] if n[2] == "through"]
    assert len(through) == len(set(through)) == 4             # 2 vehicles x 2 grids, once each


def test_running_clocks_move_on_with_the_picture(run):
    """Shown 1.5 s after a frame, a vehicle's age is 1.5 s more (until it is through)."""
    _s, frames, _truth_, _cleared = run
    checked = 0
    for frame in frames:
        for trip in frame["trips"]:
            for name in ("rl", "ft"):
                t = trip[name]
                if t["where"] in ("queued", "driving"):
                    assert t["laterAge"] == pytest.approx(t["age"] + 1.5)
                    checked += 1
    assert checked > 20


def test_who_is_ahead_names_the_grid_where_it_is_further_along(run):
    """More junctions crossed is ahead; at the same junction, nearer the stop line, or already
    queued there rather than still driving to it, or (both driving) less of the link left.
    Nothing is said before it is on both grids or once it is through on either (the verdict
    says how that went)."""
    _s, frames, _truth_, _cleared = run
    name = {"rl": "RL Agent System", "ft": "Traditional System"}
    seen = []
    for frame in frames:
        for trip in frame["trips"]:
            r, f, ahead = trip["rl"], trip["ft"], trip["ahead"]
            if None in (r["where"], f["where"]) or "through" in (r["where"], f["where"]):
                assert ahead is None
                continue
            if r["leg"] != f["leg"]:
                expect = "rl" if r["leg"] > f["leg"] else "ft"
            elif r["where"] == f["where"] == "queued":
                expect = None if r["pos"] == f["pos"] else "rl" if r["pos"] < f["pos"] else "ft"
            elif r["where"] != f["where"]:
                expect = "rl" if r["where"] == "queued" else "ft"
            else:
                gap = abs(r["rem"] - f["rem"])
                expect = None if round(gap) < 1 else "rl" if r["rem"] < f["rem"] else "ft"
            assert ahead["who"] == expect, (trip["key"], r, f, ahead)
            if expect:
                assert ahead["text"].startswith(f"{name[expect]} is ahead · ")
            else:
                assert ahead["text"].startswith("Level · ")
            if r["leg"] != f["leg"]:
                assert "junction" in ahead["text"] and "further along (past J" in ahead["text"]
            seen.append(expect)
    assert len(seen) > 10 and "rl" in seen
