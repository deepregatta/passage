# Testing and maintenance

## Test suites

Run the same core checks used by CI from the repository root:

```bash
bash scripts/check-workflows.sh
npm run lint
npm audit
npm test
npm run build:pages
(cd analysis && uv run pytest -q)
(cd analysis && uv run ruff check . ../scripts/upload-prepared-run.py)
(cd analysis && uv run ruff format --check . ../scripts/upload-prepared-run.py)
python3 scripts/check_storage_admission.py
```

[GitHub Actions maintenance](github-actions.md) documents the checksum-verified
workflow lint gate, deliberate upstream updates and main protection proposal.

P01's standalone scripts are also checked/formatted in CI: `prepared_storage.py`,
`storage_admission.py`, `preview_prepared_retention.py`, `check_storage_admission.py`.
Run Ruff on those explicit paths alongside the uploader. The vendored admission
helper must retain its pinned canonical bytes; do not format a divergent copy.
`analysis/tests/test_storage_admission_contract.py` runs the portable F01 vectors
and scratch negative drift checks. `test_upload_prepared_run.py` owns concurrent
forecast/prepared reservations, interrupted/uncertain publication, pointer graph
identity, transport inventory and non-destructive retention preview acceptance.

The root `eslint.config.mjs` applies ESLint's recommended JavaScript rules,
typescript-eslint's recommended rules, and React Hook order/dependency checks.
`npm run lint` fails on errors or warnings, including unused suppression comments.
Generated output, archived code, local browser artifacts and the Python factory
are excluded; Ruff covers Python. TypeScript's existing build/test type checks
remain separate. Unused `_`-prefixed TypeScript parameters and properties omitted
via object rest destructuring follow the existing adapter/persistence conventions.

Browser flow and screenshot coverage runs in its own CI job, which installs
Chromium on Ubuntu 24.04 and uploads failure traces/screenshots. The suite uses
`Europe/Paris` explicitly so chart time labels match on local and hosted runs.
Run it locally with:

```bash
npm run test:e2e -w viewer -- --workers=1
```

Playwright starts the `viewer-demo` configuration from `.claude/launch.json`.
Locally it may reuse port 5174 only after the dev server reports demo mode and
its served index matches the committed fixture byte-for-byte. A live-data,
unidentified, or stale server fails setup before any browser tests run; stop
that server or use the demo configuration. CI always starts its own server.
A reused server that has hot-reloaded `Planner.jsx` serves it with a `?t=`
query, which `sharing.spec.js`'s route glob misses (the test then times out),
so restart it after editing the Planner.

Suite ownership:

| Location | Runner | Responsibility |
|---|---|---|
| `engine/test/` | Vitest | Pure analysis, routing, schemas, tile decoding, GRIB2 export, snapshots, and golden findings |
| `viewer/test/` | Vitest + Testing Library | UI behavior, localization, persistence, prerendering, saved-snapshot compatibility, and the GRIB files page (`gribExport.test.jsx`, a real `TileForecastStore` over in-memory fixture tiles) |
| `viewer/e2e/` | Playwright | Desktop/mobile core flows and reviewed screenshot baselines |
| `analysis/tests/` | pytest | Provider adapters, route-independent preparation, warnings, tides, observations, verification, and the ecCodes GRIB export contract |

Verification regressions cross the real matcher, CLI retry and calibration
persistence (`analysis/tests/test_verification*.py`). They check same-case
idempotence, corrected/empty/emulated replacements, deterministic order, legacy
preservation and schema compatibility. The actual Python-generated
`viewer/test/fixtures/verification-case-v2.json` is also validated by Python and
rendered by viewer unit/browser tests. Regenerate it only from
`analysis/tests/test_verification_retries.py:case`, passing the retained demo
snapshot ID `snapshot_v2_406ad333228b0a73` (the regenerated demo's latest check;
it was `20260720T060000Z_44d2cd5f_64ea971e` until 2026-11-14) and fixing
`generated_at` to `2026-07-13T00:00:00Z`. The 2026-11-14 regeneration changed
only `snapshot_id` and the `case_revision` hash derived from it. Bilingual outcome smoke
uses `viewer/e2e/verification-outcome.spec.js` with scratch browser persistence
and intercepted observation responses, never production calibration data.

## Viewer build dependencies

The viewer uses pinned Tailwind CSS 4.3.3 with `@tailwindcss/postcss`; the
separate Autoprefixer plugin is removed. This removes the Tailwind 3 build
chain through `braces` 3.0.3, affected by
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The full `npm audit` remains required; the production-only audit does not
substitute for it.

The [Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide)
sets CSS browser minimums of Safari 16.4, Chrome 111 and Firefox 128.
The existing palette and font configuration remain loaded through `@config`.
Compatibility rules retain absolute text line heights, responsive heading
metrics, 2px control corners, divider sides, hover borders and forced-color
focus outlines. Existing desktop/mobile screenshots and demo fixtures must
remain unchanged when maintaining this compiler configuration.

## Decision message compatibility

PASSAGE-07 emits optional decision-only metadata while retaining briefing
version 1 and canonical English fields. `engine/test/decisionMessages.test.ts`
checks all emitted IDs, canonical byte/fact parity, unknown IDs, unit/date/count
constraints and whole-register legacy gates. Types and writer/reader schemas
come from one registry; `npm run check:messages -w engine` is included in engine
tests. `validDecisionMessageFields` also checks bounds relating two parameters
and English fallback parity. The old briefing golden compares its unchanged
projection without new metadata, and no archival fixture is regenerated.

Route summary regressions: `engine/test/routeSummary.test.ts` pins the wind
band edges, that no hour is counted twice where legs overlap, that the total is
within one hour of the nominal passage time (demo snapshot, the
Cherbourg-Plymouth golden and 30 short legs), offset ISO times, the
not-available buckets and the empty case.
`viewer/test/routeSummary.test.jsx` checks the block, its EMULATED stamp (decided by the wind
forecast's recorded provenance: tile layer, legacy `inputs.openmeteo`, wind-rule
evidence; a synthetic warning alone never stamps it) and its French text against an independent reading of the demo findings.

Current block regressions: `engine/test/currentSummary.test.ts` pins following,
opposing, cross and zero currents, hours without a value (counted as not
available, and then no passage distance), time weighting inside a leg that
starts and ends between hours, the strongest current over every audited hour of
the arrival range, wind-against-current hours on the expected timing (counted
once) and as distinct flagged instants anywhere in the arrival range, the same
hour total as the route summary, and hours with and against the current: exact
counts of a current turning through with, against, across, weak (0.5 kt either way
counts as weak) and missing hours, overlapping legs counted once, figures adding up
to the expected-timing hours (within one hour of the nominal passage time), a real
check on an hourly IBI-named grid against an independent count, the same passage
reversed 180 degrees swapping with and against, and no figures for a coarse,
absent or null step, any tile grid (the 6-hourly layer, or IBI tiles with an hourly step), emulated grids (a real check on a synthetic hourly IBI-named grid records the step and gets no figures), a product whose tide is not recorded,
no model, two current records or an older check's legacy record; the committed
saved checks run without throwing and get none. A real check on a drawn route whose 3.1 kt current arrives only in the
slow arrival range raises T-WAC-01: the strongest current is at least that
evidence's value, at its hour, and the expected-timing count is zero. On the
saved `routed-current.json` route (2 kt following current) the distance equals a
hand calculation of 2 kt over the routed time; the route's figures are refused
for an edited route, another current run, a route computed without currents and,
for a route stamped as routed on a prepared grid, a different recorded digest
(the same digest uses them). The `current_run` guard stays: a test shows a tile
record and a route both without a run would otherwise match.
`engine/test/currentTimeStep.test.ts` covers the step a check records on its
`currents` input record (`time_step_h`): the largest interval of the whole time axis
of the grid it sampled (hourly, 3-hourly under an hourly-sounding dataset id, the
6-hourly tile grid through `runAnalysis` with a stubbed `getCurrentGrid` (not a real tile mosaic), irregular, sub-hourly, single-time and
unreadable axes), that the provenance cannot set it, that the decision inputs do
not contain it and two checks of the same inputs keep one identity, and the
findings schema with and without it. `engine/test/legacySnapshot.test.ts` opens
`engine/test/fixtures/legacy-current-snapshot/`, a complete check on an hourly
prepared grid saved by the engine before the step was recorded: it validates,
its saved decision inputs hash to its `decision_hash`, and its block has every
figure and no hours with and against. Since engine semantics `passage-audit-4`
(2026-11-14) the same inputs checked now (each leg's series copied to its sample
points) give a new `decision_hash` and `snapshot_id` with the same
`route_revision`, and a retry is saved as a new check beside it while every file
of the saved one stays byte-identical and still verifies.
`viewer/test/currentWithAgainst.test.jsx` renders that line for an hourly IBI
record against an independent count, the block unchanged for every other source
and for the legacy fixture, emulated values with the heading stamp and no with/against or credit line, and the French
whole line on the real French path (an anchored pattern: the line is composed).
`viewer/test/currentSummary.test.jsx` renders the block from the demo findings
with injected current values, in English and French, against a minute-by-minute
reading; checks the null case on the committed saved checks, a strongest current
never below the page's T-WAC-01 evidence, every wind-against-current wording
(expected timing, other times only, hazard alone, none), the model name and
caveat for each current family and source (GLO12 tiles, prepared global, IBI,
North West Shelf, Mediterranean, Baltic, RTOFS, ids that identify no model, no
record), the disclaimer after every caveat, current datasets the Models panel
named as sea level, and the stamps: the heading follows the current record only
(another emulated feed never stamps it), the wind-against-current line follows
the current or the wind. `viewer/test/routeSourceNotes.test.jsx`,
`routingInputs.test.js` and `plannerComputed.test.jsx` pin that a computed
route's note names no model ("Model not recorded") when its grid records none.
`currentsAge.test.js`, `routeSourceNotes.test.jsx` and `plannerComputed.test.jsx`
pin the planner's line stating when the prepared regional grid was fetched and how
old it is (the 24 h threshold, hours against days, the `generated_at` fallback, no
line without a readable time or for tile currents, English and French).

`viewer/test/decisionMessages.test.jsx` checks typed EN/FR, legacy decoding,
copy independence, whole-field fallback, literal interpolation, unit formatting,
zero/one/many scenario grammar and DOM ownership across language switches and
mutations. The French catalogue has a TypeScript-checked parameter signature.
Python contract tests independently validate both legacy files and the actual
engine-produced emulated `engine/test/fixtures/decision-messages.json`.

