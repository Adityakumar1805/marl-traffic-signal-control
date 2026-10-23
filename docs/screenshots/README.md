# Screenshots

The stills and the animation in the top-level README, taken from the live page. The
benchmark plots are not copied here: the README shows them straight from `outputs/`, where
`python run.py eval` writes them.

| File | Shows |
|---|---|
| `dashboard_demo.gif` | the animation at the top of the README: rush hour, one ambulance chosen from the emergency menu and sent into both grids; the page plays in its automatic slow motion (0.2×) until the ambulance is through and then pauses on the result. It gets through the RL Agent System in 35 simulated seconds and through the traditional system in 136 (1:41 sooner, 3.9× faster). Cropped to the header, the controls, both grids and the tracker, and played 2.5× faster than recorded. Recorded with `python tools/record_gif.py` (headless Chromium + ffmpeg) |
| `dashboard_desktop.png` | the whole page on a 1440-pixel-wide screen, paused on the result of an emergency test: the header and controls, both grids with their status lines, the tracker, the live result, the chart and the tiles |
| `network_render_ambulance.png` | both grids a few seconds after an ambulance was sent: on the RL grid it has crossed J1_0 and is circled on its way to J1_1 (*Junction 2 of 2*), the light ahead ringed and its route dashed; on the traditional grid it waits 18th in line at J1_0, too far back to be drawn, so a dashed ring marks that queue's `+12` badge |
| `emergency_result.png` | the tracker once the same ambulance is through both grids: "RL Agent System got it through 3.5× faster · 1:45 sooner", 0:42 against 2:27 |
| `emergency_timeline.png` | its timeline on both grids: sent, waiting at J1_0 and how far back, green requested, green light, crossed J1_0, waiting at J1_1, crossed J1_1, out of the grid |
| `dashboard_phone.png` | the first screen on a 390 × 844 phone during the same test: the live status (slow motion), the RL grid with its status line, the start of the traditional grid under it, and the controls in the bottom bar |

The live result describes the run on screen (one seed, still running), so it differs from
the three-seed benchmark in `outputs/benchmark_summary.md` that the line under it quotes.

To refresh the stills, run `python run.py demo` and take screenshots, or run
`python tools/e2e_browser.py --local`, which saves desktop, laptop, phone and wake-screen
captures in `outputs/e2e/`. To refresh the animation, run `python tools/record_gif.py`; pass
`--python` a venv made from `requirements-deploy.txt` to record the hosted stack.
