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
snapshot ID `20260720T060000Z_44d2cd5f_64ea971e` and fixing `generated_at` to
`2026-07-13T00:00:00Z`; demo fixtures stay unchanged. Bilingual outcome smoke
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
its saved decision inputs hash to its `decision_hash`, the same inputs checked
now give the same `decision_hash`, `snapshot_id` and `route_revision` and findings
that differ only by the step, an exact retry reopens it with every file
byte-identical, and its block has every figure and no hours with and against.
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
  own day and the French tooltip. `downloadQuote.test.js` and
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
whole action. Partial tile availability stays partial; zero actual samples stays
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
the axis is a gap, never calm water. Comparisons keep the same rule and usually
stay on tiles (the 120 h axis); a refinement of a confined comparison is
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
departure's failure and does not move the action to tiles. A computed scan whose last departure lies beyond the prepared grid's time
axis routes every candidate on tiles, while a single Compute at the anchor may
still use the prepared grid. Compute now also downloads `latest.json` and the
prepared current grid; neither is in the planner's tile download figure, which
still counts current tiles for Compute because they are read before the choice
and serve as its fallback. The route result names the current model it used by its family
("Currents · Copernicus IBI ocean currents"; "Model not recorded" when the grid
records no model, never a guessed one), an emulated badge for synthetic
data, and a fixed sentence when a prepared grid carries a resolution note. The
coverage selector also downgrades older presence-based claims using saved
samples alone, without changing snapshot bytes or substituting latest data.

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
  update. The identity-v2 engine produces new IDs; the current schema-version-1
  pair remains compatibility evidence, never an inferred saved-data migration.
  Dev fixture mode refuses every non-read `/data/` request with HTTP 403;
  new briefings use the existing browser-local IndexedDB fallback. Warehouse
  mode retains dev persistence and write-once snapshot protection.
  `viewer/test/fixturePersistence.test.js` sends real HTTP mutations to a scratch
  copy and checks every file name and byte. `limitsDrawer.test.jsx` checks the
  inactive night-preference disclosure and preservation of saved `night_ok`.
  `viewer/e2e/fixture-persistence.spec.js` covers English/French desktop/mobile
  limits, Check, local save, reload/reopen and local deletion. It forwards
  mutations to the real dev handler rooted in a scratch copy, blocks external
  transport/telemetry, and checks both scratch and committed fixture digests.
- `viewer/test/fixtures/compatibility/` contains older saved snapshots kept to
  ensure current UI code degrades safely when a browser still holds an earlier
  schema shape. Dates in these fixture paths are identifiers, not expiry dates.
- `analysis/tests/fixtures/` contains recorded real-source responses. Tests
  mock network calls around these files; do not refresh them merely because
  their dates are old.
- `viewer/e2e/__screenshots__/` contains reviewed Playwright baselines. Update
  them only after inspecting the rendered change at both configured viewports.

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
with its reason in `SYNTHETIC_POLAR_FILES`.