`viewer/e2e/decision-messages.spec.js` exercises served legacy/new/unknown IDs,
professional text, print locale, repeated language switches and scratch
IndexedDB reopen at desktop/mobile sizes in EN/FR. Use the existing
`viewer-demo` configuration, block telemetry/external transport and intercept
all POST/DELETE requests. Snapshot identity, verdicts, analysis and untouched
message families must remain stable. Full briefing version 2 is deferred.

## Frozen Check and Scan inputs

`viewer/src/lib/actionInputs.js` and `browserAnalysis.js` are checked with
`npm run typecheck -w viewer`, also part of root `npm test`. One immutable action
bundle holds the cloned route/timing and profile revisions, departure, pinned
tile-layer identities and optional context. Check and Scan consume this bundle;
they never reread the profile storage adapter. A deleted/changed tile run aborts
the whole attempt; the existing freshness wrapper may retry with a new bundle,
retaining the user inputs captured at the click.

A departure Scan builds and uses that bundle in a Web Worker
(`viewer/src/lib/scanRunner.js`, since 2026-11-12). The page pins its runs and
sends the Worker the frozen draft, a few parameters, its clock, and a copy of the
pinned run catalogue and manifests (`pinnedForecast.js`). It never sends tiles.
The Worker builds its own store over exactly those runs: it cannot read
latest.json, and a mismatch fails as an updated forecast. It reads tiles through
the shared IndexedDB cache, builds and freezes the bundle on its side, and routes
and audits every candidate on one current source. Errors come back with their
deleted-run identity, so the freshness wrapper still retries. Stop ends the
Worker. Where no Worker starts, the page runs the same `runScanAction` itself.

These tests cover it:

- `viewer/test/scanWorker.test.js`: identical results across the
  structured-clone boundary, the page's clock, rebuilt errors;
- `scanRunner.test.js`: progress, cancel, crash, fallback;
- `pinnedForecast.test.js`;
- `plannerScanStop.test.jsx`: stop, stale inputs, counts;
- `plannerStateDuringAction.test.jsx`: the boat, the percent of polar and the
  Typical / Cautious toggle changed while Compute, a comparison or a refinement
  runs. Nothing throws or logs an error; a result made for other inputs is
  dropped (a late one never shown) and one the change does not concern is kept.
  Not covered: a change of the departure or the route points during these runs
  (see the stop tests above) and a real Worker;
- `viewer/e2e/scan-worker.spec.js`: a real Worker on PFT1 tiles against the
  in-page path.

Browser specs that replace the page store's reads set
`window.__deepweatherScanInPage` so that the scan stays on the page.

### Refining a comparison (D2)

A refinement adds departure times around the marked and tied times of a finished
comparison and merges them in. Its inputs are the comparison's own: the Worker
(or the page, in the fallback) keeps that comparison's frozen bundle, routing
inputs and current input for one refinement, and nothing crosses back to the
page. That is the comparison's whole working set (its pinned store with up to
64 MB of decoded tiles, its grids and records), so it is released as soon as the
comparison can no longer be refined: after the refinement, on Stop, a failure or
a Worker error, at the next comparison, and when the page drops the comparison
(cleared, no longer current (including changed limits), the planner left, its forecast runs replaced); the
page then posts `release` to the Worker. Changed limits drop the comparison, so they release it too. `scanDepartures(base, departures, onCandidate, { refinable: true })` adds
the engine's refinement data (per candidate: its event keys, absolute gust
metrics and a reduced hour profile; the scan's departures and current input);
without the option the result is unchanged, and the scan golden still passes
byte for byte.

