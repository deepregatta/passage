# Implementation plan for the Isomar learnings

_11 November 2026. A dated plan, not current product guidance. It plans the ten "Recommended next steps" of [the Isomar review](2026-11-11-isomar-learnings.md). Nothing here is implemented yet._

**Provenance.** Code facts were read from this repository and the sibling `forecast-tiles` repository on the same day, then checked by a second read. No test, build or live site was run. Each task must re-read the code it touches before editing: line numbers move.

## What the code reading changed

Five findings change the review's order or scope.

1. **Compute routes on GLO12, but a Check may audit on IBI.** There are three current sources, not two:
   - the prepared current grid from the Python factory, which prefers regional models (`REGION_PRIORITY = ["IBI", "NWS", "MED", "BAL", "GLO"]` in `analysis/src/deepweather_analysis/environment_fetcher.py`). `resolveCurrentInput` (`engine/src/currentInput.ts`) uses it for a Check or a drawn-route scan whenever it covers every sample;
   - `currents` tiles (GLO12, 6-hourly), the fallback, and the only source for Compute routing and for the audits of a computed scan (`routingCurrentInput` in `usePlannerController.jsx`);
   - `currents-ibi` tiles, published but read only by the GRIB export.

   So the gap is not "no regional currents". It is that a computed route and its own audit can use different models, and that the router never sees a tide-resolving current. Task C1 addresses that before any new layer (step 9).
2. **IBI tiles do not fit the browser store as it is.** One IBI tile decodes to about 125 MB (`forecast-tiles/docs/ibi-currents.md`); the store keeps nothing over 64 MB decoded (`maxDecodedBytes`, `engine/src/forecast/tileStore.ts`), so a grid read would decode the same tile again for every lattice point. IBI also reaches only 120 h from its base, less than a scan asks for.
3. **Percent of polar is already in the saved identity.** `computeRoute` writes `provenance.routing_request.polar_scaling` into every route, and `routeRevision` hashes the route. Step 1 needs no schema or identity change.
4. **The download size is known before a fetch.** Run manifests list compressed bytes per tile, and the GRIB export plan already sums them (`downloadBytesUpperBound` in `engine/src/export/exportPlan.ts`). The GRIB page's `estBytes` is the output file size, not the download, so step 2 reuses the manifest bytes, not that estimate.
5. **A scan cannot tell "no ensemble" from "no member exceeds".** `max_fraction` is `null` in both cases. Cautious ranking (step 3) needs an explicit coverage flag.

## Order of work

| Batch | Tasks | Size | Gate |
|---|---|---|---|
| A. Planner, viewer and engine only | A1 percent of polar, A2 ranking and tie margin, A3 percentile sentence, A4 download size | S each (A4 S–M) | None |
| B. Records | B1 licence register (structure), B2 licence verification (research) | S–M | B2 needs the owner to confirm each licence reading |
| C. Summaries and currents | C1 one current source for route and audit, C2 route summary, C3 current block, C4 limits in the ranking | M each (C1 M, then L) | C3 after C1's first phase |
| D. Scan depth | D1 responsiveness measurement, D2 refinement pass, D3 limits in the router | M–L | D2 and D3 after D1 |
| E. Producer changes | E1 NW Shelf layer, E2 per-member direction | L each | Licence confirmed (E1), size measurement and consumer audit (E2), and an explicit authorization to change publication |

A1, A2 and A4 all edit `viewer/src/i18n.js` and its tests, and A1 and A4 both edit `Planner.jsx` and `usePlannerController.jsx`, so they run one after another, not in parallel.

Rules for every task: a failing test first for behaviour changes; French catalogue (`viewer/src/i18n.js`) and its tests in the same commit as any English copy; `npm test`, `npm run lint` and the affected Playwright specs before commit; no change to committed fixtures or goldens unless the task says so; one commit per task.

## Batch A

### A1. Percent of polar (review step 1)

