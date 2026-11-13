# Compute and Scan responsiveness (task D1)

_12 November 2026. A measurement record, not current product guidance. It answers task D1 of the [Isomar implementation plan](2026-11-11-isomar-implementation-plan.md): how long do Compute and the computed departure scan block the page, and is a cancellable Web Worker needed before D2 (refinement pass) and D3 (limits in the router) add work to that path._

**No physical device was measured.** The numbers below come from a desktop CPU, a Node process and desktop Chromium with CPU throttling. Local measurements, the throttled-desktop stand-in for a phone, and the conclusion are kept in separate sections. The harness, the commands to repeat it and the steps for a real phone are at the end. _Added later the same day: one mid-range phone was then measured; see [Measured on a real phone](#measured-on-a-real-phone). A low-end phone was not._

## Answer in short

- **Compute** blocks the page for 0.09 to 0.9 s on a throttled desktop (0 to 0.14 s unthrottled), longer than the 50 ms and 100 ms thresholds but never a multi-second freeze. With a prepared current grid in play it can reach 1.3 s at 4× throttling. It does not need a Worker by itself.
- **The scan** blocks the page in one piece, with no repaint and no response to a tap, for 2.2 s (a 20 nm hop) to 8.4 s (a 321 nm leg) on the unthrottled desktop, and for 13 to 51 s at 6× throttling. Its "n/21" progress counter is never painted. The scan exceeds every threshold at every level, including unthrottled.
- **Most of the scan is the audit, not the routing.** The 21 audits take 80 to 95 % of the time in Node; routing takes 5 to 20 %.
- **Recommendation:** put the scan in a cancellable Worker before D2 and D3. D2 would add 4 to 16 candidates (19 to 76 % more work). Details and what would change this are in [Conclusion](#conclusion-and-recommendation).
- **On a real phone** (Galaxy A53, mid-range, unthrottled), a scan blocked the page for 4.1 s (20 nm), 6.0 s (Channel) and 21 s (Biscay) before the hashing change and 2.0, 2.3 and 6.7 s after it (−52 to −68 %), still with no repaint and no response to a tap. The phone behaves like about 2× desktop throttling, so the 4× and 6× rows overstate it. A low-end phone was not measured. See [Measured on a real phone](#measured-on-a-real-phone).
- **Later the same day** a scan stopped hashing its candidates' saved identity: its block fell by 65 to 69 % (Channel 6.6 s and Biscay 15.6 s at 6×), and it still freezes the page. See [After the hashing change](#after-the-hashing-change).
- **That evening the scan moved to a cancellable Web Worker.** During a scan the page's longest task is now 58 ms at 6× and none over 50 ms at 1× and 2×, against 1.0 to 19 s before. The page paints 76 to 360 frames per scan, against 4 to 10, and the status line counts the routed and then the compared departures. A tap waited at most 24 ms at 1× and 2× and 119 ms at 6×. The comparison is unchanged. The long task right after the tap on the phone was the routing of the 21 candidates; desktop Chromium's long-task observer had not reported it. Desktop measurement only. See [After the Worker](#after-the-worker).
- **On 13 November the prepared current grid got cheaper** (code only, nothing published): it is hashed once per load instead of twice, and FNV-1a runs on 16-bit limbs with identical digests. Node, desktop: Compute on today's live grid 0.33 → 0.16 s, a Check 0.70 → 0.31 s; on a synthetic grid of the proposed larger box 0.96 → 0.33 s and 2.02 → 0.94 s. See [Prepared current grid cost](#prepared-current-grid-cost-2026-11-13).

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

**Which factor is the "low-end phone".** I take **6×** as the low-end phone and 4× as a mid-range one. Chrome DevTools labels 4× "mid-tier mobile" and 6× "low-tier mobile", and Lighthouse's mobile preset uses 4×. This is a convention, not a measurement of any phone (the later phone measurement found a mid-range phone closer to 2×: see [Measured on a real phone](#measured-on-a-real-phone)). A recent flagship is probably faster than 4×; a budget phone with a three-year-old CPU may be slower than 6×.

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

- **No device.** A throttled desktop CPU is a stand-in. It does not reproduce a phone's memory limits and garbage collection, thermal throttling over repeated scans, the mobile browser's scheduler, background tab limits, battery saver, or the difference in cache, memory bandwidth and JIT between an ARM phone core and a slowed Ryzen core. 6× is a convention. **No device was measured and none is claimed.** _(Written before the phone measurement: one mid-range phone was measured afterwards, see [Measured on a real phone](#measured-on-a-real-phone); a low-end phone still was not.)_
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

## After the hashing change

_12 November 2026, later the same day. Adjacent finding 1 acted on; the findings above are left as measured._

**Where the hashing went** (one warm 21-candidate Channel scan in Node, each `contentHash` call timed; before the change):

| Call site | What is hashed | Size (canonical JSON) | Calls per candidate / per scan | Same content across candidates | Time |
|---|---|---|---|---|---|
| `assembleFindings` → decision hash | the whole decision input: ensemble members 60 %, current grid 26 %, model comparison 6 %, waves 5 %, deterministic 3 % | about 1.9 MB | 1 / 21 | no (each route samples its own points) | 2.03 s |
| `decisionInputs` inside the decision hash → current grid digest | the tile current grid without its clocks | 628 KB | 1 / 21 | yes | 0.67 s |
| `runAnalysis` → `decisionInputs` again for `snapshotInputs` → current grid digest | the same grid again | 628 KB | 1 / 21 | yes | 0.66 s |
| route hash, `routeRevision`, profile hash | route, route + departure, limits | ≤ 2 KB | 3 / 63 | profile only | 7 ms |

Hashing was 3.37 s of a 4.43 s warm scan (76 %). About 80 % of hashing time was the FNV-1a loop itself (BigInt arithmetic, about 40 ns per character), the rest building the canonical JSON.

**What changed.** Nothing a scan or a Check returns, shows or saves:

- **A scan no longer builds its candidates' saved identity** (decision inputs, decision hash, snapshot id). Its findings are only ranked inside `scanDepartures`: no findings, briefing or plume object leaves it, `WindowScan` and the progress callback carry none, and a candidate the skipper picks is checked afresh (a new Check builds its own inputs and identity). Such findings have an empty `snapshot_id` and no `decision_hash`, and `writeSnapshot` refuses them. The scan marks its own audit options (a `WeakSet` in `engine/src/identity.ts`); a copy of those options, or any other caller, keeps the identity.
- **A Check builds its decision inputs once.** `snapshotInputs.decisionInputs` is now the object its decision hash was computed from, instead of a second build (which hashed the current grid a second time). `assembleFindings` is unchanged for its callers.
- No cache: nothing is kept between actions, and no hash value, serialization or key order changed.

Afterwards the same warm scan hashes 8 ms (21 route hashes, 21 route revisions and the profile).

**Node** (`npm run bench:routing -w engine -- --runs 3 --only channel-63nm` and `--only biscay-321nm`, before and after, back to back on the machine above; medians of 3, range in brackets; the routing and the audit are each one block):

| Passage | | Scan total, first | Scan total, repeat | Audit, repeat (longest block) | Routing (longest block) | One warm audit (a Check's engine cost) |
|---|---|---|---|---|---|---|
| Channel 62.7 nm | before | 5,391 (5,320 to 5,533) | 5,178 | 4,371 | 795 | 259 |
| | after | 1,951 (1,943 to 1,953) | 1,792 | 995 | 792 | 225 |
| Biscay 321 nm | before | 14,742 (14,705 to 16,095) | 15,763 | 13,212 | 2,543 | 569 |
| | after | 5,207 (5,076 to 5,210) | 5,152 | 2,632 | 2,504 | 431 |

The audits take 77 to 80 % less time and the whole scan 64 to 67 % less. The profile above put hashing at about 55 to 60 % of an audit's time; timing each call site put it at 76 % of the warm scan, and the scan now skips nearly all of it. One `runAnalysis` (the bench's warm audit probe, before saving; a full Check also hashes the tile grid it reads and hashes its inputs again in `writeSnapshot`) takes 13 to 24 % less: one grid digest fewer.

**Browser** (`npm run perf:prepare`, then `PERF_PASSAGES=channel-63nm,biscay-321nm PERF_RATES=1,6 PERF_RUNS=2 npm run perf:browser`, production build, Pixel 7 emulation; medians of 2, seconds):

| Passage | Throttle | Click to result | Longest block | Largest tap delay | Longest gap between frames |
|---|---|---|---|---|---|
| Channel | 1× | 4.41 → 2.15 | 3.12 → 1.01 | 3.02 → 0.91 | 3.23 → 1.08 |
| | 6× | 26.8 → 13.6 | 18.9 → 6.6 | 18.8 → 6.6 | 20.8 → 8.5 |
| Biscay | 1× | 11.4 → 5.4 | 8.35 → 2.64 | 8.29 → 2.60 | 8.66 → 2.97 |
| | 6× | 69.2 → 32.6 | 50.6 → 15.6 | 50.5 → 15.6 | 52.7 → 17.8 |

The block shrinks by 65 to 69 %. One of the two "before" Channel 6× runs overlapped a few seconds of a unit-test run; it measured 19.04 s against 18.84 s for the clean one.

**What remains.**

- **The page still freezes.** The block is still one task with no repaint, no "n/21" progress and no response to a tap: 6.6 s (Channel) and 15.6 s (Biscay) at 6×, 1 to 2.6 s unthrottled. The recommendation stands: a cancellable Worker for the scan before D2 and D3. D2's extra candidates now cost about a third of the figures in the D2 table above.
- **The block is now routing and audit in about equal parts** (Node: 0.8 s and 1.0 s for the Channel, 2.5 s and 2.6 s for Biscay).
- **Next cheapest audit saving, not done: hour labels in the tile reads.** A CPU profile after the change (of a whole scratch process: building the tiles, a warm-up scan, a measured Channel scan and two Checks, 4.8 s) puts 1.75 s (36 %) in `toIso`, nearly all called from `resampleToHourly` (`engine/src/forecast/tileMath.ts`) under `getEnsembleForecasts`: it formats the same hourly timestamps once per hour, per member and per point, for each of the 31 members. Formatting them once per read would be pure reuse of identical strings. One profile, indicative only; its share of the scan alone was not separated.
- **Faster FNV-1a** (done 2026-11-13, see [Prepared current grid cost](#prepared-current-grid-cost-2026-11-13)). The BigInt loop in `fnv1a64HexParts` could run on four 16-bit limbs with identical output: in a scratch test, 8.5 ms instead of 261 ms for 4.2 million characters, bit-equal on 2,000 random strings of up to 200 characters (the committed test now covers long inputs too, see the section linked above). It would speed up every remaining hash (a Check's decision hash, prepared-grid digests, adjacent finding 4) but also the tile corruption check, so the PFT1 codec goldens shared with forecast-tiles would be in its scope.
- **A Check still hashes its decision inputs twice:** once for its identity and once in `writeSnapshot`, which checks that the inputs it is about to archive match that identity. That second hash is a deliberate guard, left alone.
- **Each scan candidate still renders a briefing and a plume** that the scan throws away. Not measured separately.

## Measured on a real phone

_12 November 2026, evening. A device measurement, kept apart from the desktop sections above: it measures one mid-range phone, not the low-end phone the 6× rows stand in for._

**Device and setup.** Samsung Galaxy A53 5G (SM-A536B; Chrome reports 8 cores and 4 GB of device memory), Android 16, Chrome 157.0.8103.50, charging over USB throughout, no CPU throttling (it is a real device). The browser runs in French, so the page was shown in French; the work is the same. The production build of the viewer was served from the desktop over USB (`adb reverse`) to `http://localhost:…/#plan` and the same synthetic forecast files as the desktop runs, on the real clock (`--live`), the same set for every run below. Three fresh-load runs per passage and build: our origin's storage (including the IndexedDB tile cache) was cleared before each run. All 21 runs finished with the page visible and never hidden, and 21 candidates shown; none was discarded. An earlier attempt the same day failed because the phone's screen had locked (nothing loaded, nothing was measured).

**Method.** A script on the desktop drove one Chrome tab over remote debugging (the DevTools protocol), found by its URL, and read nothing else on the phone. Per run: clear our origin's storage, load the page, install the same probe (`viewer/e2e/perf/probe.js`) and seed the planner draft, load again, then touch the **Compute route** button, wait for the route, touch **Compare departure times**, wait for the comparison. During each action it touched the probe's corner pad every 250 ms to measure input delay. Definitions are the desktop record's: click to painted result, longest long task, sum of long tasks, first progress paint (the status line under the button), frames, longest gap between frames, largest tap delay. "Before" is the code of commit fa31563, "after" the working tree with the scan identity change (commit 69eb2a4; the page was built before a final comment, test and docs follow-up, which changes no code path). Both were served from saved builds, in one session, with the Channel scan repeated on the "before" build as a drift control.

### Before (fa31563), medians of 3 (range), milliseconds

| Passage | | Click to result | Longest block | Sum of long tasks | First progress paint | Largest tap delay | Longest frame gap |
|---|---|---|---|---|---|---|---|
| coastal 20.7 nm | Compute | 498 (471 to 721) | 56 (53 to 76) | 56 | 25 | 16 | 50 |
| | Scan | 4,868 (4,831 to 4,934) | 4,137 (4,105 to 4,232) | 4,482 | 454 | 4,197 | 4,183 |
| channel 62.7 nm | Compute | 638 (548 to 657) | 116 (110 to 119) | 173 | 31 | 86 | 117 |
| | Scan | 7,879 (7,868 to 8,017) | 5,977 (5,935 to 6,086) | 7,429 | 1,533 | 5,806 | 5,983 |
| Biscay 321 nm | Compute | 862 (703 to 878) | 338 (319 to 392) | 401 | 30 | 332 | 342 |
| | Scan | 27,023 (24,388 to 31,515) | 21,263 (19,305 to 24,812) | 26,676 | 5,234 | 21,117 | 21,269 |

### After (69eb2a4), medians of 3 (range), milliseconds

| Passage | | Click to result | Longest block | Sum of long tasks | First progress paint | Largest tap delay | Longest frame gap |
|---|---|---|---|---|---|---|---|
| coastal 20.7 nm | Compute | 467 (459 to 611) | 52 (0 to 84) | 52 | 35 | 18 | 50 |
| | Scan | 2,673 (2,626 to 2,760) | 1,985 (1,955 to 2,030) | 2,306 | 453 | 1,976 | 1,978 |
| channel 62.7 nm | Compute | 601 (535 to 706) | 113 (108 to 117) | 170 | 3 | 55 | 108 |
| | Scan | 4,208 (4,159 to 4,223) | 2,279 (2,258 to 2,335) | 3,759 | 1,497 | 2,073 (1,265 to 2,081) | 2,270 |
| Biscay 321 nm | Compute | 658 (642 to 751) | 276 (267 to 280) | 317 | 29 | 113 | 267 |
| | Scan | 11,370 (11,140 to 11,551) | 6,714 (6,419 to 6,740) | 11,036 | 4,332 | 6,580 | 6,718 |

### Before against after, with the drift control

| Passage | Scan longest block | Scan click to result |
|---|---|---|
| coastal | 4,137 to 1,985 ms, **−52 %** | 4,868 to 2,673 ms, **−45 %** |
| channel | 5,977 to 2,279 ms, **−62 %** | 7,879 to 4,208 ms, **−47 %** |
| Biscay | 21,263 to 6,714 ms, **−68 %**; against the coolest "before" run (19,305 ms) **−65 %** | 27,023 to 11,370 ms, **−58 %**; against that run (24,388 ms) **−53 %** |

- **Drift control (Channel).** After the "after" runs the "before" build was served again and the Channel scan repeated three times, with the phone as cool as in the "after" runs: block 5,942 ms (5,848 to 6,064) against 5,977 ms in the first session, click to result 7,790 ms against 7,879 ms, Compute block 116 ms against 116 ms. **The baseline Channel numbers did not move** (within 1 %), although the phone was about 3 °C cooler, so the Channel comparison is not an artefact of heat. Against the control the change is −62 % in block and −46 % in click to result.
- **Compute did not change** apart from noise (block 56 to 52 ms, 116 to 113 ms, 338 to 276 ms; the Biscay Compute total went 862 to 658 ms, probably the warmer first session, not the change, which does not touch Compute). The change touches the scan only.
- The desktop record measured a 65 to 69 % shorter block under throttling; on the phone the block is 52 to 68 % shorter, less for the short passages, where the work that remains (see below) is a larger share.

### Temperatures and the Biscay caveat

Battery temperature (the phone's sensor, `dumpsys battery`): 26.2 to 26.8 °C when first connected, before any load; **31.0 to 31.9 °C during the "before" session**; 28.4 to 28.5 °C during the "after" runs and 28.3 to 28.4 °C during the control (28.3 °C at the end). I did not heat the phone to match; the "after" session started 2.5 °C cooler than the "before" one.

Biscay's three consecutive "before" scans took 19.3, 21.3 and 24.8 s as the temperature rose from 31.4 to 31.9 °C: the phone slowed run by run, consistent with thermal throttling (not proven). The "after" runs did not drift (6.7, 6.7, 6.4 s). Biscay was not re-run on the "before" build in the cool state, so its "before" median includes the slowdown; the conservative comparison is against the first, coolest "before" run: **−65 % block, −53 % click to result**. The Channel control, whose numbers did not move with temperature, suggests the shorter scans are not heat-sensitive in this range; Biscay's ~20 s scans are.

### What the phone shows (measured)

- **About 2× desktop throttling, not 4× or 6×.** The "before" scan block is 1.9× the desktop's unthrottled block on coastal (4.14 against 2.17 s) and Channel (5.98 against 3.10 s) and 2.3 to 2.5× on Biscay (19.3 to 21.3 against 8.38 s); Compute blocks are 2.0× (Channel, 116 against 57 ms) to 2.4× (Biscay, 338 against 143 ms) the desktop's. After the change the phone is 2.3× (Channel, 2.28 against 1.01 s) and 2.5× (Biscay, 6.71 against 2.64 s) the desktop's. **This Galaxy A53 behaves like about 2× throttling on this machine. The 4× row that this record called a mid-range phone, and the 6× row for a low-end one, overstate it.** A genuinely low-end phone has still not been measured; this record says nothing measured about one.
- **A second long task before the main block, on the phone only.** About 120 to 140 ms after the tap a long task starts that lasts **0.34 s (coastal), 1.4 s (Channel) and 4.1 to 6.1 s (Biscay)**, before the main block. It was not part of the identity change (4.7 to 6.1 s before and 4.1 s after on Biscay) and is now a large share of what is left. Its cause was not investigated. The preparation before the audits (tile reads and decodes, prepared data) was made of short tasks on the desktop, with at most one 0.44 s task at 6× on Biscay; on this phone it contains a task ten times longer. It **delays the first progress paint**: the status line shows nothing until it ends, at 0.45 s (coastal), 1.5 s (Channel) and 4.3 to 5.2 s (Biscay), and only then paints "Comparing departure times…" once. The sum of long tasks is 86 % (coastal), 89 % (Channel) and 97 % (Biscay) of the click-to-result time after the change, and 92 to 99 % before it.
- **What did not change.** There is still **no frame painted during the scan block** (the longest frame gap equals the block within 1 %), **a tap waits for the whole block** (largest tap delay within 3 % of it; one Channel tap landed 1.3 s into the block), and the **"n/21" counter is never painted**: the status line changed once per scan, never during the block, in all 18 scans.
- **Thresholds.** After the change the phone's scan blocks 2.0 s (20 nm), 2.3 s (Channel) and 6.7 s (Biscay), beyond the 50 ms, 100 ms and 1 s thresholds of this record. Compute blocks 52 ms, 113 ms and 276 ms (before: 56, 116, 338 ms): over 100 ms for the Channel and Biscay, never over 1 s.

### What this means for the conclusion

- **Measured:** a real mid-range phone freezes for 2 to 7 s on a scan after the identity change (4 to 21 s before it), with no repaint and no response to a tap. It confirms, on a device, that the scan blocks beyond every threshold, which was the desktop finding.
- **The Worker recommendation stands on a real device.** Inferred, not measured: D2's 4 to 16 extra candidates would cost this phone about 0.4 to 1.5 s (coastal), 0.4 to 1.7 s (Channel) and 1.3 to 5.1 s (Biscay) more block, at the after-change per-candidate cost of the block divided by 21 (95, 109 and 320 ms); every case is past the 100 ms threshold and the Biscay case past 1 s. The pre-block long task, not touched by the identity change, would still freeze the page for up to 4 s before any progress shows.
- **What is still open:** a low-end phone (slower than this one); a warm tile cache and a real network; what the pre-block long task contains; whether the shorter scans keep their numbers over repeated runs in a hot phone.

### Commands of this run

The "Measuring on a real phone" steps below are the supported way to repeat a phone measurement. This run used scratch scripts that are not in the repository (a copy of `viewer/e2e/perf/serve.js` that can serve a saved build, and a Node driver); what they did differently from those steps:

- The driver ran from the desktop over the DevTools protocol instead of by hand in the DevTools console: it cleared our origin's storage (`Storage.clearDataForOrigin`), loaded the page, installed the probe by `fetch('/probe.js')` and an indirect `eval`, seeded the draft, reloaded, armed the probe, sent real touch events (`Input.dispatchTouchEvent`) to the button centre, and every 250 ms to the corner pad, polled `window.__perf.resultAt.<action>.paint`, and read `__perfSummary`. It read only the one target whose URL began with our address, and filtered the target list before using it.
- It used **the action button, not the mode tab**: the page has a tab and a button both named "Compute route" (the first is `role=tab`); taps and the console step 5 must go to the button.
- The phone's Chrome was in French, so the driver looked for the French labels and the French result texts (`Calculer la route`, `Comparer les heures de départ (5 prochains jours)`, results `Route météo`, `Comparaison des départs prête`) instead of the English ones in console steps 5 and 6.
- Builds were saved (`cp -r output/perf/viewer-dist <dir>`) and served from there, so that "before" and "after" could be alternated in one session.

```bash
# builds: one saved copy per revision (perf:prepare overwrites output/perf/viewer-dist)
# check out the revision to measure in a clean working tree first
npm run perf:prepare && cp -r output/perf/viewer-dist <saved-build-dir>
npm run perf:fixtures -w engine -- --live              # output/perf/fixtures-live: one set for every build compared; regenerate on the day

# serve (a saved build needs a server that can point at it: copy viewer/e2e/perf/serve.js and set its dist, port and fixtures)
PASSAGE_PERF_FIXTURES=fixtures-live node viewer/e2e/perf/serve.js

# phone (unlocked, screen on, charging or not: note which), one Chrome tab
adb reverse tcp:<port> tcp:<port>
adb forward tcp:<host-port> localabstract:chrome_devtools_remote
adb shell am start -a android.intent.action.VIEW -d "http://localhost:<port>/#plan" -p com.android.chrome
curl -s http://127.0.0.1:<host-port>/json/version                  # Chrome version
adb shell dumpsys battery | grep -E "^  (level|temperature):"      # before and after each passage (temperature is in tenths of °C)

# afterwards: close only our tab, remove the rules
curl -s http://127.0.0.1:<host-port>/json/close/<our-tab-id>
adb reverse --remove tcp:<port>; adb forward --remove tcp:<host-port>
```

The "before/after" order of this run: after build (coastal, Channel, Biscay, 3 runs each), then the "before" build again for 3 Channel scans (drift control); the "before" build had been measured in an earlier session on the same fixtures. Run builds alternately in one session when comparing, start the phone at a similar temperature, and report temperature with the results.

## After the Worker

_12 November 2026, evening. This section records the change that the recommendation above asked for. The sections above are left as they were measured._

### The long task right after the tap

Before writing the Worker I timed the steps of `runScan` and compared them with the probe's 10 ms timer-lag sampler. The run was Biscay at 2× (about the phone's speed), on the production build, with temporary timestamps that were then removed.

- After the Compute had already loaded the routing inputs, `prepareAnalysisInputs` and `loadRoutingInputs` ended about 60 ms after the click.
- **Routing the 21 candidates (`routeOnOneCurrent`, 21 × `computeRoute`, synchronous) then ran as one block of 4.4 s.**
- The first audit started 0.4 s later.
- The 21 audits ran as one block of 5.3 s.

The phone's "second long task" is therefore the routing loop: it matches the Node routing figures times the phone's factor (0.34, 1.4 and 4.1 to 6.1 s against 0.15, 0.8 and 2.5 s in Node).

On the desktop, Chromium's `longtask` observer did not report the routing block, but the timer-lag sampler did. **The desktop rows above under "longest block" and "sum of long tasks" therefore counted the audit block only.** The click-to-result, frame-gap and tap-delay columns were not affected. This is why the Worker takes the routing as well as the audits.

### What changed

The whole scan action now runs in a module Worker. The design was agreed with the owner before implementation.

- **Code.**
  - `viewer/src/lib/scanAction.js` is the action: prepare the inputs, load the routing inputs, route every candidate on one current source, audit and rank. The Worker and the in-page fallback run the same code.
  - `scanRunner.js` is the page's side.
  - `scanWorker.js` and `scanWorkerHandler.js` are the Worker's side.
  - `pinnedForecast.js` hands the page's pinned runs to the Worker.
- **What crosses the boundary:**
  - Into the Worker: the draft frozen at the click, a few parameters, the page's clock, and a copy of the page store's pinned run catalogue and manifests (a few KB).
  - Back from the Worker: the comparison and each departure's route.
  - Tiles and grids never cross. The Worker builds its own `TileForecastStore` over exactly those runs. It reads tiles through the shared IndexedDB cache (gzip bytes) or over HTTP and decodes them itself. It cannot read `latest.json` or evict the cache.
  - A store whose runs differ from the page's fails the action as an updated forecast. Errors come back with their deleted-run identity, so the existing refresh-and-retry still applies.
  - The Worker builds and freezes the action bundle on its side and routes and audits on one current source. Only the page's input key (local time) is added on the page.
- **Progress, stop and stale inputs.**
  - The status line counts "Routing departures n/21…" and then "Comparing departure times n/21…" (French: "Calcul des routes n/21…", "Comparaison des heures de départ n/21…").
  - No partial result is shown, because hour figures and ranking are filled in only after the last audit.
  - "Stop comparing", under the scan button and on the phone's action bar, ends the Worker at once. The next scan starts a new Worker.
  - A change to the route points, boat, percent of polar or speeds during a scan stops it with "Comparison stopped: the route or departure changed. Compare again." A departure moved outside the anchor and its candidate times stops it the same way.
  - Leaving the planner stops a scan silently.
- **Fallback.** The page runs the same action itself, as before, when there is no `Worker`, when construction throws, or when no "ready" arrives within 15 s. The choice is kept for the rest of the visit. The production build emits the Worker as one 115 kB file (an IIFE started as a module Worker); the CSP already allows `worker-src 'self'`.
- **Compute stays on the page's thread.** Its longest block is unchanged (below).

### Results unchanged

The comparison (candidates, ranking, skipped, routes, notes, current source, input records and digests) is identical across the boundary.

- **Node.** `viewer/test/scanWorker.test.js` sends structured-cloned messages through the Worker's handler and compares the result with the in-page call, for computed and drawn scans.
- **Real browser.** `viewer/e2e/scan-worker.spec.js` runs a real Worker on PFT1 tiles and the real coastline, and compares the stored scan with the same scan run on the page.
- **What may differ.** In the browser only wall-clock stamps differ: a route's `computed_at`, a tile read's `fetched_at`, and the tile current record's `content_digest`, which hashes the current grid together with its read time (adjacent finding 6 below). The test page's clock is fixed and the Worker's is not. In a one-off run with the Worker's clock fixed too, everything was identical.
- **Unchanged checks.** The engine (and its scan golden) is unchanged, and the identity suites pass.

### Desktop browser, before and after

The commands were `npm run perf:prepare`, then `PERF_PASSAGES=coastal-20nm,channel-63nm,biscay-321nm PERF_RATES=1,2,6 PERF_RUNS=2 npm run perf:browser`.

- **Builds.** "Before" was a production build of commit ad3aae5, served by the same harness. "After" was this change. The two builds were measured back to back on the machine above.
- **Figures.** Medians of 2 runs, in seconds. All 24 scans showed 21 candidates.
- **Measures.** "Longest block" is the longest timer lag, which caught the routing block where the long-task observer did not. "Tap" is the largest input delay of a tap on the probe's corner pad.

| Passage | Throttle | Click to result | Longest block | Longest frame gap | Largest tap delay | Frames during the scan | Status changes |
|---|---|---|---|---|---|---|---|
| coastal 20.7 nm | 1× | 1.52 → 1.87 | 1.05 → none over 30 ms | 1.06 → under 0.05 | 0.93 → 0.015 | 10 → 115 | 3 → 40 |
| | 2× | 3.07 → 1.80 | 2.14 → none | 2.20 → under 0.05 | 1.90 → 0.024 | 8 → 110 | 3 → 40 |
| | 6× | 9.63 → 1.99 | 6.69 → 0.14 | 7.29 → 0.17 | 6.65 → 0.12 | 6 → 76 | 3 → 28 |
| Channel 62.7 nm | 1× | 2.36 → 2.52 | 1.12 → none | 1.27 → under 0.05 | 0.88 → 0.014 | 5 → 154 | 3 → 49 |
| | 2× | 4.60 → 2.66 | 2.29 → none | 2.79 → under 0.05 | 2.22 → 0.008 | 4 → 163 | 2 → 50 |
| | 6× | 14.8 → 2.91 | 6.99 → 0.09 | 9.04 → 0.12 | 6.85 → 0.11 | 6 → 128 | 3 → 46 |
| Biscay 321 nm | 1× | 5.84 → 5.75 | 2.84 → none | 3.18 → under 0.05 | 2.80 → 0.014 | 4 → 356 | 3 → 50 |
| | 2× | 12.2 → 5.82 | 6.24 → none | 6.92 → under 0.05 | 6.04 → 0.010 | 6 → 360 | 2 → 50 |
| | 6× | 40.8 → 6.24 | 19.0 → 0.08 | 21.8 → 0.14 | 18.9 → 0.09 | 5 → 346 | 3 → 48 |

- **During a scan the page paints and answers.**
  - The longest long task is 58 ms at 6× and none at 1× and 2×.
  - A tap waited at most 24 ms at 1× and 2×, and 88 to 119 ms at 6×, where the page's own work (rendering each count, a few short tasks) runs six times slower.
  - The status line paints the counts: 40 to 50 changes per scan, against 2 to 3 before ("n/21" was never painted before).
- **Total time at 1× is about the same or a little longer.**
  - Coastal +0.35 s, Channel +0.16 s, Biscay −0.09 s.
  - The Worker starts once per visit, fetches and decodes the coastline and its tiles again (from the shared cache), and decodes the wind grid that Compute had already decoded on the page.
- **CPU throttling does not slow the Worker.** `Emulation.setCPUThrottlingRate` throttles the page's thread, not a dedicated Worker's: after the change the 2× and 6× totals are within 0.4 s of the 1× ones.
  - **So the throttled "after" totals are not a phone estimate.** On a phone the Worker runs at the phone's speed, so expect the scan to take about as long as before. The page stays usable meanwhile.
  - The main-thread columns, which are what the Worker is for, remain valid under throttling.
- **Production build.** The `build:pages` output was served with `static-dist` and one drawn 34 nm scan was run on the live forecast tiles, unthrottled. The Worker script loaded and the count painted ("Comparing departure times n/20…"). The comparison completed with no alert, and the page's longest timer lag was 60 ms. That local server does not apply `_headers`, so the deployed CSP (`worker-src 'self' blob:`) was read, not exercised.
- **Compute is unchanged.** Its longest block was 0 to 0.16 s at 1×, 0.05 to 0.34 s at 2× and 0.16 to 1.24 s at 6×, before and after alike (Biscay at 6×: 1.24 before, 1.00 after).

### Against the thresholds

- **Met, desktop.** On the desktop, at every throttle tried:
  - the page repaints during a scan;
  - the progress count advances;
  - a tap is handled within 100 ms at 1× and 2× (the phone's speed) and within 120 ms at 6×;
  - a scan can be stopped at once.
- **Not measured.**
  - **No phone has been measured after this change.**
  - The phone steps above still apply; the Worker needs no change to them.
  - A low-end phone has still not been measured.
- **Effect on D2.** D2's extra candidates now lengthen the Worker's run, not the page's freeze. The D2 table above becomes waiting time with a live count and a Stop button.

### Adjacent findings (recorded, not fixed)

5. **The dev server serves the coastline `.bin.gz` with `Content-Encoding: gzip`**, so the browser decompresses it before the app's own `DecompressionStream` does. A Compute on the real coastline therefore fails in development with "Couldn't load the coastline data needed for safe routing". Production and the perf server are unaffected. The browser specs stub the coastline or serve it themselves.
6. **The tile current record's `content_digest` includes the grid's read time.** `resolveCurrentInput` and `selectRoutingCurrent` hash the tile current grid with its `generated_at` and `source.fetched_at` (`engine/src/currentInput.ts`), so two scans or Checks on the same run record different digests a second apart. The saved identity strips these clocks (`engine/src/identity.ts`); this provenance digest does not.
7. **Compute could use the same Worker.** It is a single route and its block is at most 0.28 s on the phone and 1.2 s at 6×, so it was left on the page. A prepared grid's digest is its largest part.
8. **Limits can now change during a scan.** The page stays usable for seconds, so the Limits drawer can be opened and changed while a comparison runs. The comparison is still ranked on the limits captured at the click, because the scan basis does not include the profile. This was already true during the scan's preparation, but it is now easy to do. Decided 2026-11-13: a limits change stops a running comparison or refinement and drops one on show, each with a line saying why.
9. **The French `fixture-persistence` browser test** (`e2e/fixture-persistence.spec.js:49`, "Execution context was destroyed") failed in 3 of 3 runs on the unchanged ad3aae5 tree and in 2 of 4 runs with this change. It is the known intermittent failure and is not caused by the Worker.

## Prepared current grid cost (2026-11-13)

_13 November 2026. Code only: nothing was published, and the prepared grid, its box, the factory and the workflows are unchanged. Node on this desktop only: no browser and no phone was measured for this section._

**Why.** A proposal to publish a larger prepared current grid (48.5–51.0°N, 6.0°W–0.5°E: 45 × 117 cells × 121 hourly steps, 6.7 MB, against today's 24 × 69 × 121, 2.1 MB) found the grid's content digest to be most of what it costs the browser, and that each action hashed it twice: once when the loader made its input record (`artifactRecord`), and again in the engine (`gridDigest`), because Compute's grid was not frozen and the scan Worker's frozen copy was not the object the record had hashed. The owner chose to cut that cost first. The enlargement waits for these numbers.

**What changed.**

1. **One digest per loaded grid.** `loadPreparedCurrent` (`viewer/src/lib/preparedCurrent.js`) deep-freezes the grid before its record hashes it, through the engine's new `cachedContentHash` (`engine/src/hash.ts`). That function caches a digest by object identity, and only for a value that is deep-frozen plain data: every object and array in it frozen, plain prototypes, and data properties only, so no getter can answer differently later. Freezing cannot be undone, so a cached digest is always the digest of what the object holds. A value that could still change is hashed every time, and so is a copy of it. `gridDigest` in `engine/src/currentInput.ts` uses the same function. The recorded `content_digest` values are unchanged: they are the same `contentHash` of the same object, taken once instead of twice.
2. **FNV-1a 64 on four 16-bit limbs** (`fnv1a64HexParts`), instead of a BigInt per character. The prime is 2^40 + 0x1b3, so a limb times 0x1b3 stays in place and a limb times 2^40 moves two limbs up, times 0x100; every intermediate value stays below 2^27. `engine/test/hash.test.ts` compares it with the BigInt definition on every file under `engine/test/fixtures`, `engine/test/golden` and `contracts/` (raw bytes, gunzipped PFT1 codec goldens, text and the canonical JSON `contentHash` reads), every single UTF-16 code unit and byte value, million-unit strings and byte arrays, and 3,000 seeded random strings, byte arrays and part lists covering ASCII, Latin-1, the BMP, surrogate pairs and lone surrogates. Every golden and identity suite passes unchanged.
3. **Not done: skipping the download where the grid cannot be admitted.** The browser has no bound for the prepared grid before downloading it: `config/route-sources.json` is not in the bundle, and the pointer names no area. Skipping the grid for a Check would also move the Check's saved identity. A Check whose prepared grid is rejected records `fallback_reason`, `rejected_prepared_run_id` and `rejected_prepared_input` in the current provenance that its decision inputs hash. In a scratch run of a drawn route outside the grid, `decision_hash` and `snapshot_id` were `b45a5e2c1a5ca4c3` with the grid and `542601f1d15b9b6c` without it; `route_revision` did not change. See the C1 status in the [implementation plan](2026-11-11-isomar-implementation-plan.md) for the options.

**Method.** A scratch script (not in the repository) ran the engine sources of the working tree before and after on two grids: today's live grid (24 × 69 × 121, 2,141,927 bytes, fetched from the public pointer on 13 November) and a synthetic grid of the proposed box (45 × 117 × 121, 6,725,349 bytes), built by the Python factory's own grid code and serialisation from invented values, with land from the repository's coastline mask. It reproduced the flows of the viewer: parse, the record's digest (and, after the change, the freeze first), then for Compute `selectRoutingCurrent` on a Cherbourg–Plymouth passage (invented constant 6 kt polar, the perf harness's synthetic wind and tiles); for a Check `runAnalysis` on that route and `writeSnapshot` into memory; for the Worker's comparison the load, `freezeActionInputs` and the selection's digest. Five runs each, medians, milliseconds, Node v24.22.3 on the Ryzen 7 7735HS above. Both before and after runs were on 13 November.

| Milliseconds (Node, desktop) | Live grid, before | Live grid, after | Larger box, before | Larger box, after |
|---|---|---|---|---|
| JSON parse | 11 | 11 | 31 | 31 |
| One digest of the grid (`contentHash`) | 140 | 59 | 456 | 205 |
| of which canonical JSON | 52 | 52 | 174 | 177 |
| Compute: load (parse, freeze, digests) | 150 | 80 | 475 | 258 |
| Compute: the selection beyond routing (its digest) | 131 | 0.5 | 404 | 0.4 |
| Compute: Cherbourg–Plymouth, load to route | 328 | 155 | 956 | 335 |
| A Compute far outside the grid (A Coruña–Brest): its cost of the grid | 151 | 81 | 460 | 255 |
| Check: load | 155 | 80 | 496 | 273 |
| Check: `runAnalysis` | 326 | 107 | 912 | 259 |
| Check: `writeSnapshot` (in memory) | 218 | 122 | 610 | 405 |
| Check: total | 697 | 307 | 2,018 | 936 |
| Comparison in the Worker: load, freeze and the selection's digest | 289 | 79 | 903 | 254 |

- **What is left is mostly the canonical JSON** that every digest serialises (52 and 177 ms) and, in a Check, the saved identity: `runAnalysis` hashes the decision inputs, which hold the whole prepared grid (6.0 MB on the live grid, 16.9 MB for the larger box). `writeSnapshot` then hashes them once more as a guard (78 and 229 ms after the change), and serialises them for storage (28 and 72 ms).
- **The browser's IndexedDB write of `decision-inputs.json`** (6.0 MB or 16.9 MB per saved Check) is not in these figures and was not measured: the in-memory store above stands in for it. Keeping the whole grid in each saved Check is out of the scope of this change.
- **A route outside the grid** still downloads, parses and hashes it once: about 0.08 s on the live grid and 0.26 s for the larger box (above). Skipping it was not done (point 3).
- **Phone.** Not measured. The 2× factor recorded above was taken on a different workload (a comparison), so no phone figure is given here.
- **Next measured option, not done.** For an array of numbers, `null`s and strings, `JSON.stringify` writes exactly what `canonicalJson` writes. A scratch fast path using it gave identical strings on both grids and cut their canonical JSON from 66 to 25 ms (live grid) and from 184 to 54 ms (larger box). Arrays holding `undefined`, functions or symbols differ (`canonicalJson` drops them, `JSON.stringify` writes `null`), so such a fast path must check every item first. It would sit on every identity hash and would need the same equality proof as the FNV change.

Tests: `engine/test/hash.test.ts` (the equality corpus and `cachedContentHash`: a mutable, partly frozen or getter-bearing value is never served an old digest; a deep-frozen grid is serialised once), `engine/test/currentAdmission.test.ts` ("one digest per loaded prepared grid") (one serialisation of the grid for a Compute, a comparison of three candidates with their audits and a refinement; a Check adds only the grid inside its saved decision inputs; a grid that is not frozen and was changed after its record is recorded with its new digest), `viewer/test/actionInputs.test.jsx` (the real loader, Compute selection and Check: one digest, recorded values equal to `contentHash` of the same grid), `viewer/test/scanWorker.test.js` (computed and drawn comparisons and their refinement: no further digest after the load), `viewer/test/routingInputs.test.js` (the loaded grid is frozen).

### A comparison on the regional current grid (2026-11-13, night)

_Code only, local Node measurement on this desktop; no browser or phone was measured, nothing deployed._ A computed comparison now uses the prepared grid for the departures it covers when it covers the first one and at least half of them (`selectComparisonCurrent`, owner decision 4 of the [implementation plan](2026-11-11-isomar-implementation-plan.md)); before, its 120 h axis sent every departure to tiles. A scratch script (not in the repository) ran both selections on the same inputs: the perf harness's synthetic wind and tiles (`engine/scripts/perf/scenarios.ts`), the real coastline mask, an invented constant 6 kt polar, and a synthetic prepared grid of the live shape (45 × 117 × 121, 48.527–50.972°N, 5.999°W–0.446°E, from `preparedCurrentGrid`), its run 2 h or 14 h before the first departure (12Z; the axis ends 118 h or 106 h after it). Routing confined to the grid's box as the planner does; then the audits of every assessed departure (`scanDepartures`). Three runs each after one warm-up on the same store, medians, milliseconds, Node v24.22.3.

| Passage, grid age | Before: tiles (routing + audits = total) | After: regional grid (routing + audits = total) | Routed before → after (attempts on the grid) | Not assessed after | Last covered departure |
|---|---|---|---|---|---|
| Coastal 20 nm, 2 h | 139 + 900 = 1,043 | 139 + 898 = 1,037 | 21 → 20 (20) | 1 | +114 h |
| Coastal 20 nm, 14 h | 140 + 916 = 1,055 | 125 + 815 = 941 | 21 → 18 (18) | 3 | +102 h |
| Channel 63 nm, 2 h | 917 + 938 = 1,851 | 809 + 999 = 1,807 | 21 → 18 (20) | 3 | +102 h |
| Channel 63 nm, 14 h | 870 + 938 = 1,807 | 728 + 852 = 1,580 | 21 → 16 (18) | 5 | +90 h |

- No departure is routed twice: a departure after the axis end is never routed, and one whose passage outlasts the axis stops when its search reaches the axis end (two such attempts on the 63 nm crossing). The cost per assessed departure is about the same on either source; a comparison on the grid is cheaper by the departures it leaves out.
- The worst case is unchanged in kind: a comparison that routes the grid's departures and then falls back (the first departure or a place without a value fails late, or the share is missed after routing) routes twice, as a rejected Compute does. Routing stops as soon as half can no longer be reached.

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

_Written before the phone measurement; the run that followed is in [Measured on a real phone](#measured-on-a-real-phone), with the differences between its scripts and these steps._ Not done. No phone was available and none was measured. These steps need no product change and no public deployment; the page is served from the desktop to the phone over USB. I verified the console steps (4 to 6) on desktop Chromium; the USB steps (1 to 3) follow Chrome's documented remote-debugging feature and were not tried.

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
- The scan Worker (2026-11-12, evening): `viewer/src/lib/scanAction.js`, `scanRunner.js`, `scanWorker.js`, `scanWorkerHandler.js`, `scanMessages.js`, `pinnedForecast.js`; tests `viewer/test/scanWorker.test.js`, `scanRunner.test.js`, `pinnedForecast.test.js`, `plannerScanStop.test.jsx`, `viewer/e2e/scan-worker.spec.js`
- npm scripts `perf:node`, `perf:prepare`, `perf:browser`, `perf:serve` (root), `bench:routing`, `perf:fixtures` (engine), `perf:build`, `test:perf` (viewer)