- `engine/test/refineScan.test.ts`: the central property, on 120 generated seeds
  with missing values, failed departures (the first one included) and a layer
  present only at refined times: `refineScan(coarse)` equals one
  `scanDepartures` over the merged departure list on the coarse scan's current
  input (candidates, `best_index`, ties in both rankings, `input_records`,
  skipped). The equality holds whenever the coarse current input covers every
  refined time: on a prepared grid, a refined time the grid does not cover is
  deliberately listed as not assessed (so no second current source is used),
  where the pinned-input oracle would audit it. The test asserts the property is not vacuous (refining moved the
  mark, and changed earlier times' hour figures, in dozens of seeds). Also: every
  baseline-relative field, one current input across both passes, which times are
  added (clamping at both ends, no re-added skipped time, ties and both rankings),
  and that the reduced hour profile gives the same figures as counting the hours,
  for every set of limits.
- `engine/test/refineScanFixtures.test.ts`: the same property on the committed
  Cherbourg -> Plymouth fixtures; a drawn scan resolving its current once for
  both passes; a computed scan routing its refined times on the comparison's
  prepared or tile grid only (`routeOnSelectedCurrent`), never another; a
  refined time outside the prepared grid listed as not assessed.
- `viewer/test/scanWorker.test.js`: the refinement through the Worker handler
  equals the page's own, loads nothing again, answers a stale or second request
  with "unavailable", and drops the inputs on `release`; `scanRunner.test.js`: one
  refinement where the inputs are held, Stop ends the Worker and releases them, a
  newer comparison releases them, a Worker failing between jobs is ended and its
  subscribers told at once, `releaseRefinable` in the Worker and in-page paths.
- `viewer/test/plannerRefine.test.jsx`: the action, its count, progress, Stop,
  stale inputs, a refinement stopped when the limits change while it runs, refusal when the
  forecast runs changed (at render and at the click) and, as a defence, when the limits changed at the click, failures that never retry on other data, the second row with
  the mark and ties, the wording when no added time was assessed and when only
  the Typical ranking exists, each message shown once, the release of the held
  inputs (dropped, cleared, left, forecast replaced, limits changed),
  French. `departureComparison.test.jsx`: the row under its
  own day and the French tooltip. `comparisonRunChangeNote.test.jsx`: the fixed
  next-run caption under the results (shown with assessed departures, absent
  while busy or with none assessed, French). `downloadQuote.test.js` and
  `plannerDownloadQuote.test.jsx`: the refine download line.
- `viewer/e2e/scan-worker.spec.js`: a real refinement in the same Worker, equal
  to the page refining it itself.
- The browser harness times a refinement with `PERF_REFINE=1`
  (`viewer/e2e/perf/scan-responsiveness.perf.js`).

Prepared discovery bypasses a stale HTTP pointer at each action and does not
memoize failures. Artifact paths are resolved from one selected pointer; saved
chart references remain verbatim. Input provenance includes canonical FNV-1a64
content digests (not cryptographic checksums) and the exact prepared artifact
paths, including their producer revision suffixes when present. These additional
records use the existing extensible `findings.inputs.forecast_tiles` array;
forecast schemas and historical saved files remain unchanged. The additive saved
identity contract covers this frozen bundle; see [saved identities](saved-identities.md).

Prepared current admission checks every leg midpoint at its current-adjusted
entry/exit envelope and occupancy hours, including all successful drawn-scan
candidates. Any spatial, time or finite-sample gap selects tile currents for the
whole action, except a departure comparison's time gaps (see "A comparison on
the regional current grid" below). Partial tile availability stays partial; zero actual samples stays
unavailable. Compute and computed scans pick their current grid by the same
rule, widened to what the router reads: the prepared grid only when its time
axis holds every departure, both ends of the route lie inside the grid's box,
the router (in strict-current mode, confined to that box) never reads a point
or time the grid lacks and finds a route there, and every routed candidate then
passes the audit's coverage test; otherwise every departure is routed again on
tile currents over the router's normal, unconfined area. Confining the router
(owner decision 2026-11-13, "clip the router"): on the prepared attempt the
router's normal search area is intersected with the grid's box (`searchBounds`;
graph, resolution and node positions unchanged), so a grid smaller than the
padded box around the route (the live Channel grid is 1.3° tall, any padded box
at least 1° plus the route's own span) can carry the route and its Check. The box
holds the search back only when the search would expand a node outside it (a
node with wind there and a neighbour it could travel to: in the graph,
unsettled, sea, not across land) or join one to an end; an outside dead end
that reads nothing is settled as before. A route the box never held back is
byte-identical to the route computed before the change (same bytes, same
`steps_used`) and records nothing new; a route it held back records the area searched
(`routing_request.search_bounds`), and the planner says so under the route
("Routed inside the area the regional current model covers; the route could not
go outside it."). A route held back by the box that finds no route there moves
the whole action to tiles ("no route found inside the prepared grid"); an end
outside the box keeps "router read a point or time outside the prepared grid".
This is deliberately conservative: a finish just outside the grid (up to about
half a cell, every read still inside) was admitted before and now routes on
tiles.
Strict mode is unchanged inside the box: a cell without a value or a time past
the axis is a gap, never calm water. A refinement of a confined comparison is
confined to the same box. A computed
scan audits each candidate on that same routing grid, with declared source
provenance; there is no pointwise source blending. A route computed on the
prepared grid records it (`routing_request.current_source` and
`current_digest`); a Check admits a prepared grid for a computed route only when
it is that same grid, so a route computed on tiles is checked on tiles; its
record names why (computed on tile currents, without currents, on another
prepared grid, or on a prepared grid no longer available). On the prepared grid,
a departure that fails for any reason other than a current gap or the box (such
as "No route found" in a search the box never held back) stays that
departure's failure and does not move the action to tiles. Compute now also downloads `latest.json` and the
prepared current grid; neither is in the planner's tile download figure, which
still counts current tiles for Compute because they are read before the choice
and serve as its fallback. The route result names the current model it used by its family
("Currents · Copernicus IBI ocean currents"; "Model not recorded" when the grid
records no model, never a guessed one), an emulated badge for synthetic
data, and a fixed sentence when a prepared grid carries a resolution note. The
coverage selector also downgrades older presence-based claims using saved
samples alone, without changing snapshot bytes or substituting latest data.

**A comparison on the regional current grid.** Owner decision 2026-11-13 (decision 4 of the [Isomar plan](maintenance/2026-11-11-isomar-implementation-plan.md)):
a departure comparison (21 departures over 120 h) uses the prepared grid for the
departures it covers instead of sending all of them to tiles because its axis
ends before the last ones. One source per comparison stays absolute: every
assessed departure is on the prepared grid, or every one is on tiles.

- **Computed** (`selectComparisonCurrent` in `engine/src/currentInput.ts`, used by
  `runScanAction`; Compute keeps `selectRoutingCurrent`). The grid is used when it
  is a current grid, the first departure is inside its axis, routes on it
  (strict, confined to its box) and passes the audit's coverage test, nothing read
  at a time the grid covers is missing, and at least `MIN_COVERED_SHARE` (0.5,
  rounded up: 11 of 21) of the departures asked for are fully covered (routed on
  it and covered to the slow arrival). A departure after the axis end is never
  routed; routing stops once the share can no longer be reached. A departure whose
  passage outlasts the axis (`CurrentGapError.beyondTimeAxis`, or a coverage gap
  only at times past the axis) is not assessed (`OUTSIDE_SCAN_CURRENT`); one with
  no route inside the box, or none at all, keeps its own routing error and no
  longer moves the comparison to tiles. Otherwise every departure is routed on
  tiles with Compute's reason, `first departure time has no route on the prepared
  grid`, or `prepared grid covers fewer than half of the departure times`. The
  first departure's route is Compute's byte for byte except `computed_at` (the
  route provenance's clock), and every route on the grid
  carries its digest, so a picked departure's Check admits the same grid.
- **Drawn** (`resolveComparisonCurrent`, from `scanDepartures` without a current
  input): the same rule on the route's samples, with no routing.
- `CurrentInput.coverage` lists the departures left out and the last covered one;
  the scan result then carries `current_reach` with `last_departure_utc` (the
  later of that and the last assessed time, so a refinement can extend it) and
  `not_covered` (how many were not assessed because the grid does not cover them,
  refined ones included). A departure left out can be earlier than the last
  covered one, when its own passage outlasts the grid (an adverse current), so the
  planner counts them instead of calling them later. Under the comparison's
  heading: "This comparison used the regional current model, which covers
  departures up to {time} local time; {N} departure times it does not cover were
  not assessed." ("1 departure time … was not assessed" in the singular; French
  through one anchored `FR_PATTERNS` entry, singular for 0 and 1, with the
  template's fragments in `FR` for the coverage scanner). The mark then reads
  "◎ Least exposure among the assessed departure times: {time} local time" instead
  of "◎ Least exposure this window: …", and the all-"models disagree" sentence says
  "at every assessed departure time" instead of "throughout this window". A
  comparison the grid covers entirely, or one on tiles, has neither field and
  keeps the earlier wording.
- Refinement adds times as before and assesses only those the grid covers on that
  same grid (`routeOnSelectedCurrent`, `admitPrepared`). Ranking, ties, limits hours
  and baseline-relative fields are computed over the assessed departures only, as
  for any comparison with unassessed departures. Scan results are still never saved;
  no saved identity changes, and the scan golden (tile currents) is unchanged.
- The download line before Compare is unchanged and stays an upper bound: a computed
  comparison reads the tile currents before choosing (they are its fallback), and a
  drawn comparison's quote counts them ("up to").

Tests: `engine/test/comparisonCurrent.test.ts` (computed and drawn: partial
coverage, the first departure's route equal to Compute's, a picked departure's
Check, refinement, each fallback reason, a covered departure without a route,
full coverage equal to before), `engine/test/currentAdmission.test.ts`,
`viewer/test/scanRegionalCurrent.test.jsx` (`runScanAction` computed and drawn,
the Worker handler for a comparison and its refinement, the line in English and
French in the plural and the singular, a departure left out earlier than the last
covered one with its line and list, the mark and the "models disagree" sentence of
a cut comparison in both languages, no line when the grid covers every departure
or on tiles).

Regression ownership: `engine/test/currentAdmission.test.ts` covers admission,
fallback, finite samples, partial coverage and single-source scans, for audits
and for routing, including the confined router (inside the box, every read and
waypoint in it and the Check on the same digest with `time_step_h: 1`; an end
outside, time not covered, land closing the box, a cell without value, one
failing departure, exact retry, refinement, and byte-identical results where the
box never holds the search back, including a dead-end inlet outside the box
that the search pops but cannot expand); `routingTiming.test.ts` reproduces the
committed `routed-current.json` byte for byte with the box;
`routeSourceNotes.test.jsx` the note in English and French; `viewer/test/actionInputs.test.jsx` crosses the real loader,
action bundle, engine and ModelsUsed UI, including a computed route and its
Check on one source; `plannerComputed.test.jsx` crosses visible limits,
failed persistence, in-flight edits and Compute → Check → Scan on one current
source. `viewer/e2e/action-inputs.spec.js` and
`routing-timing.spec.js` exercise Check/Scan and saved reopening on desktop and
mobile, using synthetic transport, fresh storage, blocked telemetry and
intercepted POSTs. Demo fixture files must stay untouched.

Responsiveness measurement (not a test, never run by `npm test` or `npm run test:e2e`):
`npm run perf:node`, `perf:prepare`, `perf:browser` and `perf:serve` time Compute and the
departure scan on synthetic inputs of real size; see
[the record](maintenance/2026-11-12-scan-responsiveness.md) for method, results and
how to repeat it on a phone. Output goes to the git-ignored `output/perf/`.
`engine/test/scanHashing.test.ts` holds the hashing change that record measures
without timing anything: it counts `contentHash` calls (no candidate decision
input and no shared current grid hashed in a scan; a grid the scan reads itself
hashed once per scan; a Check's grid hashed once), compares a scan with and
without its candidates' saved identity byte for byte, compares a Check's saved
decision inputs and findings with a separate build from the same options, and
shows that an audit without identity cannot be saved and that a copy of its
options gets the identity back. Findings audited without identity (a scan's
candidates only) keep `identity_version: 2` with no `decision_hash`, so they are
invalid against `contracts/findings.schema.json` by construction: they are
scan-internal and must never be exposed, saved or validated; keeping a
candidate's audit takes a full Check. `engine/test/scanGolden.test.ts` pins a
fixed four-departure scan (its `WindowScan` and progress candidates) byte for
byte against `engine/test/golden/scan-cherbourg-plymouth.json`, generated from
the engine before this change (see the fixture policy below).

Prepared grid digest (2026-11-13): `engine/test/hash.test.ts` proves the
16-bit-limb FNV-1a equal to the BigInt definition. The corpus is every file under
`engine/test/fixtures`, `engine/test/golden` and `contracts/` (raw, gunzipped and as canonical JSON), every
single code unit and byte, million-unit inputs and 3,000 seeded random strings,
byte arrays and part lists with surrogate pairs and lone surrogates. It also
covers `cachedContentHash`: a mutable, partly frozen or getter-bearing value is
hashed afresh; a deep-frozen one is serialised once.
`engine/test/currentAdmission.test.ts` ("one digest per loaded prepared grid") counts serialisations of a loaded grid
(through `Object.entries`): one for a Compute, a comparison with its audits and a
refinement; a Check adds only the grid inside its saved decision inputs. A grid
that is not frozen and was changed after its record is recorded with its new
digest. `viewer/test/actionInputs.test.jsx` and `viewer/test/scanWorker.test.js`
make the same count through the real loader, Compute selection, Check, computed and
drawn comparisons and refinement.

Departure ranking: `engine/test/window.test.ts` covers the hour figures on
hand-built findings (each arrival-range hour counted once across overlapping
legs and several limits, over before missing data before approaching, missing
values for each limit including a steepness that lost its wave period, a layer
missing from every candidate of a scan, an undeclared limit, the expected-timing
count apart) and `rankCandidates` in both modes: key order, ranking on the arrival
range rather than the expected timing, the worst-case severity for times with
missing hours against fully known "within", "approaching", "insufficient",
"exceeds" and "warning_active" times, "insufficient" times with known hours over a
limit ranked at the exceeds level, the 5 % and one-hour tie edges, ties
measured against the marked time only (a chain of one-hour steps does not tie its
far end), `Infinity` and `null` ratios, and the first candidate kept on equal
values. Generated scans (fixed seeds 1 to 200; 1 to 5 legs, some under an hour,
all five limits, shared and unshared missing hours, verdicts from reasons that are
not hours, verdicts consistent with the known hours) check that a time with
missing hours is never marked ahead of a fully known time that is not over a limit
and has no official warning; that with no missing hours the result equals the
committed C4 ranking (f38b319) except for "insufficient" times with hours over a
limit, which now rank at the exceeds level (no longer tied with, and in Cautious
no longer marked ahead of, an "insufficient" time without any); and that the
marked time does not depend on input order.
`viewer/test/departureComparison.test.jsx` covers the toggle, the tie mark and
summary, the tooltip hours and gust difference in English and French, hours over a
limit that fall outside the expected timing, a "within limits" cell with missing
hours ranked after a fully known one without changing its colour, and the summary
note when the marked time itself has missing hours, and the "?" mark on the face of
a cell with missing hours with its legend, in English and French. A scan is never
saved, so neither suite touches a fixture, a schema or a saved identity.

Near-line mark (2026-11-14): `engine/test/nearVerdictLine.test.ts` covers
`nearVerdictLine` at and either side of 0.65, 0.85, 0.90 and 1.10 of the limit
(exact boundaries are outside the margin), a custom approaching ratio, a missing
or non-finite reading, and verdicts the reading does not give (raised by
scenarios or another cause, "models disagree", an official warning), which are
never marked; `worstReadingRatio` on hand-built rows (each wind against its own
point-of-sail limit, the default limit without one, "ok" hours, wave height and
steepness only when declared, visibility left out, null without values) and its
agreement with the wind, gust, wave and steepness evidence ratios of the
committed findings; scan candidates of every verdict, "within" included, carrying
`worst_reading_ratio` and the mark, on progress candidates too, the margin
applied before rounding, and the profile's approaching ratio; and the mark and
the ties of both rankings unchanged with the fields removed or flipped on the
golden's candidates. The refinement equality (`refineScan.test.ts`,
`refineScanFixtures.test.ts`) and the scan golden cover the new fields as they
stand. `viewer/test/departureNearLine.test.jsx` covers the "±" sign and the
tooltip sentence on a marked cell only, with the cell's classes and colour
unchanged, the legend entry only when a cell is marked, a scan without the fields
rendering exactly like one with every mark off, the fixed caption unchanged, and
the French sentence and legend, and a cell both tied and near a line showing
"≈" after its glyph and "±" in its corner, each legend entry once.
`viewer/test/missingForecastHours.test.jsx` covers the passage page's count of
arrival-range hours missing a value a recorded limit needs (read from the saved
`findings.legs`; a declared layer with no value anywhere counts; a time over a
limit counts as over), the statement in the decision band on any verdict, the
qualified "within" next step, and both in French. The verdict is unchanged; the
demo fixtures have no missing statuses, so the tests edit a clone in memory.
`viewer/test/format.test.js` and `routeTimelineTable.test.jsx` cover `hourStatus` reading an
hour with an unknown or absent recorded limit as missing unless exceeded or approaching;
`coverageHours.test.jsx` covers the coverage panel's wind/gust/wave/visibility hour counts
(English and French). All edit in-memory clones; nothing saved changes.

## The audit's forecast reading (passage-audit-4)

Since 2026-11-14 a Check reads the forecast along each leg
(`engine/src/auditSampling.ts`, the store's interpolated point reads; see
[saved identities](saved-identities.md)). These tests cover it:

- `engine/test/auditReading.test.ts` runs the real audit (`runAnalysis`) on a
  real `TileForecastStore` over invented analytic PFT1 fields, using only entry
  points the earlier engine had, so it can be run against that engine
  (`git archive <commit> engine config contracts package.json`, the repository's
  `node_modules` linked in): (a) wind rising past the limit along one long leg
  is "exceeds" although the midpoint was not; (b) a strong patch at a turn
  between two old midpoints is found on both legs; (c) a route 1.4 nm inside the
  weak half of a cell next to a sharp band is not flagged, and reads exactly
  what interpolation between the rows gives; (d) one track drawn as 1 and as 6
  legs gives the same hours over and peak, and as 4 legs within one hour;
  (e) the 0.5° ensemble is read on its own grid at 49.13 N, not at the 49.5 N
  row a doubly rounded point gave; (f) a point is not judged before the boat can
  reach its stretch (strong wind there earlier is ignored; later it is found,
  from 10:00 to the ceiled slow arrival); (g) a wave point with a land-masked
  neighbour reads the nearest sea grid point, and none when all four are land;
  (i) a departure comparison and the Check of each of its departures give the
  same verdict, hours over and expected hours over; (j) the download estimate's
  points are the points the store is asked for, and its weather tiles are
  exactly the fetched ones for a leg whose last point interpolates across the
  50 N tile line. Against the engine before the change all nine failed; (i)
  only on its guard that the departures differ (the comparison and the Check
  already agreed).
- `engine/test/auditSampling.test.ts`: placement (stretches of at most 10 nm, a
  short leg keeps its midpoint, ends within 5 nm, deterministic, never on a
  lattice, the same points for a track cut on stretch boundaries), each point's
  hours (earliest entry to latest exit of its stretch; every leg hour has a
  point), the expected position (clamped), the missing-neighbour rule
  (`interpolateAtPoint`: weighted mean, nearest valid neighbour, missing; u and
  v from the same neighbours), and the expected timing: each row's `expected`
  is the reading at the boat's nominal position and never above the row, the
  route summary and the expected hours over a limit use it while the arrival
  range uses the rows, the ensemble plume follows the expected position, and a
  row without `expected` (single-point legs, older findings) is read as it is.
- `engine/test/tileStore.test.ts` (tile edges): interpolation across a 10° line
  with the neighbour's first row or column at 0.25° and 1/12°, four tiles near
  a corner, a point on a grid point opening no neighbour, beside an unpublished
  tile the published grid point read when it is the nearest and nothing when the
  nearest is unpublished (a land-masked grid point inside a published tile is
  replaced by the nearest valid one: `auditReading.test.ts` (g)), offset grids
  and the antimeridian.
- `engine/test/auditSampling.test.ts` (every sample point of an hour counts):
  models splitting near the limit at one point make the verdict insufficient
  although another point spreads more in light wind, and the evidence shows that
  point; 15 of 51 scenarios exceeding only at one point and another 15 only at
  the other count as 30 of 51 (the largest single-point count, 15, is under the
  0.3 floor), and that evidence names no point; rounding: over 20,000 values a
  compared quantity rounded up (or visibility down) never turns a comparison
  with a limit or the approaching threshold off and moves by less than one step,
  and an interpolated 17.808 kt gust still exceeds a 17.8 kt limit.
- `engine/test/legacySnapshot.test.ts`: a check saved under `passage-audit-3`
  still verifies and opens; the same inputs checked now evaluate to the same
  findings once the new fields are left out, apart from the identity and the
  current time step that checks record since 2026-11-13; a retry is a new check
  beside it (above).
- `viewer/test/expectedPositionDisplays.test.jsx`: on a leg read at several
  points, the plume's shading comes from the check's counts and never from its
  lines, a caption says what each is (English and French), the plume table
  lists the check's count or "not audited", the scenario spread says "at your
  expected position along your route" (both languages), the route timeline's
  table lists the chart's own rows and values, and a leg's map arrow reads the
  expected reading at the leg's middle hour, drawn at that sample point; a check
  read at one point per leg shows them as before.

Known limit: an hour's wind row is the wind of the point with the highest wind
against its own point-of-sail limit, which is not always the strongest wind read
that hour when the point of sail differs between points, so peak-wind figures in
the briefing and the comparison can read slightly under the strongest wind read.
- `viewer/test/routeTimelineExpected.test.jsx`: the route timeline draws an
  hour's `expected` reading, and an hour without one from its row.
- `analysis/tests/test_contracts_and_providers.py::test_findings_sample_points_are_optional_and_additive`:
  the findings schema accepts the legacy fixture without the new fields and the
  regenerated golden with them, and rejects malformed ones.

Tests that build audit options by hand copy each leg's series to every sample
point of that leg (`engine/test/helpers/samplePoints.ts`); the scenario fixture
store does the same from a bundle's one location per leg. The engine goldens
(`findings-cherbourg-plymouth.json`, its briefing, `scan-cherbourg-plymouth.json`)
were regenerated with `UPDATE_GOLDEN=1 npm -w engine test` and
`npx tsx engine/scripts/make-scan-golden.ts`: verdicts, hours and peaks are
unchanged (one series per leg), the findings gain `sample_points`, `expected`
on the three multi-point legs and `sample_point_id` (not on ensemble evidence,
whose count spans the points), and the identity and the input point counts
(6 to 13) change.

## Saved identity and history regressions

`engine/test/snapshotIdentity.test.ts` covers changed authority/tide/gate/prepared,
forecast, geometry, profile and engine inputs; tile cache/retrieval clocks;
exact retry; and partial/conflicting write-once preservation. Current engine
goldens intentionally contain the new identity/version fields; the verdicts,
evidence and briefing text remain unchanged. Existing demo/compatibility files
remain byte-identical.

`viewer/test/passageIdentity.test.jsx`, `plannerIdentity.test.js` and
`localSnapshots.test.js` cover intent grouping, chronological/tied predecessors,
draft migration/reopen and byte-preserving artifact round trips. The existing
scenario/contract suites and Python consumers validate both old saved records
and additive identity-v2 fields. `viewer/e2e/passage-identity.spec.js` exercises
real Check/retry/revise/new intent, saved reopen, three-check comparison and
unrelated-history preservation during scratch deletion and rejection of an
interrupted browser save at both viewports.
Run it through the existing viewer-demo launch configuration; intercept every
POST/DELETE and block telemetry/external transport. No production data proof
is implied.

All-or-nothing saves: `engine/test/snapshotAtomic.test.ts` pins `decision_hash`
and `snapshot_id` for a fixed input to values from the engine before the change
(pinned again on 2026-11-14 for engine semantics `passage-audit-4`),
the compact `decision-inputs.json`, exact retries of compact and indented files,
one `writeAll` call with the manifest last, a failure part-way that leaves
nothing, and the sequential path of a store without `writeAll`.
`viewer/test/localSnapshots.test.js` injects into fake-indexeddb a quota error on
a request and on commit, a plain abort and a throwing `add` on a later file:
each leaves no record and no `list()` entry, and the same check then saves; a
pre-existing partial record still refuses the batch byte for byte.
`viewer/test/browserSnapshotSave.test.js` runs the real Check path
(`analyzeInBrowser` → `persistSnapshot` → `FallbackSnapshotStore` → IndexedDB)
with a quota failure, a pre-existing partial and the dev middleware's 409 (both
a blocked save, `SnapshotExistsError`) and a browser without IndexedDB.
Compressed storage (2026-11-15): `localSnapshots.test.js` saves a check
with a route name outside Latin-1 and reads every file back string-equal, the
manifest stored plain and the other files as gzip bytes; reads a plain record
written the way earlier builds wrote it; stores plain a file gzip does not
shrink and a check whose `CompressionStream` is missing, throws or fails
mid-stream; with a deliberately slow codec, compresses every file before the
one readwrite transaction opens, and the quota, abort and throwing-`add`
failures still leave no record; a truncated, non-gzip, unknown-encoding or
undecodable (no `DecompressionStream`) record reads as unreadable, never as
text, while the check still exists, its opener fails and `writeAll` is still
refused; a codec whose gzip decodes to different text or cannot be decoded,
and a browser with `CompressionStream` but no `DecompressionStream`, store the
check plain and read back the original; delete removes a compressed check. `browserSnapshotSave.test.js`
checks that a saved Check's `decision-inputs.json` record is under a quarter
of its JSON text, that an exact retry reopens a compressed and a plain Check
without an `add`, that an undecodable decision-inputs record is a blocked
save keeping its bytes, that an abort or throwing `add` with compressed
records is a plain failure leaving nothing, and that delete removes it all.
Reopening after a reload (2026-11-15): `viewer/test/openCheckReload.test.jsx`
remounts the app on the same URL and tab after opening a browser-saved check
(the demo files served through a mocked local store) and finds the same check
open from the local copy, the URL still `#passage` and no request for it to
`/data/snapshots/`; the same at `#passage/evidence` after opening from My
passages; the empty state, without an alert, when the check is gone; nothing
reopened after the check is deleted, after a served check was opened in the
tab, or on another page. The first two failed before the change.
`viewer/e2e/fixture-persistence.spec.js` reloads after the real Check and
again after reopening it from My passages, comparing the check id, findings,
briefing and page sections. `viewer/e2e/sharing.spec.js` opens two
browser-saved checks in two tabs of one context and reloads each to its own
check, keeps Share disabled, goes My passages → reload → Back → Forward → Back,
reloads a served deep link (still served), and reloads the second tab after the
first deletes its check (empty state, no alert). Both browser steps failed
before the change, on the decision band after the reload.
Storage line on My passages (2026-11-15): `viewer/test/storageUsage.test.js`
returns null for a missing API, a throwing or rejecting `estimate`, and a zero,
missing, negative or non-finite quota or a missing usage; puts shares 0.4999,
0.5, 0.7999 and 0.8 (and the same in whole bytes) at `ok`, `high`, `high` and
`nearly-full`; formats less than 1 MB, 1 MB, 29 MB, 999 MB and 1.2 GB; and shows the percent rounded down
(0.796 reads 79 %) and at most 100 %.
`viewer/test/passagesPage.test.jsx` finds the exact English sentence at `ok`,
the sentence without "about" below 1 MB (English and French), the share sentence from `high`, the caution only at `nearly-full`, nothing when
the estimate is missing, throws or has no quota, the line after the list and
the example button (nothing existing moves), the list shown before the estimate
resolves, a second read after a delete and none after a failed one, no call to
`persist()`, and the French sentences at each level. `viewer/e2e/fixture-persistence.spec.js`
matches the sentence in real Chromium with a number pattern, never a fixed
size; My passages is in no screenshot baseline, and the line must stay out of
any future one because its size differs on every machine and run.
Asking the browser to keep saved checks (2026-11-15):
`viewer/test/storagePersistence.test.js` returns true, false and null (missing
API, missing `persisted()`, a throwing or rejecting call, a non-boolean
answer); asks nothing when `persist()` is missing or `persisted()` is already
true; asks once and remembers the time under `deepweather.persist-asked-at`;
does not ask again until 30 days later (29 days and 30 days less a
millisecond: no; 30 days: yes); ignores a remembered time in the future and a
garbage value; asks when `persisted()` throws, rejects or is missing; swallows
a rejecting or throwing `persist()`; asks every time with blocked
`localStorage`; and does not repeat a request that never answers.
`viewer/test/browserSnapshotSave.test.js` asks exactly once after a real
browser save (and not again for the exact retry), returns the save's result
while `persist()` never resolves, shows no unhandled rejection when it rejects,
does not ask after a 'storage-full', 'blocked' or 'failed' save, and does not
ask for a check the dev middleware wrote. `viewer/test/passagesPage.test.jsx`
finds the exact English and French "not kept" sentence when a local check
exists and `persisted()` is false, also without the API or when it throws and
without a usage estimate, none when `persisted()` is true, with no check or
with only the served example, the line after the list and the usage line, the
list unchanged when the answer arrives, and a second read after a delete.
`viewer/test/privacyPage.test.jsx` pins the new privacy sentence and the
"15 November 2026" date in English and French and in the prerender source.
`viewer/e2e/fixture-persistence.spec.js` counts calls to
`navigator.storage.persist` with an init script: none at load, one after the
real Check, still one after reloads and My passages, where the line shows
(headless Chromium reports `persisted()` false). My passages and the privacy
page are in no screenshot baseline.
The closest-limit line from the check's own record (2026-11-15):
`viewer/test/closestLimitLine.test.jsx` opens a calm Check made through the real
engine (verdict within) on a fresh store with no limits draft and finds the
"Closest to your limits" sentence, the same band and the same initial selection
as with the draft loaded; the band unchanged after the limits are edited and
after a reopen with the edited draft; the same sentence on a served deep link
and translated in French; no line for a check without `decision-inputs.json` or
whose recorded profile does not match its hash; and the example and the three
legacy compatibility checks unchanged with and without the draft. The first
four, and the check without `decision-inputs.json` (which took the line from
the draft), failed before the change. `viewer/e2e/fixture-persistence.spec.js` now
compares the decision band text before and after both reloads (its init script
brings back other limits on each load) and failed before the change on the
first reload, without the line.
`viewer/e2e/routing-timing.spec.js` now expects its reload after the rerouted
Check to reopen that check (same id and arrival) instead of the empty page.
`plannerFeedback.test.jsx` and `plannerFeedback.copy.test.js` cover the three
save-failure sentences (storage full, blocked, any other) in English and French,
with the browser's text only under Technical detail.
Damaged or hostile check content (2026-11-15):
`viewer/test/pageErrorBoundary.test.jsx` opens a browser-saved check (the demo
files through a mocked local store) whose first leg's hours are not a list, so
the passage page's sections throw while rendering, and finds the exact English
and French fallback ("This page could not be shown.") in the page area with the
header and both navigations still there, the error logged with
`console.error` and not again later, the tab's remembered open check forgotten
and a remount on `#passage` showing the empty state, recovery through the
header's My passages, a `hashchange` and the fallback's own button, a second,
different check opening normally (and remembered), no analytics request about
the error, a fallback that fails itself leaving the page area empty without
re-rendering, keyboard focus on the fallback's heading inside the alert, and a
single reset (one log line) when the fallback's button leads back to My
passages after My passages itself failed (two before). `viewer/test/inspectorErrorBoundary.test.jsx`
opens the inspector of a browser-saved check on an evidence record whose units
are an object: the page stays, the inspector closes with nothing selected, one
note "This evidence detail could not be shown." (and in French) appears and
nothing more is logged, the remembered open check stays, the header's My
passages and Plan then navigate, the page fallback's button navigates when the
page and the inspector both fail, and another evidence record then opens
normally; before, the page fallback replaced every page until a reload.
`viewer/test/pageChunkError.test.jsx` makes a page's code fail to load with
Chromium's message and finds "This page could not be loaded." (and in French)
with focus on its heading, the remembered open check kept, a "Reload the page"
button that does one full reload and navigation to a page that loads; and
`isChunkLoadError` recognises the Chromium, Firefox, Safari, Vite CSS-preload
and `ChunkLoadError` forms and none of the render errors, a bare
"Failed to fetch", a string or a value that is not an error; before, a failed
import showed the damaged-content message and forgot the remembered check.
Saving a copy of a check to a file (2026-11-15): `engine/test/checkFile.test.ts`
builds the document from the demo check and finds the fixed key order, the
format and version, every file text byte-identical after a JSON round trip
(also texts outside Latin-1, with CRLF, escapes and a no-break space), the
decision inputs hashing back to the id, the same text whatever order the files
and clock arrive in, and refusals for an id that is not a v2 id, a missing
required file, an unknown file such as an import marker, a file that is not
text, a bad clock and an empty version; the file name takes the UTC date of the
departure (also across midnight with an offset) and the id's hex, and refuses
an id that is not a v2 id. `viewer/test/checkFileExport.test.js` saves the
earlier demo check (its manifest names only the files a browser-saved check has)
with `writeAll` in a fresh fake-indexeddb and finds the gzip bytes decoding to a
document whose files equal the stored texts and whose decision inputs hash to
the id; the same text from the check stored plain; the demo check and a route
carrying a boat id, polar scaling and leg speeds passing the real no-polar-data
rules; a polar-shaped table (invented and built at run time) in `route.json` and
a `vpp` block in `findings.json` refused, with no Blob handed to a download; a
damaged check, with no download, when the manifest names another `snapshot_id`
or `decision_hash`, is not identity 2, is not JSON, names no files or leaves out
a required one, when the decision inputs no longer hash to the id or are not
JSON, when `findings.json` names another check or decision hash, and when a
stored record's content is not text; a manifest naming a file a check file
cannot hold refused rather than copied without it; a made copy handed to the
download once; and plain outcomes for a file the manifest names but the store
lacks, a check not saved here, no `CompressionStream`, an id that is not a v2
id and an import marker never exported. `viewer/test/saveCheckCopy.test.jsx`
offers the button only for a browser-saved v2 check (not served, the example, a
legacy v1 check, nothing open, loading, a failed open or no
`CompressionStream`); finds the empty live region before a save, focus kept on
the button through the save (`aria-disabled`, never `disabled`), the busy
label, a second press starting nothing, then "Copy made…" in the same live
region in English and French with one gzip download and no request beyond the
check's own reads; the four failure messages (unreadable, damaged, polar, any
other) in English and French with no download; each check keeping its own
outcome when a save of check A finishes after check B's save started (B stays
busy, then shows its own outcome; A shows "Copy made" when reopened); no
outcome shown for another check; and the button right after "Share this check"
on the passage page of a browser-saved check and not on a served one.
`viewer/e2e/check-file.spec.js` makes a real Check in fixture mode (desktop and
mobile), saves a copy, reads the download and finds the file name, the format,
version, key order and check id, the files equal to what the browser stored and
the decision inputs hashing to the id, and no analytics event for it.
Importing a check from a file (2026-11-15): `engine/test/checkFile.test.ts`
reads a valid file into the check with its texts exactly as given, runs the
contract callback on every file but the decision inputs, and refuses as not a
check file (not JSON, another kind or format, version 0 or as text, an unknown
document field, no export time, a repeated document key), as newer (version 2),
as the wrong count (zero or two checks), and as damaged an unknown check field,
an id that is not v2, an import marker or another file name, missing decision
inputs, a file that is not text, not JSON or an array, the keys `__proto__`,
`constructor` and `prototype` in every file, a key repeated within one object
(escapes included), a manifest naming a missing, extra or repeated file or
none, and each identity break: another id, decision hash, identity version,
route revision, passage, limits hash, departure or verdict in the manifest;
decision inputs that no longer hash; a route or synoptic file that is not the
inputs'; another check, verdict or route hash in findings; 200,000 legs or a
missing leg; a briefing or plume for another check or a briefing with another
verdict; a manifest with a served check's `demo` flag or any other field,
artifacts under other keys or naming other files, another input hash, a check
sequence of 0, 1,000,000, 2^53, 1.5 or text, no save time, nesting past 64
levels and a string over 64 KiB in an open findings field (50 levels and 60
KiB pass), and reasons that never quote a key; with the import's time bound, a
save in 2099 or 24 hours and a second ahead is "future-time" while 24 hours
less a second passes, and without it (the export) 2099 passes; a save before
findings' time and a file made before the save or "in 2030" pass; it accepts
a briefing whose decision names no verdict and sequences 1 and 999,999; `jsonKeyProblem` finds repeated and
forbidden keys and ignores text inside strings. `engine/test/snapshotIdentity.test.ts`
finds `writeSnapshot` writing exactly `SNAPSHOT_MANIFEST_KEYS` with artifacts
named as `SNAPSHOT_ARTIFACT_FILES` names them, and a safe next check sequence
whatever a store lists (2^53, 1e300, Infinity, text, fractions, negatives and
the largest safe integer ignored) and listed checks marked `imported: true`
left out of it (3 and an imported 999,999 give 4; only the imported one gives
1). `viewer/test/checkFileValidators.test.js` compares the vendored
date-time format with ajv-formats on 17 values and finds the precompiled
validators accepting every file of a real Check and refusing seven wrong
shapes; the synoptic validator accepts the engine scenario synoptics, which
have no `route_transitions`. `viewer/test/checkImport.test.js` (a real Check of the calm scenario,
fresh fake-indexeddb) imports a file and finds the texts stored exactly, the
marker's fields, `imported: true` in `list()`, the large files compressed at
rest and the marker never in the manifest; export → import in a clean store →
export giving the same texts without the marker; "already here" over the same
check saved or imported (store unchanged, no marker); a conflict over another
check stored under the id (unchanged); a quota failure on the marker leaving
nothing; no request at all (an import with every request failing works, with
the served ids the page read); and a refusal for now when the page never read
them. Each of 28 hostile files
leaves the store byte for byte unchanged with its outcome: not gzip, empty,
truncated or corrupt gzip, a gzip bomb past 64 MB, a file over 16 MB, invalid
UTF-8, other JSON, text, GPX, a newer version, two or no checks, a repeated key
in the document or a file, an import marker, another file name, decision
inputs that no longer hash, another verdict, 200,000 legs or waypoints, wrong
types, a verdict of the wrong type everywhere, a chart path with `..`, markup
in the route name, the served example's id, `__proto__` and `constructor` in
every file, a save in 2099, sequences 0 and 10,000, a `demo` flag, nesting 70
deep and a 70,000-character string in an open findings field, a file made
after the import time; plus polar data in an open findings field, behind a
unicode-escaped key and inside a JSON string; no logged line quotes names,
positions or markup. Six checks the engine makes (the calm check, another
passage and departure, a name outside Latin-1 with markup, a reference-demo
and a storm synoptic without `route_transitions`, a route with a boat
reference) each export, import into a clean store and export again with the
same file texts and name. `viewer/test/importCheck.test.jsx` finds the control and its note
(English and French), none without `DecompressionStream`, an imported check
joining the history of a check saved here after it with the label carrying the
check's own time (English and French), the open button, "already here" writing
nothing, the not-a-check-file and damaged messages (English and French), the
label on the passage page and none for a check saved here, and "Save a copy to
a file" for the imported check; the station "Check 1 · imported" and the
comparison note on the card and in the passage page's change story when the
imported check is the earlier of the sailor's own; the control shown when the
served list failed, then refusing for now; an import with every request
failing after the page read its lists; two imports ending in the same words
both announced (the live text clears between them); and a whole Check whose
route name is markup imported and shown as text, with no element made of it.
`viewer/test/checkFileExport.test.js` also refuses a copy whose findings hide
polar data behind a unicode-escaped key or inside a JSON string, and copies a
whole Check whose route keeps a boat reference. Round 3: `checkImport.test.js` imports a check
saved by a clock 10 minutes fast and exported after the correction (its
`exported_at` before its `created_at`) on a device with the right clock, and a
file whose `exported_at` is earlier than the save; after a forged import with
sequence 999,999 on the sailor's passage, their own next check (saved through
`persistSnapshot` and `localSnapshots`) gets sequence 1, exports and
re-imports. `importCheck.test.jsx` finds an imported check saved at the same
time and sequence as the sailor's own ordered before it, with both comparison
notes on the card and the passage page's change story (no "order unavailable"),
"+2 more checks (2 imported)" when imported checks are folded, the station
button named "…, imported from a file" and "…, importée depuis un fichier",
and the future-time message in English and French with nothing stored.
`checkFileExport.test.js` refuses a copy one byte over either cap ("too large")
and copies a check saved "in 2099". Proving a check once (stage 2, part 1):
`engine/test/checkFile.test.ts` finds `parseCheckEntry` giving the same check
as `parseCheckFile` without the document's fields, the decision inputs'
canonical JSON it hashed, and "damaged" and "future-time" for one entry;
`checkFileExport.test.js` still reports decision inputs that no longer hash as
damaged when polar data is also in the check; `viewer/test/polarSafetyNet.test.js`
finds a given canonical text read in place of its own value's only (an equal
copy gets its own), the other values' canonical JSON still built, long strings
still walked and the raw texts still read. Check file, version 2 (format only):
`engine/test/checkFile.test.ts` writes a header, the lines of the committed
earlier demo check and of a check the engine makes now (a name outside
Latin-1 with markup) and a trailer, each compact JSON ended by one newline, and
reads each back (the entry proven as `parseCheckEntry` proves it, texts exact,
exactly a version-1 entry); finds the same text whatever order the files and
clock arrive in; a digest that tells apart file sets whose texts concatenate
alike, an empty file from none and a file under another name, and none for
files no digest covers; refuses as not a check line an extra or missing key,
keys in another order, a digest in capitals or as a number, a version-1
document, a header, a carriage return, a leading space, not JSON, an array,
`__proto__`, a repeated key and nesting past 64 levels; as a bad digest one
hex off, one file changed by a character and a file dropped; keeps the proof's
own reason ("damaged" for another verdict, a repeated key in a file, decision
inputs that no longer hash, a marker, a file that is not text, files that are
not an object; "future-time" with the bound, a check without it; the contract
callback's refusal); never quotes a key; tells a header of version 3 apart and
refuses 18 other headers (version 1 or as text, another format, a version-1
document of version 1 or 2, an extra or missing key, another key order, a
non-canonical or missing time, an exporting version of 201 characters or
blank, spaces, a carriage return, an escape, a repeated key, over 4 KiB, not
JSON); refuses 11 trailers (another count, none, as text, negative,
fractional, written 2.0, another end, an extra key, another order, a carriage
return, a check line) and 1,001 as too many checks while reading 0 and 1,000;
refuses to write what it would not read; names the file by the UTC minute
across midnight; and keeps the version-1 constants. `viewer/test/checkFileLines.test.js`
(the stream reader, over gzip made by `node:zlib`; jsdom's `File` has no
`stream()`, so it reads Node's own `File` and `Blob` from `node:buffer`, a
stand-in Blob that gives the compressed bytes in chunks of a chosen size or at
chosen offsets and records a cancel, and `checkFileLinesOf` fed inflated chunks
split exactly) yields the header, two real check lines that prove and the
trailer, the same through compressed chunks of 1, 7 and 4096 bytes, a trailer
without its newline and no checks; stops at a header of version 3; hands 12 files to
the stage 1 path as version 1 (a real check file with and without a final
newline, small documents with and without, a document of version 2 with its
checks, a CRLF ending, a version-2 header ended by a carriage return, GPX, no
text, a first line that is not UTF-8, a byte order mark, 64 KiB of zeros),
after reading only the start of a large one and releasing its stream, also
for gzip cut short or followed by another member inside the first line, with
stage 1 then giving its own outcome for the same `File` ("newer", or the
check); refuses not gzip, an empty file and no file, and a file one byte over
the compressed cap from its size alone while reading one at the cap; reads a
check line of exactly the line cap (also in two-byte characters) and refuses
one byte more; stops an endless line after 11 of its 1 KiB chunks; reads a
header at exactly the header cap and hands it to version 1 one byte under;
reads a trailer of exactly 4 KiB and refuses 4,097 bytes; reads at and refuses
one byte past the inflated cap; refuses a third check line over a cap of two;
refuses as truncated a file ending after a check line, a last line without its
newline (never yielded), a header alone, a header without its newline, a
trailer cut short, and gzip cut short or damaged after its first kilobyte;
refuses another line, a second newline or a byte after the trailer, junk and
zero padding after the member, and a second member after the trailer, empty
or holding the rest of the lines, also where the decompressor stops cleanly at
the first member's end; refuses a member failing its check after the trailer
as corrupt; refuses an invalid byte, an overlong encoding, an encoded
surrogate and a sequence cut by the newline; decodes a line with characters of
two to four bytes split at every byte across two chunks and one byte per chunk;
keeps a carriage return and a byte order mark in the line, which the engine
refuses; and stops for an aborted signal (reading nothing) and an abort after
the header, releasing the stream then, on a refusal and when the caller stops
early. Review round (stage 2, part 2b): `checkFile.test.ts` pins the exact
header, check line and trailer of a small check (files given out of order, a
character outside the Basic Multilingual Plane, an empty text, a newline) and
its digest, computed in the test from the definition on BigInt and
hard-coded; and takes `exported_by` of printable ASCII only (four accepted,
nine refused in the writer and the reader: Latin-1, a tab, a newline, NUL,
DEL, an emoji, 201 characters, empty, blank). `checkFileLines.test.js` throws
a trailer with another count, spacing or 1,001 checks after yielding the
lines before it; yields all 50 lines of a file whose CRC is bad (its footer
arriving alone) before refusing it as corrupt, and 49 of 50 when the text is
cut inside the last; holds a line of more than 1 MB of two- to four-byte
characters as text with never more than seven bytes kept; reads gzip whose
header carries FEXTRA, FNAME, FCOMMENT and FHCRC; writes member sizes modulo
2^32 and checks the file's end and a second member alike with sizes injected
past 4 and 8 GiB; says aborted for an abort during the second-member scan; and
says unreadable when the file's first or last bytes cannot be read.
Export of all checks (stage 2, part 3): `viewer/test/allChecksFile.test.js`
(fresh fake-indexeddb, checks the engine makes; the core is given Node's
`Blob`, since jsdom's has no `stream()`) finds four checks stored in shuffled
order written newest first and by id at the same time, each line proving
with its texts exactly as stored and equal to `checkFileEntryLine`, the
header, trailer, name and progress; a legacy, a damaged, an unreadable, a
polar-shaped and a too-large check each left out and counted while the other
two are written and nothing is logged; an imported check included without
its marker; every file of one check read only after the previous check's line
was written; the check cap, the inflated cap and the compressed cap each
stopping with the newest checks, the rest counted, the file whole and within
the cap; nothing when not even the newest fits; an abort mid-way and before
the start keeping nothing; a compressor that alters a byte of a line, and one
that damages the gzip, each failing the whole backup at the read-back; nothing
to save for an empty store, only a legacy check or only a damaged one; and the
public entry point with the page's own store and compressor. Import of many
checks (stage 2, part 4): `viewer/test/checkImportMany.test.js` (fresh
fake-indexeddb, checks the engine makes, Node's `File`) stores each check of a
file exactly as given with its marker and says it is complete; counts a
repeated id without settling it again; finds a check already here from its
stored decision inputs text with no proof call and nothing written; leaves a
conflicting stored check untouched and goes on; makes no request; refuses
before any check line when the served ids were never read, and for a newer
header; for each of 22 refusals (stage 1's damaged, future-time, polar and
served cases, a bad digest, a line that is not a check line and a version-1
document as a line) put on one line between two valid ones, stores exactly
the two valid ones and leaves a pre-existing check byte for byte; stops at a
quota failure on the second of three with the first whole and two lines not
settled, or unknown when the trailer cannot be reached; keeps the checks
before a cut and of a member failing its check, flagged incomplete; flags a
trailer counting three lines of two; counts a line over the line cap as too
large; stops between checks on an abort; hands version-1 files to stage 1
with its own outcomes; calls a non-gzip file over 16 MB not a check file
(stage 1: too large); finds export-all, import-many into a clean store and
export-all again giving the same lines for two saved checks (one with a name
outside Latin-1) and one imported; and removes only checks with an import
marker. Review round (stage 2, part L): `checkImportMany.test.js` proves a valid
copy of an id after a damaged copy and after a line whose prefix names the id
but repeats the key, still counts a copy after an imported one as repeated,
counts one stored check joining a passage that held a check made here (not
one joining a passage that held only an imported check) from one listing,
tells 0 lines not settled from an unknown number with the lines read, runs two
imports of the same file side by side (ids disjoint, their union the store),
and finishes a write an abort lands in (stored exactly the imported ids).
`allChecksFile.test.js` counts a check saved in 2099 as future-dated and the
import refuses it; with a compressor that hands its output over only at the
end, drops the oldest checks so the file fits a cap each check fits alone,
and fails as too large only when not even one fits; and counts a check
deleted during the export as unreadable while leaving out one saved during
it. A test of flat memory retention was not added: garbage collection timing
in the test runner does not make it deterministic; it was measured instead
in Node with forced collection (about one large check's line held while a
check is in hand, 2 MB at the end of eight). The controls (stage 2, 2026-11-16):
`viewer/test/saveAllChecks.test.jsx` (real store, fresh fake-indexeddb; jsdom's
`Blob` is given a `stream()` read from its own `arrayBuffer()` by
`installBlobStream`, test-only) finds the control after the storage line and
the "can delete" note and before the import, the page's live region present
first; none without an exportable check (none at all, only a legacy one) or
without `CompressionStream`, the import still there; a real file made, handed
over only on the second tap, focus kept, read back with two lines, its record
written and the last-file line shown, the object URL kept for another tap and
released on `pagehide`; with a stand-in library, in English and French, the
count and progress while making, a busy button that stays focusable and
starts nothing twice, no announcement per check, Stop keeping nothing and
saying so; one line per reason left out (seven reasons, singular and plural);
the empty and failed alerts; the previous object URL released when a new file
is made and on unmount; the last-file line with how many checks are not in it
(English and French), one line when all are in it, none without a check saved
here or with a broken record, and a save that works when local storage
refuses the record; and French for all 57 templates with their placeholders
and no plain space before `:`, `;` or `?`. `viewer/test/importMany.test.jsx`
imports a file of three lines (one damaged) and finds one summary, the
problem in one alert, the live region, both checks listed as imported, and
an undo through the dialog removing exactly those two (the check made here
byte for byte), in English and French; the already-here and joined lines and
a cancelled undo keeping focus; a version-2 file of one check told exactly as
stage 1 tells it, with "Open the check"; with a stand-in importer, the start
announced once, the running count with an indeterminate bar and Stop, a busy
button that stays focusable, and the stopped line (English and French); the
ends-early, more-than-1,000, storage-full and other-storage lines; and the
refusal for now of a file of many checks. `importCheck.test.jsx` passes
unchanged but for the control's new name and note. `privacyPage.test.jsx`
checks the new first sentence about check files and the date 16 November
2026. `viewer/e2e/check-files-all.spec.js` (desktop and mobile) makes two
Checks in fixture mode, saves all in two taps, reads the download (name,
header, two lines, trailer) and the last-file line, imports it into a fresh
browser and finds both passages labelled as imported and the undo button,
fits 375 px with no horizontal overflow, imports a mixed file (one line with
a changed digest) with its summary and alert, imports offline after the page
loaded, and sends no analytics event for either; `check-import.spec.js` uses
the new name. Review round on the two screens: `saveAllChecks.test.jsx` finds
the object URL revoked 60 seconds after `pagehide` and after unmount (fake
timers) but at once when a new file replaces it, the last-file record's
`made_at` equal to the file header's `exported_at` and the name's minute, the
progress bar named by its text, and focus moved to the stopped line (Stop by
keyboard) and to the ready line (Stop focused when the file is made);
`importMany.test.jsx` finds a check given twice said as read once and not as
damage (English and French), the too-large stop said alone, an inflated-cap
stop still said as ending early, the progress bar named by its count, focus on
the summary's first line after Stop by keyboard and on the removed line after
the undo by keyboard, the undo note and its absence after removal, an undo
through the page's own `deleteSnapshot` that empties a renamed passage and
drops its name, the stations of imported checks named "…, imported from a
file", and no undo after leaving the page and coming back;
`checkImportMany.test.js` counts as removed only what the store no longer
holds when the given delete fails. Passage names (one cleaning rule): `engine/test/passageName.test.ts` finds
`cleanPassageName` removing white space runs, C0 and C1 controls, the Arabic
letter mark, the directional marks, embeddings, overrides and isolates, the
zero width space, the word joiner and lone surrogates; keeping a zero width
joiner in an emoji sequence, a non-joiner, tag-character and regional flags,
accents and decomposed letters as given; cutting at 80 code units without
splitting a pair; giving '' for anything not text; idempotent over 2,000
pseudo-random strings; and every committed route and demo check name
unchanged. `viewer/test/passageLabels.test.js` (regressions first: they failed
before the rule) finds a typed rename without its right-to-left override,
without half an emoji at the cut, a stored name read back cleaned, and a
hostile route name cleaned as the default passage name, the heading and the
title from the legs while the route keeps it; `app.test.jsx` finds the
feedback form's `race_name` cleaned. `importMany.test.jsx` also holds the two
display fixes of 2026-11-16: the progress text never shows a number above the
check lines in the file, and the "0 checks imported" line is left out when
other information lines are shown (kept when only refusals follow), with the
live region and focus following the first line shown (English and French).
`scripts/check-no-polar-data.test.mjs` finds a
`.pol` header after blank lines and 200,000 blank lines read without
rescanning. `viewer/e2e/check-import.spec.js` (desktop and mobile) makes a real
Check in fixture mode, saves a copy, refuses a hostile file in a second, empty
browser context with nothing stored, imports the copy there and opens it with
the label, the same verdict chip and the same departure line. `viewer/test/checkContentHardening.test.jsx` renders the verdict
chip for "toString", "constructor", "__proto__", "hasOwnProperty" and "valueOf"
as the existing insufficient chip, falls back for the same keys in the rule
labels, model styles, section and check wording and the French catalogue,
draws the route map, the synoptic schematic and the scenario plume of a check
with 200,000 points and frames, spans and ranks 200,000 chart points, legs and
hours, accepts every chart path the committed fixtures and prepared runs use
and gives no image for `..` segments, absolute and outside addresses, other
extensions, odd characters, values that are not text and a snapshot-local chart
of an id that is not a check id. `viewer/test/damagedManifest.test.jsx` stores,
in a fresh fake-indexeddb, a good check next to a manifest holding verdict
"toString", wrong types, inherited-property names, no fields, a JSON array or
number, invalid JSON, JSON null, a content that is a number, an object, null or
bytes, and an id the record is not stored under: `list()` keeps the good check
each time, lists the damaged ones it listed before (the last under its record's
id) with every field the type My passages reads or absent, and leaves out the
rest as before; My passages renders all of them at once beside the example,
shows the insufficient chip for "toString", deletes each listed damaged check
from the page and keeps the others, and draws passages whose saved route has a
name that is not text or waypoints that are not a list of points. All of these
except the chart paths the fixtures use, the known translations and the shapes
`list()` already handled failed before the change (TypeError on `split`,
RangeError: Maximum call stack size exceeded, the app unmounted with no header).
`viewer/e2e/render-error.spec.js` copies the demo check into the test's own
IndexedDB under a new id with the same broken hours, opens it from My passages
in real Chromium (desktop and mobile) and finds the fallback with the header and
navigation usable, then reloads to the passage page's empty state and the check
still listed on My passages; it failed before the change (no fallback, the app
blank).

## Fixture policy

- `engine/test/fixtures/` contains deterministic engine inputs and PFT1 golden
  payloads.
- `engine/test/fixtures/routes/routed-current.json` is saved output from the
  TypeScript router with a constant 5 kt polar and 2 kt following current.
  Both TypeScript and Python validate it against the additive route timing
  contract. `routingTiming.test.ts`, the real-engine planner tests and
  `viewer/e2e/routing-timing.spec.js` cover Compute → Check, rerouted departure
  scans, persistence, current hazards and the routing horizon. The browser
  test uses synthetic transport, fresh browser storage and intercepted POSTs;
  it never writes demo artifacts.
- `engine/test/golden/scan-cherbourg-plymouth.json` is the departure-scan golden
  (`scanGolden.test.ts`, scan defined in `engine/test/helpers/scanGolden.ts`). It was
  generated from commit fa31563's engine with
  `git archive fa31563 engine config | tar -x -C <dir>` and
  `npx tsx engine/scripts/make-scan-golden.ts --root <dir>`; after an intentional
  change to a scan's result, regenerate it from the checkout with
  `npx tsx engine/scripts/make-scan-golden.ts` and review the diff. It was
  regenerated so on 2026-11-13, when checks began recording the current grid's
  time step: the only change is `"time_step_h": 6` on its tile currents record.
  Regenerated again on 2026-11-14 for engine semantics `passage-audit-4`: the
  only change is the point count of the four fixture input records (6 legs, 13
  sample points); the candidates are unchanged, because the fixture bundles
  hold one series per leg, which every sample point of that leg reads.
  Regenerated again on 2026-11-14 for the comparison's near-line mark: the only
  change is two added keys on each of its eight candidates (four in the scan,
  four progress candidates), `worst_reading_ratio` and `near_verdict_line`
  (false on all eight, whose verdicts are "insufficient"); with those keys
  removed, the file is identical to the previous one, key order included.
- `engine/test/fixtures/legacy-current-snapshot/` is a complete saved check on an
  hourly prepared current grid written by the engine before checks recorded the
  time step: `git archive f75248e engine config | tar -x -C <dir>` and
  `npx tsx engine/scripts/make-legacy-current-snapshot.ts --root <dir>` (check
  defined in `engine/test/helpers/legacyCurrentSnapshot.ts`, invented values). It
  is legacy evidence for `legacySnapshot.test.ts`, `currentWithAgainst.test.jsx` and
  the Python contract test: never regenerate it from a newer engine.
- `engine/test/fixtures/grib/` contains the golden GRIB2 export files and their
  `*.expected.json`. An engine test requires a byte-identical re-encode, and
  `analysis/tests/test_grib_export_contract.py` decodes every file with ecCodes
  (keys, geometry, values, missing points). After an intentional encoder or
  dataset-registry change, run `npm run make:grib-fixtures -w engine`, review
  the diff, and re-run the contract test. See [grib-export.md](grib-export.md).
- `viewer/test/fixtures/demo/` is the current committed reference demo. Rebuild
  it with `node scripts/build-demo-snapshots.mjs` only for an explicit fixture
  update. The identity-v2 engine produces new IDs; regeneration is never an
  inferred saved-data migration. Regenerated on 2026-11-14 under engine
  semantics `passage-audit-4` (owner-authorized fixture update): the pair is now
  `snapshot_v2_8ca29e5bd5a065f3` (previous) and `snapshot_v2_406ad333228b0a73`
  (latest), written by engine 0.2.0 with identity version 2, replacing the
  schema-version-1 pair (`20260720T060000Z_44d2cd5f_7b2600cd` and
  `..._64ea971e`, engine 0.1.0, one rounded grid point per leg), which is kept
  byte-identical under `viewer/test/fixtures/compatibility/` as legacy
  evidence (checks saved before message IDs and sample points); the Pages build
  copies only `fixtures/demo`, so it does not ship. The verdicts are unchanged (warning active, both
  snapshots); the findings gain `legs[].sample_points`, `hours[].expected` (on
  the three multi-point legs) and `evidence[].sample_point_id`, some event
  windows carry the boat's actual times instead of whole hours, and each
  snapshot gains `decision-inputs.json` (about 0.86 MB each). Two runs of the
  script leave identical bytes.
  Dev fixture mode refuses every non-read `/data/` request with HTTP 403;
  new briefings use the existing browser-local IndexedDB fallback. Warehouse
  mode retains dev persistence and write-once snapshot protection.
  `viewer/test/fixturePersistence.test.js` sends real HTTP mutations to a scratch
  copy and checks every file name and byte. `limitsDrawer.test.jsx` checks the
  inactive night-preference disclosure and preservation of saved `night_ok`.
  `viewer/e2e/fixture-persistence.spec.js` covers English/French desktop/mobile
  limits, Check, local save (in real Chromium, `decision-inputs.json` stored
  with `encoding: 'gzip'` as binary and smaller than its text, the manifest
  plain), reload/reopen and local deletion. It forwards
  mutations to the real dev handler rooted in a scratch copy, blocks external
  transport/telemetry, and checks both scratch and committed fixture digests.
- `viewer/test/fixtures/compatibility/` contains older saved snapshots kept to
  ensure current UI code degrades safely when a browser still holds an earlier
  schema shape. Dates in these fixture paths are identifiers, not expiry dates.
  It also holds the two snapshots of the earlier reference demo, restored
  unchanged on 2026-11-14 (`20260720T060000Z_44d2cd5f_7b2600cd`,
  `20260720T060000Z_44d2cd5f_64ea971e`): the legacy checks read by
  `decisionMessages.test.jsx`, `scenarioSpread.test.jsx`,
  `expectedPositionDisplays.test.jsx` and `e2e/decision-messages.spec.js`
  (no message IDs, no sample points, one point per leg). Never regenerate them.
- `analysis/tests/fixtures/` contains recorded real-source responses. Tests
  mock network calls around these files; do not refresh them merely because
  their dates are old.
- `viewer/e2e/__screenshots__/` contains reviewed Playwright baselines. Update
  them only after inspecting the rendered change at both configured viewports.
  Updated on 2026-11-14 with the regenerated demo (owner-approved): the
  briefing and evidence baselines, desktop and mobile. The only change is the
  ensemble plume block: shading on the audited hours only, the
  expected-position caption and spread sentences, 24 px (desktop) and 56 px
  (mobile) more height.

## Maintenance scripts

| Script | Use |
|---|---|
| `scripts/build-demo-snapshots.mjs` | Regenerate the deterministic viewer demo |
| `scripts/build-pages.mjs` | Package deployment data and Pages-compatible fallback files |
| `server/polars.test.mjs`, `workers/polar-limiter/index.test.mjs` | `/api/polars` read/check/limit and the limiter Worker against invented entries (`npm run test:functions`, in `npm test`) |
| `scripts/check-no-polar-data.mjs` | Fail if polar data is in the repository or, given a directory, a built site (`npm run check:polars`, `build:pages`) |
| `scripts/scenarios.sh` | Generate all synthetic verdict scenarios and run them through the engine |
| `scripts/serve-pages.mjs` | Serve `viewer/dist` with Pages-like routing; use the `static-dist` launch configuration |
| `scripts/upload-prepared-run.py` | Publish a prepared run from CI to R2 |
| `analysis/scripts/build_global_land_mask.py` | Rebuild the packed global land mask when its source/version changes |
| `analysis/scripts/inspect_grib.py` | Print one row per GRIB message (parameter, level, time, grid, range, spot value) with ecCodes |
| `engine/scripts/make-grib-fixtures.ts` | Regenerate the golden GRIB2 export fixtures (`npm run make:grib-fixtures -w engine`) |
| `viewer/scripts/prerender-fr.mjs` | Build-time HTML prerender step (French root, EN/FR GRIB and privacy pages); invoked by the viewer build |

The former infinite local refresh loop is archived under `trashbin/scripts/`.
The scheduled `prepare-synoptic` workflow now owns that job in production.

## Generated and local-only files

Do not commit local caches or generated output: `.venv/`, `node_modules/`,
`dist/`, `output/`, `.playwright-cli/`, `.pytest_cache/`, `.ruff_cache/`,
`__pycache__/`, and `data/` are intentionally ignored. A failing test may leave
artifacts under `output/playwright-results/`; they are diagnostic, not source.

## Route timing compatibility

`Route.timing` declares `through_water`, `speed_over_ground` or `routed`.
Drawn and GPX-imported routes explicitly use through-water scenario speeds;
current is added once by the existing fixed-point ETA calculation. Without
`timing`, fixed/user routes retain that behavior, while legacy computed routes
interpret `speeds_kt` as their stored SOG and receive no second current correction.
Historical snapshots remain readable and are not rewritten.

New computed routes carry exact per-leg scenario durations for their departure,
plus separate through-water and ground speeds. Audit forecast-window selection,
findings and departure scans consume these durations. Current sampling still
produces hazard evidence; preserving routed timing does not disable hazards or
recompute the route against a different current source. Each computed scan
candidate is rerouted for its own departure. Reusing routed timing at a different
departure fails with a request to compute again. Reusing computed geometry in
Draw mode deliberately switches to through-water timing.

The router applies `maxHours` to every evaluated edge, including both endpoint
connections, and checks the final arrival before returning a route. The limit
applies to the nominal routed arrival; the existing slow/fast scenarios remain a
±15% SOG approximation inheriting polar uncertainty. They are not calibrated
confidence intervals. Times and durations displayed by the app retain their
existing rounding.

The finish joins the graph at the node nearest to it (or the nearest node with a
land-free leg to it, within seven rings). Since 2026-11-13, when that node's last leg cannot be sailed at the time the search
reaches it (no-go cone, no wind there, or past `maxHours`), the router no longer
stops with "No route found": every other node within the same seven rings with a
land-free leg to the finish becomes a finish node, joined at its own settle time,
and the route ends through the one arriving first. The search then goes on only
until no unsettled finish node could arrive earlier, or all have been tried, or,
while none has joined, 6 h past the time the nearest node failed
(`ALTERNATIVE_END_WINDOW_MS`): a finish node reachable only dead upwind, or not
at all, no longer holds a failing search to the full horizon. When the search
ends without reaching the nearest node at all (the horizon came first, or it
cannot be reached), the finish nodes it did settle are joined the same way.
A route whose nearest node works is unchanged byte for byte. A finish node
outside `searchBounds` is never joined and counts as the box holding the route
back when it has wind at that time; so a confined search that fails can still be
reported as a box failure (`SearchBoundsError`) when the unconfined request fails
too. Under strict current a missing value anywhere along a finish node's leg is a
gap like anywhere else, and so is any value the search reads during those 6 h: a
search that still finds no route can end as a current gap where it used to end as
"No route found", and a finish node's leg that outlasts the grid's time axis is a
time gap. Such a leg is straight, but integrated in equal steps no
longer than the router's longest edge (√5 graph cells), each reading wind and
current at its own start and time; no waypoint is added, so the route's last leg
carries the summed time and through-water distance. It can still be long: up to
about ten graph cells, which at the default resolution of a long passage is tens
of miles (26 nm was seen at 0.1°). Tests: `engine/test/routingFinish.test.ts`.

## Shared forecast contracts

`npm run check:contracts` verifies the four forecast schemas and producer golden
pins, then exercises isolated positive/drift cases. It runs first in `npm test`
and in a dedicated CI job. See [ownership and refresh rules](shared-contracts.md).

## No polar data

Polar data never goes into this public repository or onto its site. `npm run
check:polars` scans the files Git would commit for polar paths (`data/polars/`,
`config/polars/`, `.pol`, `ALL20xx`, `boats.json.gz`) and polar content (speed
matrices, ORC VPP rows, deep-polars licence records, `.pol` tables, gzip
included), then runs its own planted-sample test. `npm run build:pages` repeats
the scan over `viewer/dist` with no exceptions. Findings name the file and rule,
never the data. Tests use invented tables only; each file holding one is listed
with its reason in `SYNTHETIC_POLAR_FILES`. Check file, version 3 (format): `engine/test/checkFile.test.ts` pins the
exact version-3 header, the names line of one passage with its digest
computed from the definition on BigInt (21f34bf459ab4d61) and the empty
names line (cbf29ce484222325); reads a version-3 header with its version and
calls 4 newer (version 3 is no longer newer); writes names sorted in code-unit
order and reads them back; refuses to write a passage twice, a bad id, an
unclean or empty name or 1,001 names; and refuses 29 names lines (not JSON,
spaces, a carriage return, key order, an extra or missing key, a digest in
capitals or wrong, names not a list, entries of another shape, bad ids of
every kind, empty, unclean, over-long or numeric names, out of order, a
passage twice, 1,001 names, a repeated or forbidden key, a check line, over
512 KiB), never quoting a name or an id. Reader, version 3: `checkFileLines.test.js` yields the header, the names,
each check line and the trailer; no names for an empty names line, and the
same one byte at a time; stops before any check at a names line one byte over
its cap and reads one at it; refuses as truncated a file cut inside its names
line, right after its header or with nothing after it; says the names are
unreadable and still reads the checks for a refused names line and one that
is not UTF-8; says so when the header is followed directly by a check line,
the trailer (with or without its newline) or a short line, reading that line
as what it is; yields a second names line later as a check line; and reads a
version-2 file with no names item. `checkImportMany.test.js` imports a
version-3 file's checks with its names not yet applied; the tests that took
version 3 as newer now take version 4. Tightened name rule (2026-11-16, regressions first):
`engine/test/passageName.test.ts` removes Hangul fillers that render blank,
the halfwidth and choseong/jungseong fillers, a soft hyphen and a grapheme
joiner, Khmer inherent vowels and Mongolian selectors, invisible operators and
deprecated format controls, variation selectors 1 to 14 (keeping 15 and 16),
the specials, the shorthand and musical format controls, tag characters alone
or in a subdivision flag and the variation-selector supplement; empties a
name of nothing but joiners and presentation selectors; keeps Arabic, Hebrew,
CJK and an emoji presentation selector; and is idempotent, pair-safe and never
blank over 22,000 pseudo-random strings with these classes (a run found a
pair formed by a removal; lone surrogates are now removed first).
`viewer/test/shownNames.test.js` falls back to the default name for a
blank-looking route name, drops a bidirectional control from a leg name in
`legPlace`, `legLabel` (bare too) and `routeTitle`, and gives the planner the
cleaned name on "Revise this passage" while the route keeps its own;
`storageFetchGuards.test.jsx` shows a gate name cleaned on the route map.