- **Store.** Add `polarPercent` (integer, default 100) to `viewer/src/stores/plannerStore.js`. Keep the store at `version: 3`: a stored draft without the field takes the default through the persist merge.
- **Routing.** `routeForDeparture` (`viewer/src/pages/planner/usePlannerController.jsx`) passes `polarScaling: polarPercent / 100`. It has two callers, Compute (`runRouting`) and Scan (`routeFor` inside `runScan`). Update the dependency lists of `runScan` and `loadRoutingInputs`.
- **Stale-input keys** (`viewer/src/pages/planner/plannerInputs.js`): add the percentage to `routingInputKey`, `scanBasis` and `draftSignature`, and a "boat speed changed" case to `changedRoutingInputs` / `staleRouteMessage`.
  - `changedRoutingInputs` requires a three-element key. Append the percentage as a fourth element only when it is not 100 and accept both lengths; keys already stored on users' devices then compare equal.
  - `routingInputKey` is called with hand-built objects in three places in the controller (restore check, scan `routeFor`, and the blocked-action check). All three must pass the percentage. If the scan one is missed, a time picked from a scan at a percentage other than 100 is discarded at once.
- **Engine.** `polarScaling` has no validation. `computeRoute` reports problems by throwing; throw for a non-finite or non-positive value the same way as the horizon check. UI range: 50 to 120, step 1 (a plan decision, not read from code).
- **Control.** One number input beside `BoatPicker` in the Boat step of `viewer/src/pages/Planner.jsx` (compute mode only; draw mode uses declared speeds). Where a computed route names its boat, show the percentage when it is not 100, read from `route.provenance.routing_request.polar_scaling`, so a saved passage shows what it was computed with.
- **Identity.** No change. Do not set top-level `Route.polar_scaling`.
- **Tests.** `engine/test/routing.test.ts` (invalid scaling throws; provenance records the value). `viewer/test/plannerComputed.test.jsx` (a changed percentage rejects a restored result; a stored three-element key still restores at 100). `viewer/test/departureComparison.test.jsx` (every scan candidate is routed with the scaling, and picking a scanned time keeps its route). `viewer/test/plannerIdentity.test.js` with a fixed clock, because route provenance carries `computed_at`: equal percentages give equal revisions, different ones differ, same `passage_id`. i18n tests.
- **Docs.** `docs/capabilities.md` (browser Compute row), `docs/boat-polars.md` (a percentage is not polar data).

### A2. Typical or cautious ranking, with a tie margin (review step 3)

- **Engine** (`engine/src/window.ts`). Extract the comparison in `scanDepartures` into an exported pure function, `rankCandidates(candidates, { mode, tolerance })`, returning `{ best_index, tied_indices }`.
  - `typical`: today's order (verdict severity, then `worst_ratio`). `scanDepartures` keeps calling it and returns only `best_index`, as now: `window.test.ts` pins the scan's shape with `toEqual`, so `tied_indices` stays on `rankCandidates`.
  - `cautious`: verdict severity, then `max_fraction`, then `worst_ratio`. A covered candidate with `max_fraction: null` counts as 0.
  - Tie: same severity and a difference in the deciding value of at most 0.05. For the ensemble that is one scenario of 31 (one member is 0.03, two are 0.06 after rounding). `worst_ratio` can be `Infinity`: two infinite values tie, an infinite and a finite one do not. The tolerance is a named, exported constant.
  - Add to `WindowCandidate`: `ensemble_covered` (true when any audited hour has a non-null `exceedance.gust` or `exceedance.sustained`; `hour.exceedance` alone is not enough, it is set even when both counts are null) and `max_members: { exceed, total }` for the worst hour, so the viewer can say "6 of 31". Cautious mode is unavailable when no candidate is covered.
