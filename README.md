# Passage by DeepRegatta

Explainable passage-weather risk audit for sailors. See the
[current product brief](docs/product-brief.md) for scope and product principles.

The product name is **Passage by DeepRegatta**; `deepweather` was the dev codename and survives in internal identifiers (package names, CLI commands, localStorage keys).

## Architecture (factory / showroom / warehouse — mirrors coachregatta)

| Part | Role | Runtime / deployment |
|---|---|---|
| [forecast-tiles](https://github.com/deepregatta/forecast-tiles) (public repo) | Scheduled ingestion factory: NOAA GFS/GEFS/GFS-Wave, ECMWF open data, Copernicus GLO12 currents → quantized, immutable **PFT1 forecast tiles** on Cloudflare R2 ([format specification](docs/forecast-tile-format.md)). | GitHub Actions cron per layer |
| `analysis/` | Python factory: the remaining **route-independent** prep — synoptic feature detection, warnings, tides, verification, scenario bundles. Publishes compact JSON artifacts per model run. | Scheduled shared-prep job publishing to R2 |
| `engine/` | TypeScript pure library: everything **per-user** — route geometry, ForecastStore tile reads, ETA ranges, limits, ensemble exceedance, verdicts, briefing text, isochrone routing. Zero DOM deps, no weather APIs. | Runs unchanged **in the user's browser** (no per-user server compute, no runtime API quotas) |
| `viewer/` | React + Vite showroom. Dev middleware serves `/data/*` from `../data/processed`, including a local fixture tile run at `/data/forecast/`. Forecast tiles cache in IndexedDB per immutable run id. | Cloudflare Pages + R2 (`https://forecast.deepregatta.com`) |
| `data/` | Git-ignored warehouse: caches, prepared runs, and immutable local snapshots. | Local working data; published artifacts use R2 |
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
```

Use the `viewer-demo` launch configuration in `.claude/launch.json` for the
fixture-backed viewer. The complete command and test catalog lives in
[docs/testing.md](docs/testing.md).

## Product flow

The viewer is organised around the passage, not the processing pipeline. The
header has two places, **Plan** and **My passages**, plus a **Limits** chip:

- **Plan** — compute a weather route from the forecast and your boat polar (the default), or draw one; pick a departure or compare departure windows, then check the passage. **Export GRIB for this area** on the chart opens the GRIB2 page (wind, currents, waves) for a box ([grib-export.md](docs/grib-export.md)).
- **My passages** — each passage (route + departure) keeps its checks together, with its latest verdict, whether it changed since the previous check, and a progress track from checks through departure to verification.
- **A passage page** — one decision band (route, verdict against your limits, any official warning, next forecast update, share), then sections on one scrolling page: the weather **Story** with a single pressure-chart / route-map view, **Along the route** (the condition strip is also the time scrubber), claim-level **Evidence** with models and coverage, **What changed** since the previous check, and **How it turned out** once the frozen forecast is verified.
- **Limits** — a drawer, reachable from every page, edits the limits the next check uses; frozen briefings keep their own.
- **About the data** (footer) — the fleet-wide track record, provider modes and glossary.

URL hashes deep-link places and passage sections, for example `#plan`, `#passages`, `#passage?snapshot=<id>` and `#passage/evidence?snapshot=<id>`. The retired stage links (`#brief/story`, `#brief/evidence`, `#watch/changes`, `#verify/record`, `#plan/limits`, …) still open the same content. Below 768 px the header navigation becomes a single three-item bottom bar (Plan · My passages · Limits).

## Deterministic reference demo

```bash
node scripts/build-demo-snapshots.mjs
VITE_DW_FIXTURE=demo npm run dev -w viewer
```

The builder runs the engine CLI twice with a fixed clock and rebuilds the committed previous/latest snapshot pair in `viewer/test/fixtures/demo/`. It includes archived synthetic bulletin text, synoptic tracks/charts, an ensemble gust-scenario claim, a six-hour/four-hPa before/after low, a changes artifact, and an explicitly emulated verification case. Re-running it must leave the fixture byte-identical.

## Verification commands

```bash
npm run lint                                 # JS/TS + React Hook order/dependencies (zero warnings)
npm test                                      # engine + viewer unit/contract suites
npm run build                                 # TypeScript + production Vite chunks
npm run test:e2e                              # 1568×1003 + 390×844 visual/core-flow suite
cd analysis && uv run pytest                  # factory + verification tests
cd analysis && uv run deepweather-analysis corpus --no-fetch
```

See [Testing and maintenance](docs/testing.md) for suite ownership, fixture
policy, generated outputs, and maintenance scripts.

The full corpus command without `--no-fetch` uses CDS credentials and may be slow. Calibration excludes every record whose `observation_source` or coverage class is `emulated`; demo cases are displayed but never contribute to skill claims.

After regenerating the ORC database with `build-polar-db`, publish it into the
static viewer with `npm run publish:polars`. Cloudflare Pages uses
`npm run build:pages`, which merges deployment data into Vite's output and
keeps a real `404.html` for missing data artifacts.

Production builds default to `https://forecast.deepregatta.com` for forecast
tiles and its `prepared/` prefix for prepared runs. `VITE_FORECAST_BASE_URL`
can override that public host; another origin also requires updating the
`connect-src` and `img-src` allowlists in `viewer/public/_headers`.
Regional wind exports must fit the selected model's complete forecast horizon.
The GRIB page offers an explicit **Next 1 day** period for these shorter runs.

Development defaults to `/data/forecast` for tiles and always reads prepared
runs from the local `/data/runs/` warehouse. A failed latest-pointer request
does not switch hosts or change saved chart URLs. Use the `static-dist` launch
configuration to test production source resolution locally.

## Safety framing

This is a decision *aid*: it never says "GO", official warnings override the personal-limit summary,
unsupported hazards are disclosed in every report. Skippers remain solely responsible; official
marine forecasts remain the authority of record.

## Documentation

The maintained documentation index is [docs/README.md](docs/README.md).
Superseded reports and one-off design material are retained under
[`trashbin/`](trashbin/README.md) for history and are not authoritative.

## Public example entry

`/#example` and `/fr/#example` resolve the served synthetic/emulated example on a
fresh visit and reload, independently of a saved planner route or hidden local
briefing. The planner keeps a visible example link. Inspecting it reads static
snapshot artifacts and emits `passage_example_view`; it does not run a forecast,
trigger a departure scan, or count as a completed planner activation. The bulletin
and departure comparison retain their emulated labels. URL queries survive
navigation.

Optional regional forecast support and its release gates are described in [regional forecast tiles](docs/regional-forecast-tiles.md).
