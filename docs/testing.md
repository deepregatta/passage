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
| `viewer/test/` | Vitest + Testing Library | UI behavior, localization, persistence, prerendering, saved-snapshot compatibility, and the planner GRIB export (`gribExport.test.jsx`, a real `TileForecastStore` over in-memory fixture tiles) |
| `viewer/e2e/` | Playwright | Desktop/mobile core flows and reviewed screenshot baselines |
| `analysis/tests/` | pytest | Provider adapters, route-independent preparation, warnings, tides, observations, verification, and the ecCodes GRIB export contract |

## Fixture policy

- `engine/test/fixtures/` contains deterministic engine inputs and PFT1 golden
  payloads.
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