- **Viewer** (`viewer/src/pages/planner/DepartureComparison.jsx`). A two-way toggle, "Typical" and "Cautious", in the grid header. The viewer calls `rankCandidates` on the scan it already holds; no rescan. The summary line names the best time and, when there are ties, says which other times are effectively tied. Tied cells get a secondary mark. The cell tooltip gains the scenario count, which answers the review's "text-only ensemble" anti-lesson on the grid. The toggle is a view preference in the planner store; it enters no stale-input key.
- **Tests.** `engine/test/window.test.ts`: both modes, tolerance edges, `Infinity`, nulls, the coverage flag; the existing "first candidate wins on ties" test stays valid for `best_index`. Add the anti-lesson regression: every `runAnalysis` call receives its own `departureUtc` and the route `routeFor` returned for it (today only the last call is asserted). `viewer/test/departureComparison.test.jsx`: toggle, tie note.
- **Docs.** `docs/capabilities.md` (new departure-ranking line), `docs/product-brief.md` (check that the wording still never says "GO" or "best").

### A3. Wind and gust percentile sentence (review step 5)

- **Source.** The saved plume (`PlumeLeg.wind_members` / `gust_members`, `engine/src/snapshot.ts`) together with the saved findings. Passages saved before this change then get the sentence too, and `Findings`, its schema, its goldens and the frozen briefing text stay untouched.
- **Hours.** The plume holds far more than the passage: from 00Z on the departure day to a day past the slowest arrival. The function must use, for each leg, only the valid times of that leg's audited hours in the findings. This is the same rule the scenario counts follow.
- **Engine.** New pure function, exported from `engine/src/index.ts`: for each member, the maximum wind and the maximum gust over those hours; then the median and the 90th percentile across members. Use the quantile definition the plume chart already uses (linear interpolation, `viewer/src/components/EnsemblePlume.jsx`), moved to one shared function. Nulls are skipped as `countExceedance` does; the control member is included, as in the counts. Returns `null` when the plume is missing (it is loaded with a fallback to `null`), when legs have no ensemble times, or under a minimum member count.
- **Wording.** A count of scenarios, never a probability, and honest about sampling (values are taken at the leg sample points): "In half of the 31 forecast scenarios the strongest wind at the points checked along your route stays at or under 16 kt; in nine out of ten, at or under 19 kt." The same for gusts. The viewer owns the sentence, with a French pattern.
- **Placement.** In `viewer/src/pages/briefing/EvidenceSection.jsx`, outside the branch that hides the plume. That section shows no plume when no member exceeds a limit, and the calm case is exactly where the sentence is most useful.
- **Tests.** Engine unit test (hour restriction, quantile definition, nulls, too few members, missing plume), a section test for the calm case, i18n tests.

### A4. Download size before Compute, Scan and Check (review step 2)

- **What each action fetches.** Whole tiles are fetched, so the time window does not change the size.
  - Compute: `weather` and `currents` grids over the route box, plus the coastline mask and the polar.
  - Check and Scan: `weather`, `ensemble`, `waves`, `weather-ecmwf` and `weather-ecmwf-short` at the leg sample points (only the tiles those points fall in, plus edge neighbours); currents from the prepared grid or `currents` tiles; regional models only when `VITE_REGIONAL_MODELS` is set (they have their own 20 MB budget). A computed scan adds Compute's grids.
  - Prepared artifacts, tides and gate files are not in tile manifests. The quote covers forecast tiles and says so.
- **Engine.** `planTiles` in `exportPlan.ts` is private and built around a GRIB lattice, so it is not reusable as it stands. Add a small helper that takes `{ layer, bbox }` and `{ layer, points }` requests plus the loaded manifests and returns bytes and tile counts per layer, sharing only the per-tile byte lookup with the GRIB plan.
- **Already downloaded.** `TileCache` has no presence check without side effects (`get` updates the LRU record). Add an optional `has(key)` to the interface and to `viewer/src/lib/tileCache.js`, and subtract tiles already on the device. The browser's HTTP cache is invisible, so the figure stays an upper bound and the copy says "up to".
- **Viewer.** One line under each button in `Planner.jsx`: "Downloads up to 12 MB of forecast tiles" or "Forecast tiles already on this device". No confirmation dialog. Reuse `fmtGribBytes`.
- **Tests.** Engine helper test with a fixture manifest; `viewer/test/routingInputs.test.js`; `viewer/test/tileCache.test.js` for `has`; i18n tests (the size sits inside a sentence, so the French entry is a pattern).
- **Docs.** `docs/capabilities.md`. Real sizes on the deployed site are a separate measurement and are reported as such.

