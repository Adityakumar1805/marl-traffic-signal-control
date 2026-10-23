# Changelog

## 1.0.0 — first release

Multi-agent deep reinforcement learning for adaptive traffic signal control on a 2 × 2 grid,
a reproducible benchmark against two baselines, and a live web dashboard that races the
learned policy against a fixed-time controller on identical traffic.

### Learning and control

- Four **Double + Dueling DQN** agents, one per junction, sharing one set of weights and one
  prioritized replay buffer; each observes 23 numbers (its queues and waits, its phase and
  green-so-far, four emergency flags, and its neighbours' pressures and phases), so the
  junctions coordinate without a central controller.
- A **safety finite-state machine** owns the lamps: minimum and maximum green, a mandatory
  3 s amber and 2 s all-red at every change; conflicting greens are unreachable states,
  tested over 18,000 randomised steps.
- **Emergency preemption** for ambulances, police cars and fire engines, forced through the
  same safety gate, with clearance time measured as a KPI.
- Baselines: an honest **fixed-time** plan (30 s per direction) and **max-pressure**.
- Curriculum training (`python run.py train`), with the trained checkpoint shipped in
  `models/pretrained/atsc_2x2.pt`.

### Simulation

- **SUMO** through TraCI when it is installed, and a **built-in point-queue simulator**
  behind the same interface when it is not; PyTorch, or a from-scratch **NumPy** dueling
  network that loads the same checkpoint.
- An Indian traffic mix of 18 vehicle types (cosmetic: it never changes the traffic or a
  published number), driving on the left.

### Benchmark

- 3 controllers × 4 demand levels × 3 seeds = **36 runs** (`python run.py eval`), written to
  `outputs/benchmark_results.csv`, `benchmark_summary.csv` / `.md` and the KPI plots. The RL
  agents cut waiting time by 15 % (light) to 61 % (rush hour) against fixed-time, and get an
  ambulance through up to 3.5× faster; max-pressure is better at low and medium demand,
  which the report states.
- CI reruns the benchmark on every push, with PyTorch and with the NumPy network, and fails
  if a single byte of the CSVs changes.

### Live dashboard (`python run.py demo`, or the hosted site)

- The same four junctions twice — *RL Agent System* and *Traditional Traffic System* — on
  the same arrivals, drawn from the simulator's own queues and links; the two maps fill the
  screen, each with its average wait and a status line, and the live result, a chart of the
  run and three tiles sit under them. The page opens at rush hour.
- **Send emergency vehicle** opens the choice of an ambulance, a police car or a fire engine,
  sent into both grids at once. Each one is followed on both maps (a pulsing ring, a label
  saying *Moving*, *Waiting* or *Not moving*, the light it waits at ringed, its route ahead
  dashed, a *Through* marker where it left), in the line above each map (status, reason and
  *Junction 1 of 2*), and in the tracker under the maps (which system has it further along,
  a progress bar per grid, the result once it is through both, and a timeline of every
  step).
- While an emergency vehicle is on the road the race plays in slow motion (0.2×) so it can
  be followed, and once it is through both grids the race pauses for 5 s on the result;
  choosing a speed, Play, Pause or Step takes over.
- Controls for traffic level, speed, pause, step and restart; keyboard shortcuts; a phone
  layout with both grids one under the other and the controls in a bottom bar.
- One shared session for every viewer, streamed over a WebSocket as compact deltas with
  keyframes, a polling fallback and a zero-dependency standard-library server; a service
  worker shows "Waking up the server…" while a sleeping free instance boots.

### Deployment and tests

- `render.yaml` (Render Blueprint, free plan), `asgi.py`, a pinned
  `requirements-deploy.txt` without torch, a `Dockerfile` and a `Procfile`;
  `docs/DEPLOYMENT.md` has the steps and a post-deploy checklist.
- 172 pytest tests (environment, safety, reward, replay, controllers, benchmark maths, wire
  protocol, servers, vehicles, page and emergency tracking), a Playwright browser check
  (`tools/e2e_browser.py`) and a server benchmark (`tools/bench_server.py`).
