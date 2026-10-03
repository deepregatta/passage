# Testing and maintenance

## Test suites

Run the same core checks used by CI from the repository root:

```bash
npm run lint
npm audit
npm test
npm run build:pages
(cd analysis && uv run pytest -q)
(cd analysis && uv run ruff check . ../scripts/upload-prepared-run.py)
(cd analysis && uv run ruff format --check . ../scripts/upload-prepared-run.py)
```

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

## Frozen Check and Scan inputs

`viewer/src/lib/actionInputs.js` and `browserAnalysis.js` are checked with
`npm run typecheck -w viewer`, also part of root `npm test`. One immutable action
bundle holds the cloned route/timing and profile revisions, departure, pinned
tile-layer identities and optional context. Check and Scan consume this bundle;
they never reread the profile storage adapter. A deleted/changed tile run aborts
the whole attempt; the existing freshness wrapper may retry with a new bundle,
retaining the user inputs captured at the click.

Prepared discovery bypasses a stale HTTP pointer at each action and does not
memoize failures. Artifact paths are resolved from one selected pointer; saved
chart references remain verbatim. Input provenance includes canonical FNV-1a64
content digests (not cryptographic checksums) and the exact prepared artifact
paths, including their producer revision suffixes when present. These additional
records use the existing extensible `findings.inputs.forecast_tiles` array;
shared JSON schemas and historical saved files are unchanged. This does not
extend snapshot identity semantics; that remains the separate PASSAGE-03 task.

Prepared current admission checks every leg midpoint at its current-adjusted
entry/exit envelope and occupancy hours, including all successful drawn-scan
candidates. Any spatial, time or finite-sample gap selects tile currents for the
whole action. Partial tile availability stays partial; zero actual samples stays
unavailable. Computed scans use their routing tile-current grid for every audit,
with declared source provenance; there is no pointwise source blending. The
coverage selector also downgrades older presence-based claims using saved
samples alone, without changing snapshot bytes or substituting latest data.

Regression ownership: `engine/test/currentAdmission.test.ts` covers admission,
fallback, finite samples, partial coverage and single-source scans;
`viewer/test/actionInputs.test.jsx` crosses the real loader, action bundle,
engine and ModelsUsed UI; `plannerComputed.test.jsx` crosses visible limits,
failed persistence and in-flight edits. `viewer/e2e/action-inputs.spec.js` and
`routing-timing.spec.js` exercise Check/Scan and saved reopening on desktop and
mobile, using synthetic transport, fresh storage, blocked telemetry and
intercepted POSTs. Demo fixture files must stay untouched.

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
- `engine/test/fixtures/grib/` contains the golden GRIB2 export files and their
  `*.expected.json`. An engine test requires a byte-identical re-encode, and
  `analysis/tests/test_grib_export_contract.py` decodes every file with ecCodes
  (keys, geometry, values, missing points). After an intentional encoder or
  dataset-registry change, run `npm run make:grib-fixtures -w engine`, review
  the diff, and re-run the contract test. See [grib-export.md](grib-export.md).
- `viewer/test/fixtures/demo/` is the current committed reference demo. Rebuild
  it with `node scripts/build-demo-snapshots.mjs`; a clean regeneration must be
  byte-identical unless an intentional product or contract change is under
  review.
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
| `scripts/publish-polars.mjs` | Copy a generated polar database into viewer public assets |
| `scripts/scenarios.sh` | Generate all synthetic verdict scenarios and run them through the engine |
| `scripts/serve-pages.mjs` | Serve `viewer/dist` with Pages-like routing; use the `static-dist` launch configuration |
| `scripts/upload-prepared-run.py` | Publish a prepared run from CI to R2 |
| `analysis/scripts/build_global_land_mask.py` | Rebuild the packed global land mask when its source/version changes |
| `analysis/scripts/inspect_grib.py` | Print one row per GRIB message (parameter, level, time, grid, range, spot value) with ecCodes |
| `engine/scripts/make-grib-fixtures.ts` | Regenerate the golden GRIB2 export fixtures (`npm run make:grib-fixtures -w engine`) |
| `viewer/scripts/prerender-fr.mjs` | Build-time French HTML prerender step; invoked by the viewer build |

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