## Batch B

### B1. Licence register, structure (review step 4)

- **Two registers, one schema.** Each repository records what it ingests.
  - `forecast-tiles`: canonical schema `contracts/data-sources.schema.json` and register `data-sources.json`, covering every published layer (GFS, GFS-Wave, GEFS, ECMWF IFS, GLO12, IBI, AROME, ICON-EU, UKV), the land-index inputs and the chart pack.
  - Passage: `config/data-sources.json` for its own feeds (warnings by country, tides, observations, ERA5, prepared currents, the port index, base map), with the same schema.
- **Fields.** `id`, `name`, `provider`, `licence`, `licence_url`, `attribution`, `share_alike`, `redistribute` (`yes`, `no` or `unconfirmed`), `verified_on` (date or null), `verified_from` (URL), `used_by` (layer or feed ids), `notes`.
- **No guessing.** B1 copies only what the repositories already state (`DATA-LICENSES.md`, attribution constants in `src/ingest/sources/`, `viewer/src/data/PROVENANCE.md`). Everything else is `unconfirmed` with `verified_on: null`. GFS, GFS-Wave, GEFS and ECMWF IFS carry no attribution in producer code today; they enter as `unconfirmed`.
- **Sharing.** Passage vendors the schema and the forecast-tiles register under the existing rules: an entry in `contracts/shared-contracts.lock.json` and in the `EXPECTED` inventory of `scripts/check_shared_contracts.py`, in both repositories, plus their negative tests. The checkers also hard-code who may consume what (anything that is not PFT1 must be consumed by Tactician only), so both need a small logic change for a register consumed by Passage. Passage's checker is a vendored copy; keep its header and content in step with the forecast-tiles original.
- **Completeness checks.** In forecast-tiles, a test fails when a layer in `LAYERS` (`src/ingest/cli.py`) has no register entry. In Passage, a test fails when a feed in `config/providers.json` has none.
- **About page** (`viewer/src/pages/About.jsx`). The "Data providers" panel gains licence, attribution and verified date per source, and shows `unconfirmed` plainly. The registers are imported at build time (as `gribNextSteps.js` imports its data); nothing is fetched at run time. French catalogue in the same commit.
- **Kept as they are.** The manifest `attribution` field, the `licence` field in `contracts/prepared-run.schema.json` and the GRIB page's per-dataset attributions. `DATA-LICENSES.md` keeps its prose on UKV's ShareAlike duties and points to the register.

### B2. Licence verification (research, no code)

Read each provider's terms and fill `licence`, `redistribute`, `verified_on` and `verified_from`: NOAA (GFS, GFS-Wave, GEFS, NDBC, CO-OPS), ECMWF open data (IFS, and AIFS for later), DWD (ICON-EU), Météo-France (AROME), Copernicus Marine (GLO12, IBI, NW Shelf, in-situ, anonymous access), Queensland, the Met Office print pages, NGA. Each reading is a proposal until the owner confirms it; an entry moves from `unconfirmed` only then. This task gates E1.

## Batch C

### C1. One current source for route and audit (new; prerequisite of C3 and E1)

**Phase 1 (M): let routing use the prepared grid.** Compute and computed scans admit the prepared current grid by the audit's own rule (`resolveCurrentInput`: prepared when it covers every sample in space and time, tiles otherwise), so a route and its Check use the same model.

- First step: read why `routingCurrentInput` forces tiles today (`viewer/src/lib/actionInputs.js`, `docs/testing.md` on current admission). A router explores a box around the route, not only the route, so coverage for routing is a wider test than coverage for an audit.
- Keep the rule of one source per action: every candidate of a scan uses the same grid, and the frozen input records name it. A saved passage never changes source afterwards.
- The result states which model was used, with its caveat.
- Tests: `engine/test/currentAdmission.test.ts`, a route-then-Check test asserting one source, the identity suites in `docs/testing.md`.

**Phase 2 (L): `currents-ibi` tiles as the middle tier**, for when no prepared grid covers the route: prepared, then `currents-ibi`, then `currents`. Not started before these are settled:

