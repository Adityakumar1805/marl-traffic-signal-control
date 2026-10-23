"""The emergency tracker's feed follows every emergency vehicle exactly.

The dashboard highlights each emergency vehicle on both grids and says, all the time, whether
it is moving, waiting (and why) or through. It reads that from three protocol fields - ``ed``
(the dispatches), ``ev`` (where each vehicle is) and ``evx`` (the vehicles that have left) -
so these tests pin all three to the simulator's real state, including the vehicles the
browser is never sent (deep in a long queue, behind the "+n" badge).
"""
import json
from pathlib import Path

import yaml

from atsc.dashboard.runtime import encode
from atsc.dashboard.session import KIND_CODE, DashboardSession
from atsc.sim.backend import APPROACHES
from atsc.sim.mini_backend import vehicle_number

from dashboard_model import Model

ROOT = Path(__file__).resolve().parents[1]


def _config(tmp_path, **dashboard):
    """config.yaml with dashboard overrides; the automatic slow motion and pause on a result
    are off (they are tested in test_dashboard_session.py)."""
    raw = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    raw.setdefault("dashboard", {}).update(
        {"emergency_slow_motion": 0, "emergency_result_pause_s": 0, **dashboard})
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    return str(path)


def _json(obj):
    return json.loads(encode(obj))


def _truth(runner):
    """Where every emergency vehicle is, read straight from the simulator's queues and links
    (independently of the code that builds ``ev``)."""
    backend = runner.env.backend
    ai_of = {(tls, a): j * 4 + k for j, tls in enumerate(runner.env.topo.order)
             for k, a in enumerate(APPROACHES)}
    out = {}
    for (tls, approach), q in backend._queues.items():
        for i, veh in enumerate(q):
            if veh.is_emergency:
                out[vehicle_number(veh.id)] = (0, ai_of[(tls, approach)], i + 1, len(q),
                                               veh.leg_index, len(veh.legs), veh)
    for veh, remaining, tls, approach in backend._transit:
        if veh.is_emergency:
            out[vehicle_number(veh.id)] = (1, ai_of[(tls, approach)], 0, 0,
                                           veh.leg_index, len(veh.legs), veh)
    return out


def _session(tmp_path, scenario="rush", **dashboard):
    s = DashboardSession(_config(tmp_path, keyframe_every_s=3600, **dashboard))
    s.set_scenario(scenario)
    s.play()
    for _ in range(10):                       # let the queues build up first
        s.tick()
    return s


def test_feed_matches_the_simulator_at_every_frame(tmp_path):
    s = _session(tmp_path)
    model = Model()
    model.apply(_json(s.hello()))
    s.submit({"a": "inject", "kind": "ambulance"})
    seen = {"rl": set(), "ft": set()}
    for _ in range(400):
        frame = s.tick()
        if frame is not None:
            model.apply(_json(frame))
        for name, runner in (("rl", s.rl), ("ft", s.ft)):
            truth = _truth(runner)
            feed = {e[0]: e for e in model.sides[name].ev}
            assert feed.keys() == truth.keys(), name
            now = runner.env.backend.time
            for vid, (where, ai, pos, qlen, leg, legs, veh) in truth.items():
                e = feed[vid]
                assert e[1] == KIND_CODE[veh.kind]
                assert e[2:8] == [where, ai, pos, qlen, leg, legs], (name, e)
                assert e[8] == round(veh.wait_time * 10)
                assert e[9] == round((now - veh.depart_time) * 10)
                seen[name].add("queued" if where == 0 else "driving")
        if seen["rl"] and not s.rl.active_emergencies() and not s.ft.active_emergencies():
            break
    # it was followed while it waited and while it drove, on both grids ...
    assert seen == {"rl": {"queued", "driving"}, "ft": {"queued", "driving"}}
    # ... and each grid reports the time it took to get through, exactly the backend's figure
    for name, runner in (("rl", s.rl), ("ft", s.ft)):
        assert model.sides[name].ev == []
        assert [[vid, kind] for vid, kind, _t in model.sides[name].evx] == \
               [[vehicle_number(i), KIND_CODE["ambulance"]] for i in runner.recorder.em_times]
        assert [t for _v, _k, t in model.sides[name].evx] == \
               [round(t * 10) for t in runner.recorder.em_times.values()]


def test_feed_knows_where_a_vehicle_the_browser_is_not_sent_is(tmp_path):
    """With only the first vehicle of each queue sent (``queue_render_cap: 1``), the browser
    cannot draw an ambulance that waits further back - the feed still gives its place."""
    s = _session(tmp_path, queue_render_cap=1)
    model = Model()
    model.apply(_json(s.hello()))
    s.submit({"a": "inject", "kind": "ambulance"})
    hidden = False
    for _ in range(300):
        frame = s.tick()
        if frame is not None:
            model.apply(_json(frame))
        for side in model.sides.values():
            for e in side.ev:
                if e[2] == 0 and e[4] > len(side.qk[e[3]]):    # queued beyond what is sent
                    hidden = True
                    assert e[4] <= side.q[e[3]] == e[5]          # ... and its place is real
        if hidden:
            break
    assert hidden, "the ambulance was never queued out of sight"


def test_dispatch_pairs_the_same_vehicle_and_gives_its_route(tmp_path):
    s = _session(tmp_path, scenario="medium")
    s.submit({"a": "inject", "kind": "ambulance"})            # east-west corridor
    s.submit({"a": "inject", "kind": "police"})               # north-south corridor
    frame = _json(s.tick())
    ed = frame["ed"]
    assert [d[2] for d in ed] == [KIND_CODE["ambulance"], KIND_CODE["police"]]
    j = {tls: i for i, tls in enumerate(s.rl.env.topo.order)}
    west, north = APPROACHES.index("W"), APPROACHES.index("N")
    # the ambulance crosses the middle row from the west, the police car the middle column
    assert ed[0][4] == [j["J1_0"] * 4 + west, j["J1_1"] * 4 + west]
    assert ed[1][4] == [j["J0_1"] * 4 + north, j["J1_1"] * 4 + north]
    for rl_id, ft_id, kind, t10, route in ed:
        assert t10 == round(frame["bt"] * 10) - round(s.cfg.signal.decision_interval_s * 10)
        assert rl_id in {e[0] for e in frame["rl"]["ev"]}
        assert ft_id in {e[0] for e in frame["ft"]["ev"]}
        for side in ("rl", "ft"):
            e = next(e for e in frame[side]["ev"] if e[0] == (rl_id if side == "rl" else ft_id))
            assert e[7] == len(route) and e[1] == kind


def test_a_new_episode_starts_with_an_empty_history(tmp_path):
    s = _session(tmp_path, scenario="medium")
    s.submit({"a": "inject", "kind": "fire"})
    s.tick()
    assert s.snapshot()["ed"] and s.snapshot()["rl"]["ev"]
    s.submit({"a": "reset"})
    frame = s.tick()
    assert frame["kf"] == 1
    assert frame["ed"] == [] and frame["rl"]["ev"] == [] and frame["ft"]["evx"] == []


def test_tracking_four_vehicles_keeps_frames_small(tmp_path):
    s = _session(tmp_path)
    s.submit({"a": "speed", "v": 8})
    for kind in ("ambulance", "police", "fire", "ambulance"):
        s.submit({"a": "inject", "kind": kind})
    sizes = []
    for _ in range(30):
        frame = s.tick()
        if frame is not None and not frame.get("kf"):
            sizes.append(len(encode(frame)))
    assert sizes and max(sizes) < 10000 and sum(sizes) / len(sizes) < 6000
