# deepweather

Explainable passage-weather risk audit for sailors. Local prototype — see [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the product spec.

`deepweather` is both the project and product name for now (a real name comes later).

## Architecture (factory / showroom / warehouse — mirrors coachregatta)

| Part | Role | Future deployment |
|---|---|---|
| [forecast-tiles](https://github.com/deepregatta/forecast-tiles) (public repo) | Scheduled ingestion factory: NOAA GFS/GEFS/GFS-Wave, ECMWF open data, Copernicus GLO12 currents → quantized, immutable **PFT1 forecast tiles** on Cloudflare R2 (`docs/forecast-tiles-spec.md`). | Already its production shape: GitHub Actions cron per layer |
| `analysis/` | Python factory: the remaining **route-independent** prep — synoptic feature detection, warnings, tides, verification, scenario bundles. Publishes compact JSON artifacts per model run. | Scheduled shared-prep job, publishing to R2 |
| `engine/` | TypeScript pure library: everything **per-user** — route geometry, ForecastStore tile reads, ETA ranges, limits, ensemble exceedance, verdicts, briefing text, isochrone routing. Zero DOM deps, no weather APIs. | Runs unchanged **in the user's browser** (no per-user server compute, no runtime API quotas) |
| `viewer/` | React + Vite showroom. Dev middleware serves `/data/*` from `../data/processed`, including a local fixture tile run at `/data/forecast/`. Forecast tiles cache in IndexedDB per immutable run id. | Cloudflare Pages + R2 (`VITE_FORECAST_BASE_URL`) |
| `data/` | Git-ignored warehouse: caches, prepared runs, immutable snapshots. | Local today; planned R2 bucket with the same layout |
| `contracts/` | JSON Schemas — the treaty between Python and TypeScript, including the forecast tile/manifest/latest schemas vendored into the pipeline repo. | The API between the shared jobs and every browser |

## Data providers

Every external feed runs in one of three modes (see `config/providers.json`):
`live` (real API), `fixture` (recorded responses), `synthetic` (generated, scenario-controlled).
**Every emulated value carries `source_kind: "emulated"` in its evidence and a visible badge in the UI.**

## Vendoring policy

Code and data reused from the author's `coachregatta` project are **copied into this repo** with a
provenance header comment (`Vendored from coachregatta <path>, <date>`), never imported across repos.

## Quick start

```bash
# Python factory (uv-managed, Python 3.12 — 3.14 is too new for the geo stack)
cd analysis && uv sync --all-extras && uv run pytest

# Engine + viewer
npm install
npm test
npm run dev            # viewer at http://localhost:5174, /data/* served from data/processed
```

## Product flow

The viewer follows the passage cycle rather than the implementation layers:

- **Plan** — draw or compute a route, compare departure windows, manage saved briefings and declared limits.
- **Brief** — read the causal system → route intersection → consequence story, scrub the shared time cursor, then inspect the exact ensemble claim.
- **Watch** — compare frozen runs through an edited three-item change story; the complete ledger remains available underneath.
- **Verify** — see real-case corpus counts, calibration sample sizes, and printable frozen-forecast case studies.

URL hashes preserve stage/subview deep links, for example `#brief/story`, `#brief/evidence`, and `#watch/changes`. On screens below 768 px the permanent rail is replaced by a four-tab bottom bar.

## Deterministic reference demo

```bash
node scripts/build-demo-snapshots.mjs
VITE_DW_FIXTURE=demo npm run dev -w viewer
```

The builder runs the engine CLI twice with a fixed clock and rebuilds the committed previous/latest snapshot pair in `viewer/test/fixtures/demo/`. It includes archived synthetic bulletin text, synoptic tracks/charts, an ensemble gust-scenario claim, a six-hour/four-hPa before/after low, a changes artifact, and an explicitly emulated verification case. Re-running it must leave the fixture byte-identical.

## Verification commands

```bash
npm test                                      # engine + viewer unit/contract suites
npm run build                                 # TypeScript + production Vite chunks
cd viewer && npx playwright test              # 1568×1003 + 390×844 visual/core-flow suite
cd analysis && uv run pytest                  # factory + verification tests
cd analysis && uv run deepweather-analysis corpus --no-fetch
```

The full corpus command without `--no-fetch` uses CDS credentials and may be slow. Calibration excludes every record whose `observation_source` or coverage class is `emulated`; demo cases are displayed but never contribute to skill claims.

After regenerating the ORC database with `build-polar-db`, publish it into the
static viewer with `npm run publish:polars`. Cloudflare Pages uses
`npm run build:pages`, which merges deployment data into Vite's output and
keeps a real `404.html` for missing data artifacts.

## Safety framing

This is a decision *aid*: it never says "GO", official warnings override the personal-limit summary,
unsupported hazards are disclosed in every report. Skippers remain solely responsible; official
marine forecasts remain the authority of record.