- a decode strategy for a 125 MB tile (a windowed or time-subset decode, or a dedicated budget) and a memory measurement on a phone;
- time coverage: `mosaicGrid` silently clips the time axis to what a run has. IBI reaches 120 h from its base, and a computed scan asks for 120 h plus the passage. Coverage must be tested in time as well as space, and a scan will usually fall back to GLO12, so Compute and the scan could again differ. Decide whether that is acceptable or whether a scan shortens its window;
- download size: the four Channel tiles total about 35 MB and the largest single tile is about 22 MB. A4's quote must include them;
- fixtures: the demo fixture has no `currents-ibi`. Store tests use a synthetic fixture; end-to-end coverage needs its own fixture-update task.

### C2. Route summary (review step 6, wind part)

- **Engine.** New `engine/src/routeSummary.ts`, a pure function of `Findings`, exported from the index. Not a new `Findings` field: that would change goldens, schema and hashes.
  - Hours by point of sail (`LegHour.point_of_sail`).
  - Hours by wind band: under 10, 10–15, 15–20, 20–25, 25 kt and over.
  - Each leg's hours span its whole arrival range (fastest entry to slowest exit), so adjacent legs overlap. Assign each whole hour to the one leg whose nominal window (`enter_range.nominal` to `eta_range.nominal`, half-open) contains its start. Tests pin that no hour is counted twice and that the total is within one hour of the nominal passage time.
- **Viewer.** A compact block on the passage page (`viewer/src/pages/briefing/AssessmentDetails.jsx` is the likely host; confirm when reading). Text and numbers, no new chart.
- **Not included.** Time under engine (no engine model). Time in the dark: it needs a solar calculation, which the repository lacks, and `night_ok` changes nothing today. Leave both until night risk is taken up as its own task.

### C3. Current block (review step 6, current part)

After C1's first phase, so the block describes the same currents the route used.

- **Values.** Distance gained or lost, strongest current and when, hours of wind against current. For a computed route the gain is exact: it is the difference between through-water speed and speed over ground in `timing.legs`. For a drawn route it comes from `LegHour.current`, which is one sample at the leg midpoint; say so.
- **Hours with and against** only when the source is hourly and resolves the tidal cycle. `docs/forecast-tile-format.md` forbids presenting a coarse time axis as resolving tides, so on GLO12 the block shows gain and strongest current with the caveat, and no with-and-against hours.
- **Wording.** Keep "current", never "tidal stream". IBI's own provenance says "ocean-model currents including tide; resolves the tidal cycle; not a tidal-stream prediction"; reuse the GRIB dataset note's wording. `null` when the passage has no current data.

**Status 2026-11-13: hours with and against implemented in source, local tests only.** The owner approved recording the current grid's real time step in each check. A check's `currents` input record carries `time_step_h`, the largest interval of the sampled grid's whole time axis (optional in `contracts/findings.schema.json`); whether the product includes tide is one engine table (`engine/src/currentProducts.ts`). The block adds one line, on the expected timing at each leg's midpoint, with, against and across-or-weak hours at a 0.5 kt along-track threshold, only for one recorded non-tile, non-emulated grid with a step of an hour or less from a product that includes tide (in practice prepared IBI). Passages saved before the change, any tile grid (GLO12 tiles are 6-hourly; if Phase 2 admits hourly `currents-ibi` tiles, lifting this gate is a deliberate step), products whose tide is not recorded and mixed records get no line. No identity changed; the scan golden gained the field. Not deployed.

### C4. Limits in the ranking (review step 8, scan part)

No absolute figure exists to reuse: `passageMetrics` counts gust-exceeded hours only, counts overlapping leg hours twice, and the scan then stores differences from the first candidate (whose own `delta` is the absolute value). Define two new figures on `WindowCandidate`, `hours_over_limit` and `hours_approaching`, over distinct valid times and any limit, using C2's hour assignment. `rankCandidates` uses them after severity and before the ratio, in both modes; a difference of one hour or less is a tie. No free weights: the skipper's limits stay the only preference. Tests in `window.test.ts`; the grid tooltip shows the hours.

