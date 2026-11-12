# Compute and Scan responsiveness (task D1)

_12 November 2026. A measurement record, not current product guidance. It answers task D1 of the [Isomar implementation plan](2026-11-11-isomar-implementation-plan.md): how long do Compute and the computed departure scan block the page, and is a cancellable Web Worker needed before D2 (refinement pass) and D3 (limits in the router) add work to that path._

**No physical device was measured.** The numbers below come from a desktop CPU, a Node process and desktop Chromium with CPU throttling. Local measurements, the throttled-desktop stand-in for a phone, and the conclusion are kept in separate sections. The harness, the commands to repeat it and the steps for a real phone are at the end.

## Answer in short

- **Compute** blocks the page for 0.09 to 0.9 s on a throttled desktop (0 to 0.14 s unthrottled), longer than the 50 ms and 100 ms thresholds but never a multi-second freeze. With a prepared current grid in play it can reach 1.3 s at 4× throttling. It does not need a Worker by itself.
- **The scan** blocks the page in one piece, with no repaint and no response to a tap, for 2.2 s (a 20 nm hop) to 8.4 s (a 321 nm leg) on the unthrottled desktop, and for 13 to 51 s at 6× throttling. Its "n/21" progress counter is never painted. The scan exceeds every threshold at every level, including unthrottled.
- **Most of the scan is the audit, not the routing.** The 21 audits take 80 to 95 % of the time in Node; routing takes 5 to 20 %.
- **Recommendation:** put the scan in a cancellable Worker before D2 and D3. D2 would add 4 to 16 candidates (19 to 76 % more work). Details and what would change this are in [Conclusion](#conclusion-and-recommendation).

## What runs on the main thread

Everything below runs in the page's thread (`viewer/src/pages/planner/usePlannerController.jsx`):

- **Compute (`runRouting`).** `loadRoutingInputs` (land mask window, tile reads, wind and current mosaics, and for Compute the prepared current grid with a content digest of it), then `routeOnOneCurrent` → `selectRoutingCurrent` → `computeRoute`, once. No `await` inside the routing.
- **Scan (`runScan`).** `prepareAnalysisInputs`, `loadRoutingInputs(scanning)`, then `routeOnOneCurrent` routes all 21 candidates (`computeRoute` each) in one synchronous loop. `scanDepartures` then audits each route with `runAnalysis`. Once the tiles are decoded, the audit's `await`s resolve as microtasks only, so no task boundary falls between candidates. The `scanning departures n/21` progress string is set inside that loop, so the page never gets to render it. There is no cancel.
- **Double routing (commit 4a7fc03).** With a prepared grid, every departure is first routed in strict mode on that grid. A gap in space or time (`CurrentGapError`) or a failed coverage test sends the whole action to tile currents and routes again. A prepared grid reaches about 120 h from its fetch, so a real 120 h scan is rejected before any strict routing (the reason recorded is "prepared grid does not cover every departure time"). The worst case needs a prepared axis that holds every departure and runs out in the last candidate's search.

### Input sizes (from the code, then reproduced by the harness)

| Input | Value |
|---|---|
| Router graph | the whole wind-grid box (`routeBbox`: route box plus a pad of at least 0.5° or 25 % of the span), at `max(0.02°, extent / 150)` per step, so at most about 150 × 150 nodes; 16 neighbours per node; land mask checked every ~0.4 nm along each edge |
| Router horizon | `passageMaxHours` = clamp(distance / 4 kt, 48, 240) h |
| Time step of the wind grid | GFS hourly to 120 h, then 3-hourly (161 steps in the layer); Compute reads `maxHours + 6` h, a scan reads `120 + maxHours + 6` h |
| Wind grid (0.25°, ≤ 4,000 lattice points) | 5×6 to 29×21 points; 55 to 142 time steps |
| Tile current grid (GLO12, 1/12°, 6-hourly) | 13×18 to 43×32 points; 10 to 36 time steps |
| Prepared current grid (factory, IBI stride 2, hourly, 121 steps) | for example 24×69×121 in the committed `data/processed/runs/`; the harness uses 31×39 to 65×50 |
| Scan | `candidateDepartures(departure, 120, 6)`: 21 candidates when the departure is on the 6 h grid (20 otherwise); one assessment window for all of them |
| Audit layers per candidate | deterministic GFS, ECMWF, 31-member ensemble, waves, hazards, current grid |

**What drives cost.** Routing cost grows with the number of settled nodes: about (distance / graph step)², and so with distance until the 150-node cap bites (487 nodes for 20 nm, 4,000 for 63 nm, 5,700 for 77 nm with land, 11,800 for 321 nm), times the 16 edges, times the land check, times the number of departures (21, or 41 in the worst double-routing case). Audit cost grows with the assessment window (the scan widens every candidate's window to cover all 21), the 31 ensemble members, the number of route points and the size of the current grid, and is spent mostly in hashing (below).

## Method

### Node benchmark (no browser)

`engine/scripts/bench-routing-scan.ts` calls the functions the controller calls, on a real `TileForecastStore` reading in-memory PFT1 tiles (weather, ECMWF, ensemble, waves, GLO12 currents, built with the sizes and time axes of `docs/forecast-tile-format.md`), the real coastline mask (`viewer/public/data/land`), and an invented, formula-built polar (no polar data, `npm run check:polars` still passes). Wind and tide are synthetic functions of position and time, chosen so that courses change (a wind veering and backing between 130° and 230°, a tidal stream of up to 2.5 kt in the Channel). One run is: fresh store, Compute, scan (audit layers decode on the way), the scan again with everything decoded. Five runs per case (three for the prepared-grid variants). Wall-clock milliseconds on one machine; "longest block" is the longest gap between two turns of the Node event loop.

| Passage (invented weather, real coastline) | Distance | Notes |
|---|---|---|
| `coastal-20nm` Cherbourg offing → Barfleur offing | 20.7 nm | short |
| `channel-63nm` Barfleur offing → Weymouth Bay offing | 62.7 nm | tide along the track |
| `channel-adverse-63nm` same, plus a steady 1.5 kt current against | 62.7 nm | adverse current |
| `land-77nm` Start Point offing → Poole offing | 76.9 nm | the straight line crosses Portland; the route goes round it |
| `biscay-321nm` A Coruña offing → Brest offing | 321 nm | open water, large router box, `maxHours` 81 |

### Browser measurement

`viewer/e2e/perf/scan-responsiveness.perf.js` (own config `viewer/playwright.perf.config.js`, own npm script; the normal `npm run test:e2e` neither runs nor lists it) drives the planner's real Compute and Scan buttons in a Pixel 7 emulation of desktop Chromium, on the **production build** of the viewer (React in production mode), against static synthetic files served locally (the same tiles as the Node benchmark; the boat polar answers `/api/polars/invented-cruiser`). The coastline mask is the real one from the build. The clock is fixed (Playwright), a fresh browser context per run (empty tile cache, nothing decoded), Compute then Scan in the same page as a visitor would. Throttling is `Emulation.setCPUThrottlingRate` at 1×, 4× and 6×. An in-page probe (`viewer/e2e/perf/probe.js`, installed before the page loads; it changes nothing in the app) records:

- long tasks (`PerformanceObserver` `longtask`, tasks over 50 ms) and a 10 ms timer-lag sampler as a cross-check;
- every `requestAnimationFrame` (frame count and gaps over 50 ms) and the text of the status line under the buttons at each frame: the first visible progress and whether it ever changes during a block;
- Event Timing for taps (`processingStart − startTime`). A transparent 56 px pad fixed in the bottom-right corner, outside the app, is tapped every 250 ms during the run, so a tap can never reach the planner or the map; Chrome stamps CDP-injected touches when they are handled, so the delay is read from Event Timing, which lists events delayed 16 ms or more;
- time from the click to the painted result (the result text, then the next frame).

Network time is local and excluded in effect: the tile files come from a local static server. The ranges below are the observed spread over two to three runs per cell; they differ by 1 to 4 %.

**Machine and browser.** AMD Ryzen 7 7735HS (16 threads), Linux 7.0.0-43, Node v24.22.3, Chromium 149.0.7827.55 (Playwright 1.61.1, headless). Throttle factors are relative to this CPU.

**Which factor is the "low-end phone".** I take **6×** as the low-end phone and 4× as a mid-range one. Chrome DevTools labels 4× "mid-tier mobile" and 6× "low-tier mobile", and Lighthouse's mobile preset uses 4×. This is a convention, not a measurement of any phone. A recent flagship is probably faster than 4×; a budget phone with a three-year-old CPU may be slower than 6×.

**Thresholds** (common web-performance guidance, quoted from memory and not re-checked online):

| Threshold | Source | Meaning here |
|---|---|---|
| 50 ms | W3C Long Tasks API definition | a task this long is a "long task" |
| 100 ms | RAIL: respond to input within 100 ms | a tap should act or visibly react within it. INP "good" is ≤ 200 ms, "poor" > 500 ms |
| 1 s | RAIL: a 1 s task loses the user's flow | stand-in for "the page is frozen" |
| several seconds, no repaint, no progress | the task plan's own wording | the case the Worker question is about |

## Results

### Node (engine cost, desktop, milliseconds, median of 5 runs; worst in brackets where it differs by more than 5 %)

| Passage | Compute: tiles+grids (cold) | Compute: `computeRoute` | Scan routing (21 routes) | Scan audit (21 audits) | Scan total | Audit share |
|---|---|---|---|---|---|---|
| coastal 20.7 nm | 175 (223) | 11 (20) | 150 | 2,809 to 2,927 | 2,960 to 3,076 | 95 % |
| channel 62.7 nm | 168 (182) | 59 (77) | 859 | 4,281 to 4,439 | 5,152 to 5,303 | 83 % |
| channel, adverse current | 161 | 58 | 935 | 4,473 to 4,614 | 5,420 to 5,547 | 83 % |
| land 76.9 nm | 170 | 71 | 1,088 | 6,055 to 6,124 | 7,160 to 7,215 | 85 % |
| Biscay 321 nm | 90 (106) | 179 (200) | 2,973 | 11,841 to 11,874 | 14,836 to 14,861 | 80 % |

The first figure of a range is the second scan on a warm store, the second the first scan; the difference is small because decoding the audit layers is cheap next to the audits. The longest event-loop block in the scan equals its routing time and its audit time separately: **the audit loop is one uninterrupted block** (4.3 s for the Channel, 11.8 s for Biscay). An adverse current costs about 9 % more routing (it settles more nodes: 4,344 against 4,009). Land did not show up as a cost of its own: `computeRoute` took 12 to 15 µs per settled node on the land, Channel and Biscay passages alike (22 µs on the 487-node hop, where warm-up counts); the longer routes cost more because they settle more nodes. Per candidate, routing takes 7 to 140 ms and the audit 135 to 565 ms.

**Where the audit time goes.** One warm audit of one candidate takes 145, 254, 320 and 519 ms (coastal, channel, land, Biscay). Without a current grid it takes 109, 162, 215 and 244 ms, so the tile current grid accounts for 25, 36, 33 and 53 % of the audit. A CPU profile of 20 warm Channel audits put about 55 to 60 % of their time in `contentHash` (`assembleFindings` hashes the whole decision input, ensemble member series included, and `decisionInputs` hashes the current grid again), and about 30 % in `resampleToHourly` for the 31 ensemble members. One run, indicative only. See [Adjacent findings](#adjacent-findings).

**Prepared current grid and double routing (Node, 3 runs).**

| Passage | Compute, prepared grid covers the box (1 route) | Compute, prepared grid too small (gap, then tiles: 2 route calls) | Scan routing, a real prepared grid (rejected up front, 21 calls) | Scan routing, worst case double route | Calls |
|---|---|---|---|---|---|
| coastal | 204 | 18 | 254 | 374 | 42 |
| channel | 397 | 84 | 1,026 | 1,805 | 41 |
| channel, adverse | 415 | 89 | 1,106 | 1,956 | 41 |
| land | 469 | 106 | 1,290 | 2,257 | 40 |
| Biscay | 675 | 297 | 3,325 | 4,719 | 31 |

For reference, single-source routing was 11/59/58/71/179 ms for Compute and 150/859/935/1,088/2,973 ms for the scan. The prepared-grid figures include the content digest of the grid, which is taken once when the prepared file is loaded and dominates Compute with a covering grid (about 0.2 to 0.5 s of the 0.2 to 0.7 s for a grid of 31×39×121 to 65×50×121 points). The worst case adds one full routing pass minus the candidates that fail early: +0.2 s (coastal), +0.9 s (Channel), +1.2 s (land), +1.7 s (Biscay), which is 25 to 90 % more routing but only 4 to 12 % more scan time, because the audit dominates.

### Browser (production build, Pixel 7 emulation, medians over 2 to 3 runs; worst in brackets)

**Compute (tile currents).** "Longest block" is the longest long task. "Tap delay" is the largest input delay of a tap during the run.

| Passage | Throttle | Click to result | Longest block | Tap delay (max) |
|---|---|---|---|---|
| coastal 20.7 nm | 1× | 0.34 s | none over 50 ms | under 16 ms |
| | 4× | 1.11 s | 0.09 s | 0.11 to 0.18 s |
| | 6× | 1.71 s | 0.12 s | 0.11 s |
| channel 62.7 nm | 1× | 0.38 s | 0.06 s | under 16 ms |
| | 4× | 1.30 s | 0.22 s | 0.20 s |
| | 6× | 1.93 s | 0.31 s (0.32) | 0.33 to 0.34 s |
| Biscay 321 nm | 1× | 0.37 s | 0.14 s | 0.09 to 0.10 s |
| | 4× | 1.37 s | 0.57 s | 0.37 to 0.55 s |
| | 6× | 2.08 s (2.14) | 0.87 s | 0.71 to 0.75 s |

The first progress text (a "Finding the best route…" or "Loading…" line) is painted 40 to 130 ms after the click at every level, and the status line changes four to six times before the result. Compute never leaves a gap between frames of more than 0.18 s unthrottled or 1.2 s at 6×.

**Compute with a prepared current grid (Channel; covering grid 41×52×131 points, running-out grid 41×52×124, small grid 16×27×121; 1× and 4×).** The prepared grid's content digest runs in one task: longest block 0.35 s at 1× and 1.28 s at 4× for a covering grid (0.33 s and 1.25 s for one that runs out, 0.09 s and 0.34 s for one too small for the router, which falls back to tiles). Against 0.06 s and 0.22 s without a prepared grid. At 6× this would be about 1.9 s (extrapolated, not measured).

**Scan (21 candidates, tile currents).**

| Passage | Throttle | Click to result | Longest block (one task) | Sum of long tasks | Largest tap delay | Frames in the run | Longest gap between frames |
|---|---|---|---|---|---|---|---|
| coastal 20.7 nm | 1× | 2.7 s | 2.17 s | 2.17 s | 2.0 s | 8 to 10 | 2.2 s |
| | 4× | 10.9 s (11.0) | 8.77 s | 8.77 s | 8.7 s | 4 to 7 | 9.2 s |
| | 6× | 16.6 s (16.8) | 13.3 s | 13.3 s | 13.1 s | 6 | 14.2 s |
| channel 62.7 nm | 1× | 4.4 s | 3.10 s | 3.13 s | 3.1 s | 6 | 3.1 s |
| | 4× | 17.6 s | 12.4 s | 12.6 s | 12.2 s | 6 | 13.6 s |
| | 6× | 27.0 s (27.4) | 18.9 s | 19.2 s | 18.8 s | 5 to 6 | 20.7 s |
| Biscay 321 nm | 1× | 11.5 s | 8.38 s | 8.45 s | 8.3 s | 4 to 5 | 8.7 s |
| | 4× | 47.0 s | 33.8 s | 34.2 s | 33.7 s | 5 to 6 | 35.3 s |
| | 6× | 71.0 s (73.3) | 50.8 s | 51.3 s | 50.7 s | 5 to 6 | 53.2 s |

- **One block.** The block is one task of the scan from the end of the routing inputs to the result: 70 to 80 % of the click-to-result time. The remaining 20 to 30 % is made of tasks under 50 ms (reading and decoding tiles, loading prepared data), during which the page still takes input.
- **A tap waits for the whole block.** The largest tap delay equals the block within 1 to 3 %. The page never acts on a tap during the run.
- **Progress.** The status line paints "Loading the forecast charts…" and then "Comparing departure times…" once, before the block (0.2 s after the click for the coastal hop and 2.2 s for Biscay unthrottled, 1.2 to 13 s at 6×, as the preceding tile reads take longer), and nothing during the block. The "n/21" counter is never painted. At 4× on Biscay the "Comparing departure times…" text was never painted at all: the line showed "Loading the forecast charts…" until the result.
- **Scaling.** The block scales with the throttle factor almost exactly (×4.04 and ×6.1), so the unthrottled figure times the factor predicts it.
- **Browser against Node.** The same scan took 0.57 to 0.73 times as long in Chromium as in Node (block 2.17, 3.1, 8.4 s against 2.96, 5.15, 14.8 s). The Node figures are therefore an upper bound for the browser's engine cost on this machine; I did not investigate why.
- **Prepared current grid, Channel.** A covering or running-out prepared grid left the scan block at 3.06 to 3.09 s (1×) and 12.2 to 12.5 s (4×), the same as tiles. Total time was 1 s longer at 1× (5.3 to 5.4 s against 4.4 s) for loading and hashing the prepared file. A browser scan did not show the extra routing pass that Node showed for a forced double route; I did not establish which path the browser scan took (the page does not expose it), so the double-routing cost rests on the Node figures above.

## What this does not measure

- **No device.** A throttled desktop CPU is a stand-in. It does not reproduce a phone's memory limits and garbage collection, thermal throttling over repeated scans, the mobile browser's scheduler, background tab limits, battery saver, or the difference in cache, memory bandwidth and JIT between an ARM phone core and a slowed Ryzen core. 6× is a convention. **No device was measured and none is claimed.**
- **Real tiles and network.** The tiles are synthetic and small (10 tiles, 3.8 MB compressed): their decode work follows the real dimensions, but their size on the wire and the time to fetch them do not. Everything is served from localhost. A cold real visit adds network time that is not on the main thread.
- **Real inputs missing from the audit.** No tides, gates, synoptic features, warnings or route-zone files were served (they 404, as in a deployment without them). A real audit has a little more to do.
- **Cold device caches.** Each run starts with an empty IndexedDB tile cache; a warm cache changes the preparatory 20 to 30 %, not the block.
- **The prepared-grid double route in the browser** (above), a scan from a drawn route (no routing, 21 audits), Check, and the other pages.
- **Taps** are synthetic touches on a pad outside the app, not a tap on a real control; the delay they measure is the main thread's, not a control's handler.
- **Hosted environments.** Nothing was checked against the live site, production tiles or the deployed build.

## Conclusion and recommendation

Everything in this section is a reading of the numbers above, not a measurement of its own.

### Against the thresholds (browser, tile currents)

| | 1× (this desktop) | 4× (mid-range phone, convention) | 6× (low-end phone, convention) |
|---|---|---|---|
| **Compute, longest block** | 0 to 0.14 s: over 50 ms for Channel and Biscay, over 100 ms for Biscay | 0.09 / 0.22 / 0.57 s: over 100 ms for Channel and Biscay | 0.12 / 0.31 / 0.87 s: over 100 ms for all three |
| **Compute, over 1 s?** | no | no (1.28 s with a covering prepared grid) | no for tiles; about 1.9 s expected with a prepared grid (extrapolated) |
| **Scan, longest block** | 2.2 / 3.1 / 8.4 s | 8.8 / 12.4 / 33.8 s | 13.3 / 18.9 / 50.8 s |
| **Scan, repaint and tap** | none for the whole block | none | none |

- **Compute** blocks beyond the 50 ms and 100 ms thresholds at 4× and 6× on every passage but the shortest, by up to 0.87 s, which is a pause the user will notice, not a freeze. It does not need a Worker to be usable. With a prepared grid the digest can push it past 1 s on a slow phone.
- **The scan** blocks beyond every threshold at every level, including unthrottled. At 6×, a 20 nm hop freezes the page for 13 s and a Biscay leg for 51 s, with no repaint, no response to a tap and a progress line that stopped before the block began. A user would reasonably conclude the page hung.

### D2 and double routing

- **D2** (`refineScan`: every 2 h within 6 h either side of the best and tied times) adds departures at ±2 h and ±4 h of each anchor; ±6 h are already on the 6 h grid. One anchor adds 4 candidates; adjacent tied anchors share some (k adjacent anchors add 2k + 2); separated anchors add 4 each; times at the ends of the scan span are clamped. Expect **4 to 10 extra candidates in the usual case and up to 16 with several separated ties**: +19 % to +76 % of a scan's candidates. At the browser's per-candidate cost (the scan's block divided by 21: 0.10, 0.15, 0.40 s at 1×; 0.63, 0.90, 2.4 s at 6× for coastal, Channel, Biscay), that is:

| Extra candidates | coastal, 1× / 6× | channel, 1× / 6× | Biscay, 1× / 6× |
|---|---|---|---|
| 4 | 0.4 s / 2.5 s | 0.6 s / 3.6 s | 1.6 s / 9.7 s |
| 10 | 1.0 s / 6.3 s | 1.5 s / 9.0 s | 4.0 s / 24 s |
| 16 | 1.7 s / 10 s | 2.4 s / 14 s | 6.4 s / 39 s |

  D2 is specified as an explicit second action. It is therefore a second block of that length, not a longer first one, and every figure in the table is past the 1 s threshold on a low-end phone.
- **Double routing** adds, in Node, up to one full routing pass: +0.2, +0.9, +1.2, +1.7 s on the four passages above (about 0.6 of that in the browser), times 6 at 6× throttling, so up to about +6 s of block for a 321 nm scan at 6×, only when the prepared grid holds every departure and runs out late. Today a real prepared grid is rejected up front for a 120 h scan, so the present cost is the prepared grid's one-off digest (0.1 to 0.35 s in Node). Compute's double route costs at most one routing pass (≤ 0.2 s in Node, about 0.7 s at 6× for Biscay) and its prepared-grid digest is the bigger part (above). If prepared grids get a longer horizon, double routing becomes the scan's second-largest cost after the audit.
- **D3** adds per-edge work to `computeRoute` only. The router is 5 % (coastal) to 20 % (Biscay) of the scan and all of Compute's blocking, so a router twice as expensive would make Compute 6× Biscay block about 1.7 s and a scan 5 to 20 % longer. D3 is not measurable before it exists.

### Recommendation

**Yes: a cancellable Worker for the scan (routing and audits together) should come before D2 and D3.** Reasons, in order of weight:

1. The scan already freezes the page for 2 s unthrottled and for 13 s or more on a throttled low-end stand-in, on every passage tried. D2 would add a second such block.
2. Cheaper measures do not remove the freeze. Yielding between candidates would restore repaint, the "n/21" counter and a cancel point between candidates, but one candidate on the 6× stand-in takes 0.6 s (coastal) to 2.4 s (Biscay), still past 100 ms and mostly spent in the audit, which cannot be split without a Worker.
3. The engine is DOM-free, and its tile store already reads through `fetch`, IndexedDB and `DecompressionStream`, all available in a Worker; I did not check how the shared `forecastStore()` singleton would split across threads and this record does not design the Worker.
4. Compute alone does not justify a Worker; if the Worker takes the scan's routing it may as well take Compute's.

**What would change this.**
- A real-phone measurement of the scan under 1 s (unlikely: it would need a phone about as fast as this desktop at 2 to 3×, which this record does not support).
- A change to the scan itself, such as a coarser candidate grid (12 h steps halve it: 13 s becomes 6.6 s at 6×, still frozen) or a cached digest of the audit inputs (see below). The audit-input hashing is the largest single saving I found, about 55 to 60 % of an audit's time in one profile, but even removing all of it leaves the 20 nm scan at about 6 s and Biscay at about 28 s at 6×, still a freeze.
- An owner decision that a scan may freeze behind a blocking "Comparing…" screen, as an interim step.

## Adjacent findings

Recorded, not fixed (this task changes no product behaviour).

1. **Audit hashing.** `assembleFindings` calls `contentHash(decisionInputs(options))` per candidate, and `decisionInputs` also calls `contentHash` on the whole tile current grid (`engine/src/identity.ts`, `engine/src/findings.ts`). Per candidate this hashes every forecast series read, 31 ensemble members included, and the current grid twice. A cached or shared digest of the inputs that are identical across candidates would shrink the audit; it would not remove the freeze.
2. **A scan's progress is never shown.** `setBusy('scanning departures n/21')` runs inside a block that React cannot render in. The status line therefore keeps its last painted text (at times "Loading the forecast charts…").
3. **A computed passage can fail to route when the last short hop into the finish point is within the no-go cone**, even though the finish is open water (seen with an invented finish of 50.60°N 1.95°W: "No route found within 48 h"; moving it 0.02° made it route). Not investigated.
4. **Prepared grid digest.** `loadPreparedCurrent` hashes the prepared document when it loads, and `selectRoutingCurrent` hashes it again if it is not frozen. About 0.3 s of one task unthrottled at 1× for a 41×52×131 grid (Node 0.34 s).

## Repeat it

All commands run from the repository root. The harness lives in `engine/scripts/` and `viewer/e2e/perf/`, writes only to `output/perf/` (git-ignored), needs no network and no polar service, and is not run by `npm test` or `npm run test:e2e`. Never run it at the same time as vitest or the e2e suite; Playwright uses port 5194 (`PASSAGE_PERF_PORT` or `PASSAGE_E2E_PORT` to change it) and starts no other server.

```bash
npm run perf:node        # Node benchmark, 5 runs per case; JSON to output/perf/node.json. About 14 minutes.
                         #   or: npm run bench:routing -w engine -- --runs 3 --only channel-63nm
npm run perf:prepare     # engine build + production viewer build to output/perf/viewer-dist + synthetic files in output/perf/fixtures
npm run perf:browser     # the browser measurement; JSON to output/perf/browser.json. About 9 minutes for the default matrix.
#   PERF_PASSAGES=channel-63nm PERF_RATES=1,6 PERF_RUNS=2 npm run perf:browser
#   PERF_PASSAGES=channel-63nm PERF_VARIANTS=prepared-covering,prepared-runs-out,prepared-small PERF_RATES=1,4 npm run perf:browser
```

Run the Node and the browser measurements one after the other, not together: they time CPU work.

## Measuring on a real phone

Not done. No phone was available and none was measured. These steps need no product change and no public deployment; the page is served from the desktop to the phone over USB. I verified the console steps (4 to 6) on desktop Chromium; the USB steps (1 to 3) follow Chrome's documented remote-debugging feature and were not tried.

1. **Prepare on the desktop, on the real clock** (a phone's clock cannot be fixed): `npm run perf:prepare`, then `npm run perf:fixtures -w engine -- --live` (writes `output/perf/fixtures-live`, a forecast cycle dated today). Regenerate it on the day of each measurement.
2. **Serve**: `PASSAGE_PERF_FIXTURES=fixtures-live npm run perf:serve` (listens on 127.0.0.1:5194 only).
3. **Connect the phone**: enable USB debugging, plug it in, and run `adb reverse tcp:5194 tcp:5194` (or, in desktop Chrome at `chrome://inspect#devices`, add a port-forwarding rule 5194 → `localhost:5194`). Open `http://localhost:5194/#plan` in Chrome on the phone (a localhost page is a secure context, so IndexedDB and `DecompressionStream` behave as in production). On the desktop open `chrome://inspect#devices` and click "inspect" on that tab to get its DevTools console.
4. **Seed and install the probe** in that console (replace the passage id with `coastal-20nm`, `channel-63nm` or `biscay-321nm`):
   ```js
   const install = () => fetch('/probe.js').then(r => r.text()).then(t => (0, eval)(t));
   await install(); __perfSeed(await (await fetch('/meta.json')).json(), 'channel-63nm'); location.reload();
   ```
   After the reload, run `await install();` again.
5. **Compute**: `__perfArm('compute', 'Weather-routed')`, tap **Compute route** on the phone, wait for the route, then `copy(JSON.stringify(__perfSummary('compute'), null, 1))` and paste the result somewhere.
6. **Scan**: `__perfArm('scan', 'Departure comparison ready')`, tap **Compare departure times (next 5 days)**. While it runs, tap the faint square at the bottom-right corner of the screen every second or two (it is outside the app and does nothing else). When the comparison appears, `copy(JSON.stringify(__perfSummary('scan'), null, 1))`. `taps.delaysMs` lists the delays of the taps that waited 16 ms or more; `longTasks.longestMs` is the block.
7. **Repeat three times per passage** with the site data cleared between runs (DevTools Application → Clear storage), and once more back to back to see thermal throttling. Note the phone model, Chrome version, battery saver (off) and whether it was charging. Report these as device measurements, separately from this record's numbers.

## Files

- `engine/scripts/perf/scenarios.ts` (passages, synthetic weather, tiles, prepared grids), `engine/scripts/perf/prepare-fixtures.ts`, `engine/scripts/bench-routing-scan.ts`
- `viewer/e2e/perf/scan-responsiveness.perf.js`, `probe.js`, `serve.js`, `viewer/playwright.perf.config.js`
- npm scripts `perf:node`, `perf:prepare`, `perf:browser`, `perf:serve` (root), `bench:routing`, `perf:fixtures` (engine), `perf:build`, `test:perf` (viewer)