## Batch D

### D1. Measure Compute and Scan responsiveness

Already remaining work 2 in `docs/capabilities.md`. A scan routes every candidate before auditing any, synchronously on the main thread, with no cancel. D2 and D3 add work to that path, so a measurement on a low-end phone decides first whether a cancellable Worker is needed. Device measurement, reported separately from tests.

**Status 2026-11-12: local measurement and one mid-range phone measured; a low-end phone not.** [Record](2026-11-12-scan-responsiveness.md): the scan blocks the page for 2.2 to 8.4 s unthrottled and 13 to 51 s at 6× CPU throttling (audits are 80 to 95 % of it), Compute for up to 0.9 s at 6×; D2 would add 4 to 16 candidates. Recommendation: a cancelable Worker for the scan before D2 and D3. A Galaxy A53 (mid-range, unthrottled) blocked for 4.1, 6.0 and 21 s on a 20, 63 and 321 nm scan, and for 2.0, 2.3 and 6.7 s after the scan stopped hashing its candidates' identity (commit 69eb2a4); it behaves like about 2× desktop throttling. A low-end phone was not measured; the record gives the steps.

**Update, 2026-11-12, evening: the cancellable Worker is in place.** The scan, routing included, runs in a Web Worker with a live count and a Stop button, and its results are unchanged. On the desktop the page's longest task during a scan fell from 1 to 19 s to at most 58 ms. A phone has not been measured since. See [After the Worker](2026-11-12-scan-responsiveness.md#after-the-worker). D2 and D3 now add to the Worker's run, not to a page freeze.

### D2. Refinement pass (review step 7)

- **Engine.** `refineScan(base, coarse, { stepH, spanH })`: route and audit extra departures around the best and tied candidates (default every 2 h within 6 h either side, skipping times already present), merge in time order, recompute the baseline-relative fields and rerank.
  - `scanDepartures` does not return what this needs. The event keys behind `avoids_event_key` are local to it, the candidates' metrics are stored as differences, and a drawn scan's resolved current input is not returned. Return them on request (an option, so the pinned default shape is unchanged).
  - Clamp refined times to the coarse span and never before the first coarse candidate: the shared current grid and date window were sized for that span, and an earlier time would move the baseline.
- **Viewer.** An explicit "Refine around the best time" action with its own download and progress line. Refined times appear as an extra row for that day only. Not automatic in the first version.
- **Tests.** Merge, baseline recomputation, no duplicate departures, one current source across both passes; a viewer test for the extra row.

**Status 2026-11-12: implemented in source, local tests only.** `refineScan` adds times every 2 h within 6 h of the marked and tied times of both rankings (so the set does not depend on the toggle), clamped to the first assessed time and the last time asked for, and gives exactly the result of one scan over all the times on the same current input; that equality is the main test, on generated cases with missing data and on the committed fixtures. `scanDepartures` returns the data refinement needs only with `{ refinable: true }`; the default result and the scan golden are unchanged. In the planner, "Refine around the least-exposure times" runs once per comparison, in the Worker that ran it, on the very inputs it used, with its own count, download line and Stop; a changed set of limits now drops the comparison (2026-11-13); it is refused with a plain reason when the forecast runs changed or those inputs are no longer held (after Stop, a failure, a newer comparison). Refined times appear in a second row under their day. Desktop Chromium, one run each with the browser harness (`PERF_REFINE=1`): a Channel refinement added 14 times in 1.4 s (1×) and 1.5 s (6×), the page's longest task 53 ms at most and taps answered within 34 ms; a Biscay refinement added 2 times in 0.5 to 0.6 s with no long task. Not deployed; not measured on a phone. See [capabilities](../capabilities.md) and [testing](../testing.md#refining-a-comparison-d2).

### D3. Limits in the router (review step 8, router part)

A spike before any commitment. The router is an earliest-arrival search keyed on time and sees only wind and current. Two options: a hard exclusion of edges whose sustained wind exceeds the limit for that point of sail (keeps the algorithm), or a soft cost (needs a different search). Gust and wave limits would need new grids in `RoutingRequest`. There is also a product question for the owner: a route that steers around over-limit wind turns the audit toward an optimiser. If adopted, it is opt-in, off by default, recorded in route provenance and stated on the result.

## Batch E

Both tasks change what `forecast-tiles` publishes. Each needs its own authorization, a storage check against the 8 GB retention guard, and the producer and consumer checks for shared schemas.

### E1. NW Shelf currents layer (review step 9)

Only after B2 confirms the product's terms and whether anonymous access exists, and after C1 shows what regional currents change in routes. The Python factory already knows a NWS region for prepared grids; check whether that path gives the benefit before building a tile layer. If a layer is still wanted, the touch points are:

- **forecast-tiles:** a new source module beside `src/ingest/sources/ibi.py` (reusing its helpers); the layer lists and per-layer settings in `src/ingest/cli.py`; cadence in `publish.py`; `capacity.py`; the dispatcher timetable and its tests; a new ingest workflow; `scripts/size_prototype.py`; source, publish, wait and dry-run tests; README and docs.
- **Passage:** the layer enums in the three forecast schemas (canonical here, then re-vendored and re-pinned in both locks); `docs/forecast-tile-format.md`; `engine/src/export/gribDatasets.ts`; `viewer/src/lib/gribExport.js` and `sourceNames.js`; the publication schedule in `briefing.ts`; `nextRun.ts`; C1's source order; the register from B1.

Measure tile sizes on a prototype first. A 1.5 km grid is far denser than IBI, whose tiles already exceed the browser's decode budget (C1, phase 2).

### E2. Per-member wind direction (review step 10)

Gates, in order: measure the gzip size of today's ensemble tiles (never measured); prototype two encodings and measure both, a direction anomaly per member (one extra int8 array, about 1.5° steps) and u/v anomalies (two extra arrays); check producer memory (docs record a peak near 4.9 GB); audit other consumers (Tactician's use of the ensemble layer is not recorded in either repository).

The change is additive: new variable names in the existing layer, readers look variables up by name, and tiles without direction keep working. It still regenerates the ensemble golden in both repositories and re-pins both locks. In the engine, `EnsemblePointForecast` gains optional member directions. Routing every member for every candidate multiplies routing work by about 31, so arrival-time percentiles also depend on D1's outcome.

## Anti-lessons not covered above

- **A crash from UI state.** The review suggested changing the model selection during a running check. Passage has no such control: forecast-model selects exist only on the GRIB page, and a Check deliberately keeps the draft captured at the click. The equivalent test here: change the boat, the percentage (A1) or the ranking toggle (A2) while Compute or Scan runs, and assert that nothing throws and that the result is kept or discarded as the stale-input rules say. **Written 2026-11-13** in `viewer/test/plannerStateDuringAction.test.jsx`: Compute, a comparison and a refinement each against a changed boat, percent and ranking toggle (compute and drawn-route modes), failing on any thrown or logged error. It does not cover the departure or route points, a real Worker or a browser run.
- **A busy chart.** A guideline for C2, C3 and D2: text blocks and one extra grid row, no new map layers.

## Decisions for the owner

1. A1: is 50–120% the right range?
2. A2 and C4: the tie tolerances (0.05 of the limit, one scenario, one hour).
3. B1: two registers with one schema, or a single register in forecast-tiles that also lists Passage's own feeds?
4. C1 phase 2: may a scan and a Compute use different current models when IBI's horizon is too short, or should the scan window shrink?
5. D3: should the router ever avoid over-limit wind, or does that stay outside an audit?
6. E1 and E2: both need authorization to change publication, after their gates.

## Not determined

- Why routing was restricted to tile currents (C1 starts with it).
- Whether a prepared current run is published and fresh on the live site today.
- Scan cost per candidate on a phone (D1).
- Compressed ensemble tile sizes, R2 headroom and Tactician's ensemble use (E2).
- The forecast-tiles touch-point list for E1 was read once and not re-checked.
- Every licence the review marked "to confirm" (B2).
