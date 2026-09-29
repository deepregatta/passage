# GRIB export from the planner — implementation plan

Status: direction approved 2026-09-23. **Phase 1 landed 2026-09-24** (engine,
CLI, golden fixtures, ecCodes contract; CI green). **Phase 2 landed
2026-09-24** (planner **Download GRIBs…** live in production for everyone, EN
and FR). **Adrena sign-off 2026-09-27** (wind and currents, Channel box across
0°). **Phase 3 landed 2026-09-28**: the GRIB files page replaces the planner
section; see [Phase 3](#phase-3--adrena-feedback-and-refinements) for what
stays open. **IBI horizon 2026-09-29**: `currents-ibi` serves 0–120 h and
is ingested in hourly slots from 07:50 UTC, after measuring when Copernicus
publishes; Phase 5A task 1 (the "already published" exit) landed with it (see
[Phase 5](#phase-5--fresher-forecast-runs-independent-track-forecast-tiles--passage)).
First run `currents-ibi-20260929T00Z`, published 11 h 12 min after its cycle
(D+17–21 h before). A production Channel IBI file for "next 3 days" then held
all 73 hourly steps, EN and FR, where the day before it stopped 28 h ahead.
**Phase 5 mechanism chosen 2026-09-29**: a Cloudflare Worker dispatches each
layer at its provider's known publication time and the ingest job waits for
its cycle (replaces the 10-minute polling Worker first planned).
Phase 4 (measure) and the rest of Phase 5 (fresher forecast runs, an
independent track added 2026-09-23) are next. Update the status line and tick
the exit criteria as phases land.

## How to use this plan

Implement **one phase per session**. Phases 1–4 run in order. Phase 5 can
run at any time. Recommended: run 5A alongside or after Phase 1, and 5B soon
after Phase 2 ships, so GRIB downloads are fresh.

### Launch prompts

Open a new Claude session in the directory shown and paste the prompt.

| Phase | Start in | Prompt |
|---|---|---|
| 1 | `deepregatta/passage` | `Implement Phase 1 of docs/grib-export-plan.md. Read its "How to use this plan" section first.` |
| 2 | `deepregatta/passage` | `Implement Phase 2 of docs/grib-export-plan.md. Read its "How to use this plan" section first.` |
| 3 | `deepregatta/passage` | `Implement Phase 3 of docs/grib-export-plan.md. Adrena test results: <paste the checklist answers and screenshots>.` |
| 4 | `deepregatta/passage` | `Run Phase 4 of docs/grib-export-plan.md: measure and recommend. Don't build a Cloudflare Worker without asking me.` |
| 5A | `deepregatta` (the container directory) | `Implement Phase 5A of passage/docs/grib-export-plan.md (fresher forecast runs). It spans forecast-tiles and passage: commit and push each repo. Stop after printing my manual dispatcher setup steps.` |
| 5B | `deepregatta` (the container directory) | `Implement Phase 5B of passage/docs/grib-export-plan.md. I've deployed the dispatcher Worker and set its GITHUB_TOKEN secret. Dry-run log lines: <paste>.` |

Before starting, read:

1. `CLAUDE.md` (repo conventions: commit and push to main, launch configs, provider modes).
2. `docs/forecast-tile-format.md` (PFT1 tiles, manifests, `latest.json`).
3. This whole file, including [Verified facts](#verified-facts). Don't
   re-derive them. If one turns out to be wrong, fix it here in the same commit.

Stop at each phase's exit criteria, commit, push, and report. Phase 3 needs
the Adrena test results first.

## Goal

From **Plan a passage**, a sailor draws, imports or computes a route and clicks
**Download GRIBs**. Passage shows the route's rectangle plus a margin, lists the
forecast datasets available for that area, and the sailor ticks the ones they
want. The browser then produces standard GRIB2 files for that area and period,
built from the same `forecast-tiles` runs Passage uses for its briefings. The
first target application is **Adrena**, which reads GRIB and GRIB2 including
waves and currents, per its FAQ. OpenCPN, qtVlm and XyGrib should also read
the files.

## Locked decisions

| Decision | Choice |
|---|---|
| Where files are generated | **In the browser**, from the PFT1 tiles already on R2. No server and no `forecast-tiles` change in v1. |
| Format | **GRIB2**, template 3.0 (regular lat/lon), 4.0, 5.0 (simple packing) with a section-6 bitmap for missing values. One file per dataset. |
| Datasets in v1 | GFS wind + gust, ECMWF wind, GFS-Wave, Copernicus global currents (GLO12), Copernicus IBI currents (regional). |
| Pressure (MSLP) | **Not in v1.** Tiles have no MSLP; adding it is a separate `forecast-tiles` change. |
| Release | Phase 2 ships the feature to production **for everyone, with no hidden flag** (decided 2026-09-24). The current users are Davi and Jacques, so there's no risk in shipping before Adrena sign-off: they test the real production version, and Phase 3 applies the fixes. |

Rejected alternatives (don't reopen without new evidence):

- **Keep the original provider GRIBs during ingestion and crop them with a
  `wgrib2` service.** The originals cover the whole globe and are thrown away
  after decoding: GFS messages are held in memory, ECMWF goes to an
  auto-deleted temp file, and currents arrive as xarray/NetCDF, not GRIB.
  Keeping GFS wind and waves adds about 1 GB per run against the 8 GB R2
  guard. `wgrib2` is a native binary, so it would need new container hosting.
  The originals are also *not* more precise than the tiles (see the facts
  below), and their wave messages use JPEG2000 packing, which is a
  compatibility risk.
- **Pre-built GRIB per 10° tile.** A route needs several tiles, so the result
  is a patchwork of grids that apps handle badly. It also doubles storage.
- **Cloudflare Worker that reads tiles from R2.** A valid fallback: the same
  engine code, and only the final file is downloaded. Deferred to Phase 4,
  and only if the measurements call for it. It needs the paid Workers plan
  (the free 10 ms CPU limit is too low to gunzip an IBI tile).

## Verified facts

Checked 2026-09-23 against the code and the live data.

**Live layers** (`https://forecast.deepregatta.com/latest.json` and each run's `manifest.json`):

| Layer | Model | Resolution | Tile variables | Time axis |
|---|---|---|---|---|
| `weather` | GFS | 0.25° | `wind_u_kt`, `wind_v_kt`, `gust_kt` (axis `hourly`); `visibility_m`, `cape_jkg`, `temp_c`, `dew_point_c`, `precip_mm` (axis `h3`) | hourly: 1 h → 120 h, then 3 h → 240 h (161 steps) |
| `weather-ecmwf` | ECMWF open IFS | 0.25° | `wind_u_kt`, `wind_v_kt` (gust was absent until 2026-09-28: the ingest asked for one gust name, and ECMWF names it by its window, `10fg` / `10fg3`; fixed that day, so runs from the next scheduled ingest on carry `gust_kt` with a `statistic` window per step, see `docs/grib-export.md`) | `steps`: 3 h → 144 h, 6 h → 240 h (65) |
| `waves` | GFS-Wave | 0.25° | `hs_m`, `period_s`, `dir_deg`, `wind_wave_h_m`, `wind_wave_period_s`, `wind_wave_dir_deg`, `swell_h_m`, `swell_period_s`, `swell_dir_deg` | `steps`: 3 h → 384 h (129) |
| `currents` | CMEMS GLO12 | 1/12° (runs before 2026-09-24: header dlat 0.08333588) | `cur_u_kt`, `cur_v_kt` | `steps`: 6 h → 240 h (41) |
| `currents-ibi` | CMEMS IBI | ≈1/36° (0.02777863) | `cur_u_kt`, `cur_v_kt` | hourly → 120 h (121) from the runs published 2026-09-29, → 72 h (73) before; IBI domain only (11 tiles) |
| `ensemble` | GEFS | 0.5° | wind *speed* mean + member anomalies only | not exportable as vectors, out of scope |

- Compressed tile sizes for N40W010: weather 1.39 MB, waves 0.93 MB, GLO12
  0.55 MB, ECMWF 0.31 MB, **IBI 9.8 MB** (IBI run total 64 MB). IBI at 0–120 h
  (from 2026-09-29): about 18 MB for N40W010, 36.6 MB for the four Channel
  tiles and 114 MB a run, scaled from the 72 h runs of 2026-09-28 (10.6 MB,
  21.6 MB, 67.5 MB) by forecast-tiles' measured axis sizes.
- **CMEMS tile grids are not anchored on the 10° lines** (corrected
  2026-09-24; the original spec assumed they were). N40W010 headers: GLO12
  lat0 40.00366, lon0 −9.92705, dlon 0.0833282 (a float32-derived step, so the
  true −10.0 column is the last column of N40W020); IBI lat0 40.02689, lon0
  −9.99923 (lattice 40.0° is the last row of N30W010). The GRIB export samples
  through each tile's header instead; see `docs/grib-export.md` → *Sampling
  tiles onto the lattice*. The 0.25° layers are exactly aligned, and so is
  GLO12 from the runs published on 2026-09-24 (forecast-tiles now snaps its
  float32 coordinates to the exact 1/12° lattice: N40W010 lat0 40, lon0 −10).
- Tiles store knots. Ingestion converts with `MS_TO_KT = 1.943844`
  (`forecast-tiles/src/ingest/sources/base.py`). Divide by the same constant
  to get back to m/s.
- Wave variables map 1:1 to NCEP messages (`forecast-tiles/src/ingest/sources/gfswave.py`):
  HTSGW, PERPW, DIRPW, WVHGT, WVPER, WVDIR, SWELL/SWPER/SWDIR "1 in sequence".
  Directions pass through unchanged (degrees true, NCEP convention).
- **Tiles are no less precise than the originals.** Measured on NOAA's
  2026-09-23 00Z messages with ecCodes:

  | Field | NOAA packing | NOAA precision | Tile precision |
  |---|---|---|---|
  | UGRD/VGRD 10 m | complex + spatial differencing, 10 bits, D=1 | 0.1 m/s | 0.01 kt ≈ 0.005 m/s |
  | GUST | same | 0.1 m/s | 0.1 kt ≈ 0.05 m/s |
  | HTSGW | JPEG2000, 11 bits, D=2 | 0.01 m | 0.01 m |
  | DIRPW | JPEG2000, 16 bits, D=2 | 0.01° | 0.1° |

- **NCEP GRIB2 identification keys** (read from the same messages; mirror them):
  centre 7, subCentre 0, tablesVersion 2, productionStatus 0,
  typeOfGeneratingProcess 2, backgroundProcess 0, generatingProcessIdentifier
  96 (GFS) / 11 (GFS-Wave), shapeOfTheEarth 6, resolutionAndComponentFlags 48,
  scanningMode 0 (north→south, first point at the NW corner), longitudes 0–360,
  indicatorOfUnitOfTimeRange 1 (hours). Levels: 10 m wind = type 103, value
  10; GUST = type 1, value 0; wave fields = type 1, value 1; swell partition 1
  = type 241 ("ordered sequence"), value 1. Wave messages have a bitmap
  (land); wind messages don't.
- **ecCodes 2.47** (and NCEP g2clib) return R unscaled for `bitsPerValue = 0`
  and ignore D, so constant fields are written with D = 0 and R = the value
  (found by the contract test). ecCodes has no name for an instantaneous
  10/1/2 current (its only GRIB2 surface-current concepts, `ocu`/`ocv`, are
  template-4.8 averages at level 160), so it shows the currents as
  `unknown` at every level and centre tried. That is a naming gap, not a
  decode error.
- **Engine store** (`engine/src/forecast/tileStore.ts`):
  - `init()` loads a manifest for *every* layer in `latest.json`, including
    `currents-ibi`. `describe()` returns run ids. The viewer singleton
    (`viewer/src/lib/forecastStore.js`) initialises once per page session, so
    its runs are already pinned for the session.
  - `loadTile()` (private) does checksum validation, the IndexedDB cache and
    the transport fetch. **Reuse it; don't duplicate it.**
  - `mosaicGrid()` / `getWindGrid()` / `getCurrentGrid()` **coarsen** the grid
    once an area goes over about 4,000 points (routing budget) and only read
    u/v. **Don't use them for export.**
  - Decoded-array retention is capped at 64 MiB (LRU). A decoded IBI tile is
    about 125 MB of Float32 (360×360×121×2; 76 MB at 73 steps before
    2026-09-29), so it is never retained and must be released before the next
    tile loads.
  - `decodeTile` decodes every variable of a tile into Float32 (NaN =
    missing). Tiles are south→north: point (i=0, j=0) is the SW corner.
- Engine: `lib: ["ES2022"]`, no DOM. It has no `Blob`, so it returns
  `Uint8Array` parts. `fnv1a64Hex` is in `engine/src/hash.ts`. The CLI
  (`engine/src/cli.ts`) has `run` and, since Phase 1, `grib`. `FsTileTransport` in
  `engine/src/io/node.ts` reads a local tile directory.
- Engine test helpers: `engine/test/helpers/fixtureRun.ts` provides
  `buildFixtureRun(specs)` and `MemoryTileTransport`. `pointsPerSide` builds
  small partial tiles. The golden weather tile
  `engine/test/fixtures/tiles/golden-N40W010-weather.bin.gz` is 8×8 at 0.25°
  from 40N/10W, with 4 hourly steps.
- Viewer:
  - Hash routes: the planner is `#plan/planner`. `parseRoute()`
    (`viewer/src/lib/routes.js`) splits `?query` off the hash.
  - No Web Worker exists. The GRIB files page (`viewer/src/pages/Grib.jsx`,
    Phase 3) is the viewer's only file download: Blob URLs on `<a download>`
    links.
  - The CSP (`viewer/public/_headers`) already allows
    `connect-src https://forecast.deepregatta.com` and `worker-src 'self' blob:`.
  - The planner state lives in `viewer/src/pages/planner/usePlannerController.jsx`
    (`route`, `waypoints`, `endpoints`, `computed`, `speeds`, `distance`,
    `departureUtc`).
  - The map is react-leaflet (`PlannerMap.jsx`), so `Rectangle` is available.
  - `DepartureComparison` shows the pattern for a section rendered below the
    planner grid.
- Analytics: `track(event, props)` from `viewer/src/lib/analytics.js`. The
  collector accepts any name matching `/^[a-z0-9_.]{1,48}$/`, with no
  allowlist.
- **French:** `/fr/` is a DOM translator keyed on the exact English strings in
  `viewer/src/i18n.js`. Every new or changed English string must be added
  there and to `viewer/test/i18n.test.js` in the same commit, or English leaks
  into `/fr/`. `window.confirm` text needs `translateText`.
- CI (`.github/workflows/ci.yml`) has three jobs:
  - `javascript`: lint, `npm test`, `build:pages`.
  - `browser`: Playwright.
  - `python`: pytest + ruff in `analysis/`, which has `eccodes` and `cfgrib`.
- **On 2026-09-23 the `passage` repo's GitHub Actions jobs didn't start.**
  They ran again from 22:53 UTC the same day (CI run 35930782176 passed); the
  cause below is kept for when the allowance runs out again.
  The annotation reads "recent account payments have failed or your spending
  limit needs to be increased". This blocks both CI and `prepare-synoptic`
  (last success 2026-09-22 20:14 UTC). Don't debug it as a code failure.
  - **Cause:** the `deepregatta` org is on GitHub Free. Its private repos
    share **2,000 Actions minutes a month**; the allowance resets monthly,
    not weekly.
  - **Billable minutes, Sept 1–23** (summed from job timings):
    - `passage` 1,160: `prepare-synoptic` 569, CI `javascript` 340, `python`
      232, `browser` 19;
    - `oscar` 713;
    - `tactician` 92;
    - `landing` 5;
    - total ≈ 1,970.
  - Public repos (`forecast-tiles`) use standard runners for free with no
    minute limit.
  - "CI green" exit criteria need the allowance to reset, a spending limit,
    or `passage` to become public. Davi is considering the last option after
    a security review.
- Corrected 2026-09-29: all three Passage `contracts/forecast-*.schema.json`
  list `currents-ibi` since `01e0360` (2026-09-28) and match forecast-tiles'
  vendored copies (only the tile schema's title differs). Phase 5A's contract
  task only adds `cadence_hours`.
- Pages auto-deploys from main. Test Pages-like static hosting locally with
  `npm run build:pages` and then the `static-dist` launch config. That build
  reads the **production** tiles from `localhost:8788` (R2 allows the
  cross-origin reads), so it can run real exports.
- Playwright reuses a running `viewer-demo` server. After `Planner.jsx` has
  been edited under that server, Vite serves it with an HMR `?t=` query, the
  `sharing.spec.js` route glob `**/src/pages/Planner.jsx` no longer matches,
  and that test times out. Stop the preview server before the e2e run (CI
  always starts its own).
- Product scope (`docs/product-brief.md`): coastal passages of 6–36 h in
  Atlantic Europe and the western Mediterranean. Size limits should suit that
  scope, not ocean crossings.

## Architecture

```
Planner (route, departure)                        viewer
  └─ GribExport section: bbox + margin, datasets, window, step
        │ request
        ▼
engine/src/export/  (pure TS, no DOM; same code runs in Node CLI, browser, later a Worker)
  gribDatasets.ts   dataset registry → GRIB keys, units, precision
  exportPlan.ts     request + manifests → lattice, times, tiles, size estimate (sync, no I/O)
  exportGrib.ts     runs a plan: one tile at a time → cropped cubes → messages
  grib2.ts          encodeGrib2Message(): the byte-level encoder
        │ reads tiles through
        ▼
TileForecastStore.readTile(layer, tileId)  (new public method; checksum + IndexedDB cache reused)
        │
        ▼
https://forecast.deepregatta.com/forecast-runs/{run_id}/…  (unchanged)
```

- Engine public API, exported from `engine/src/index.ts`:
  - `GRIB_DATASETS`
  - `planGribExport(manifests, request)`
  - `runGribExport(source, plan, { signal, onProgress })`
  - `encodeGrib2Message(field)`
  - `gribExportSourceFromStore(store)`
- New store methods on `TileForecastStore`:
  - `manifestFor(layer): RunManifest | null`.
  - `readTile(layer, tileId, { retain = false }): Promise<DecodedTile | null>`.
    It returns `null` when the manifest has no such tile (all-land tiles are
    never published). It shares `inFlight` and `loadTile()`. With
    `retain: false`, it doesn't touch the decoded LRU, so an export never
    evicts the analysis's tiles.
- The runner lives on the **main thread** and yields between tiles and
  messages (`await new Promise(r => setTimeout(r, 0))`), with an `AbortSignal`
  and progress callbacks. It moves to a Web Worker only if the Phase 4
  measurements require it; the engine API doesn't change.

## GRIB2 encoding specification (the contract)

Moved to [`docs/grib-export.md`](grib-export.md) in Phase 1; that file is now
canonical (section layouts, simple packing, lattice, times, dataset registry,
files and honesty rules, runner). Phase 1 changed three details of the
original draft:

1. **Sampling.** Tiles are forward-mapped through their own header geometry
   (`k = round(position·n/10)`) instead of `i = k − n·row`, because the CMEMS
   tile grids are offset from the 10° lines (see Verified facts). For those
   unaligned layers the plan also reads the neighbouring tile when the lattice
   edge sits exactly on a 10° line.
2. **Constant fields** are written with `nbits = 0`, D = 0 and R = the rounded
   value, because ecCodes and g2clib ignore D when `nbits = 0`.
3. **Bracketing steps** are added only when the window start or end falls
   between two steps; a step equal to `start` or `end` needs no neighbour.

## Phase 1 — Encoder, export engine, CLI, contract tests

No UI. The goal is correct files from **production tiles**, proven by ecCodes.

Tasks:

1. `engine/src/export/grib2.ts`: `encodeGrib2Message(field)` per the
   specification above. It takes discipline, centre, process, cycle,
   forecastTime, category, number, level, D, the lattice header,
   `lonConvention`, and values in output units in scan order (NaN = missing).
2. `engine/src/export/gribDatasets.ts`: the registry, exactly as tabled above.
3. `engine/src/export/exportPlan.ts`:
   - `planGribExport(manifests, request)`. The request is `bbox` (already
     padded), `datasetIds`, `startIso`, `endIso`, `step`, `lonConvention`,
     and an optional `checkpoints: [{lat, lon}]`.
   - It returns, per dataset: availability (`ok` / `no-layer` / `no-tiles` /
     `outside-horizon`), lattice, selected times, tile ids (present/absent),
     `estBytes`, and `downloadBytesUpperBound` (the sum of manifest tile bytes).
4. `engine/src/export/exportGrib.ts`: `runGribExport(source, plan, opts)` per
   the runner algorithm. Also `gribExportSourceFromStore(store)`.
5. `TileForecastStore.manifestFor()` and `readTile()` as described in
   [Architecture](#architecture), plus unit tests in `engine/test/tileStore.test.ts`
   (no LRU eviction when `retain: false`, shared in-flight load, `null` for
   an unpublished tile).
6. Export everything from `engine/src/index.ts`.
7. CLI: add a `grib` command to `engine/src/cli.ts`:
   ```
   npm run cli -w engine -- grib --bbox 48,51,-6,2 --datasets wind-gfs,waves-gfs,currents-global,currents-ibi \
     --from 2026-09-24T06:00Z --to 2026-09-26T06:00Z [--step all|3|6] [--out output/grib] \
     [--base-url https://forecast.deepregatta.com | --tiles-dir <local run dir>] \
     [--lon-convention 0-360|signed] [--check 49.65,-1.62]
   ```
   It writes the `.grb2` files plus `summary.json` (the runner summary, without
   the bytes). Uses `HttpTileTransport` with `MemoryTileCache`, or
   `FsTileTransport`.
8. Engine tests (`engine/test/grib2.test.ts`, `engine/test/exportGrib.test.ts`):
   - section lengths and total length; sign-magnitude for negative latitude
     and D; bitmap bit order;
   - nbits = 0 for a constant field; skipped all-missing messages;
   - Greenwich wrap for Lo1/Lo2; row flip;
   - thinning and bracketing of the time window;
   - a multi-tile mosaic with a missing (unpublished) tile;
   - kt → m/s; abort mid-run; checkpoints.
9. Golden GRIB fixtures, `engine/test/fixtures/grib/`:
   - Generator: `engine/scripts/make-grib-fixtures.ts` (run with tsx). An
     engine test asserts that re-encoding **byte-matches** the committed
     files, so any encoder change forces regeneration and re-validation.
   - Each fixture has `<name>.grb2` plus `<name>.expected.json`: the expected
     keys per message, and values at about 6 points including missing ones.
   - Fixtures:
     - `wind-gfs-golden`: from the golden weather tile (all 8×8 points, 4
       hourly steps).
     - `waves-greenwich`: synthetic `buildFixtureRun` over N40W010 + N40E000,
       with NaN land cells and a box across 0°.
     - `currents-glo12`: synthetic 1/12°, `pointsPerSide` 12.
     - `wind-south`: synthetic tile in the southern hemisphere (negative
       latitudes).
10. Consumer contract, `analysis/tests/test_grib_export_contract.py`:
    - Decode every fixture with ecCodes.
    - Assert discipline, category, number, typeOfFirstFixedSurface and value,
      centre, dataDate/dataTime, forecastTime, Ni/Nj, first/last lat/lon in
      degrees, Di/Dj, scanningMode, bitmapPresent.
    - Assert values within `0.5·10^-D + tile quantization`; missing points
      must decode as missing.
    - Locate fixtures via `Path(__file__).resolve().parents[2] / "engine/test/fixtures/grib"`.
11. `analysis/scripts/inspect_grib.py <file> [--point lat,lon]`: prints one
    row per message (param, level, time, grid, min/max, value at the point).
    Used for manual checks.
12. `docs/grib-export.md`: the spec (copy the specification section from this
    plan, then keep it canonical there). Add it to the `docs/README.md` index,
    and add the fixtures and contract test to `docs/testing.md`.

Validation before exit:

- `npm run lint`, `npm test`, `(cd analysis && uv run pytest -q && uv run ruff check . && uv run ruff format --check .)`.
- Run the CLI against **production** for a Channel box (`48,51,-6,2`, all five
  datasets, next 48 h), then `inspect_grib.py` each file. Check:
  - keys match the registry;
  - land is missing in waves and currents;
  - Ni/Nj and corners are as expected.
- One-off cross-check, not committed: fetch NOAA's own `UGRD:10 m above ground`
  and `HTSGW` messages for the same cycle and step by byte range. The `.idx`
  is at
  `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF.idx`
  (waves: `…/wave/gridded/gfswave.tHHz.global.0p25.fFFF.grib2.idx`). Compare
  5 in-box points: wind within 0.1 m/s, Hs within 0.01 m.

Exit criteria:

- [x] CI green on main (all three jobs): run 35930782176 on `ba47344`.
- [x] Production CLI export decodes cleanly in ecCodes; NOAA cross-check passes.
- [x] `docs/grib-export.md` committed; this plan's status line updated.

Results (2026-09-23 22:50 UTC, runs `*-20260923T00Z`):

- Local checks: `npm run lint`, `npm test` (engine 381, viewer 459),
  `uv run pytest -q` (508, including the 13 contract checks), `ruff check` and
  `ruff format --check` all pass.
- Production CLI, Channel box `48,51,-6,2`, all five datasets, next 48 h,
  cold cache: 6.8 s, 339 MB peak RSS. GFS wind 33×13 × 49 steps (82 kB), ECMWF
  18 steps (20 kB), waves 18 steps × 9 variables (71 kB), GLO12 97×37 × 10
  steps (43 kB), IBI 289×109 × 49 hourly steps (2.2 MB). `inspect_grib.py`:
  keys match the registry, corners 51/354 → 48/2 (µ° steps on 1/12° and 1/36°),
  land missing in waves and currents, no missing wind.
- NOAA cross-check at f024 (byte ranges from the `.idx`), five points
  (50.0,−2.0), (49.5,−3.0), (50.25,−0.5), (49.0,−5.0), (50.5,1.0): largest
  differences UGRD 0.006, VGRD 0.027, GUST 0.015 m/s (target 0.1); HTSGW
  0.000 m (target 0.01); PERPW 0.04 s; DIRPW 0.04°.

## Phase 2 — Planner GRIB export, live in production

The goal is a working **Download GRIBs** feature on production, visible to
everyone, with **no hidden flag**. The current users (Davi and Jacques) test
this production version directly, including in Adrena. Adrena fixes follow in
Phase 3.

Tasks:

1. `viewer/src/lib/gribExport.js`:
   - **Bbox:** the route's waypoints (compute mode: the computed route, else
     the two endpoints) ± margin, clamped.
   - **Default margin:** 1.0°.
   - **Default window:** from max(departure, now), floored to the hour, to
     that + ETA + 24 h. ETA is `distance / speeds.slow` in draw mode,
     `computed.duration_h` in compute mode, else 48 h. Clip each dataset to
     its horizon.
   - **Default step:** `all`.
   - Calls `planGribExport` / `runGribExport` with `forecastStore()` (the
     same pinned runs as the analysis).
   - Blob URLs via `URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }))`.
     Revoke them on regenerate and unmount.
   - **Longitude test override:** `#plan/planner?gribLon=signed` switches
     `lonConvention` for Adrena testing, and `?gribLon=0-360` resets it. It is
     persisted in `localStorage` (`deepweather.gribLonConvention`, reads and
     writes wrapped in try/catch), because in-app navigation drops the hash
     query. This switches one encoding detail. It does not hide the feature.
     Phase 3 removes it or makes the chosen value the default.
2. `viewer/src/pages/planner/GribExport.jsx`: a section below the planner grid
   (the `DepartureComparison` pattern). It has:
   - margin input (0–5° in 0.5° steps);
   - one checkbox per dataset, showing its availability (disabled with a
     reason when unavailable), its time range, and its estimated output size;
   - per-dataset messages for partial coverage (IBI) and a horizon shorter
     than the window (IBI: 72 h);
   - a step select (`all` / 3 h / 6 h);
   - **Prepare files**, which shows progress and becomes **Cancel** while
     running;
   - after preparing, one **Save** link per file (`download` attribute) with
     its size;
   - a collapsed **File details** section per file: run id, cycle, time list,
     grid, a short `fnv64`, and the spot values (checkpoints) used to compare
     against Adrena;
   - the attribution, not-for-navigation and currents copy.
3. A **Download GRIBs…** button in the Passage panel (`Planner.jsx`), enabled
   whenever a route (or two endpoints) exists. It opens and scrolls to the
   section. `PlannerMap.jsx` gets an `exportBbox` prop that draws a dashed
   react-leaflet `Rectangle` while the section is open.
4. Analytics: `track('grib_export', { datasets: 'wind-gfs,waves-gfs', size_bucket: '1-5MB' })`.
   Low-cardinality values only; never coordinates.
5. French: every new string goes into `viewer/src/i18n.js` and
   `viewer/test/i18n.test.js` in the same commit. Watch JSX text-node
   splitting. Users may use `/fr/`.
6. Docs (the feature is public from this phase):
   - `README.md` product flow: add the GRIB download.
   - `docs/product-brief.md`, *Current product surface → Plan*: add
     "download GRIB2 files of the forecast for the route area".
   - `docs/grib-export.md`: add the viewer defaults and the `gribLon` override.
7. Viewer tests, `viewer/test/gribExport.test.jsx`, with a mocked store
   (`describe()` + manifests):
   - bbox and margin; window defaults and clipping;
   - availability, partial-coverage and horizon states;
   - Save links are created and revoked;
   - the `gribLon` override is parsed and persisted.
8. Verify locally:
   - `viewer-demo` for UI states (no live tiles there: expect "unavailable").
   - `npm run build:pages` then the `static-dist` launch config for real
     Pages behaviour.
   - E2E: `npm run test:e2e -w viewer -- --workers=1`. The new button changes
     the Planner, so update screenshot baselines (`--update-snapshots`) only
     for that intended change, and review each diff.
9. Commit and push to main (Pages deploys). Then smoke-test production in the
   built-in browser:
   - Open `https://passage.deepregatta.com/#plan/planner`.
   - Draw a Cherbourg → Solent route and prepare all available datasets.
   - Check: no console or CSP errors; tile requests go to
     `forecast.deepregatta.com`.
   - The `fnv64` of each file equals the CLI's `summary.json` for the same
     bbox, datasets, window and runs. This proves browser output = CLI output
     = the ecCodes-validated path.
   - Repeat on `/fr/` for untranslated text.

Exit criteria:

- [x] Feature live on production for everyone, EN and FR; smoke test passed;
      hashes match the CLI; CI green; docs updated. CI run 35971792022 on
      `bd6117b`.
- [x] Adrena test steps and checklist (below) handed to Davi and Jacques in
      the Phase 2 report, 2026-09-24.

Results (2026-09-24, runs `*-20260923T00Z`):

- Local checks: `npm run lint`, `npm test` (engine 394, viewer 489), e2e 64
  on a fresh `viewer-demo` server. Only the `plan.png` baselines changed (the
  new disabled **Download GRIBs…** button, 50 px taller).
- Smoke test, `npm run build:pages` + `static-dist` and then production
  (`?dr_traffic=qa`): Cherbourg → Solent draft (49.65,−1.62 → 50.25,−1.45 →
  50.77,−1.3), 1° margin, window Thu 24 Sep 07:00 → Fri 25 Sep 23:00 UTC, all
  five datasets. The browser's `fnv64` equals the CLI's `summary.json` for
  `--bbox 48.65,51.77,-2.62,-0.3` and the same window, for every file:

  | File | Grid × steps | Size | fnv64 |
  |---|---|---|---|
  | GFS wind | 11×15 × 41 | 39 kB | `010445d74b97d258` |
  | ECMWF wind | 11×15 × 15 | 9 kB | `bee6edca5450997f` |
  | GFS-Wave | 11×15 × 15 (38% points with data) | 36 kB | `2a599cd9bfbe2985` |
  | GLO12 currents | 30×40 × 8 | 12 kB | `96503fda6989e543` |
  | IBI currents | 86×114 × 41 | 534 kB | `bb393fad51536668` |

  The Save blobs themselves hash to the same values and start with `GRIB`.
  No console or CSP errors; every tile and manifest request went to
  `forecast.deepregatta.com`; `grib_export` was stored as QA traffic.
- `/fr/`: the section has no English left and gives the same hashes. The
  smoke test caught one bug, fixed before release: the French `\bwaves\b`
  fragment turned the run id `waves-…` into `vagues-…`. Identifiers now sit
  in `<code>`, which the DOM translator skips, and a viewer test covers it.

## Phase 3 — Adrena feedback and refinements

**Adrena result (Davi, 2026-09-27).** On Jacques's boat PC (Windows, Adrena
basic edition), wind and currents files for an English Channel box around
Greenwich imported and displayed "flawlessly", including across 0°. No
encoding fix was needed, so `0-360` stays the longitude convention. Waves were
not part of the test.

**UI finding.** Jacques could not download the files on his own: he was
"lost since the beginning". The Phase 2 flow needed a route first, and the
button was the third in the Passage panel, disabled with no reason given. The
form opened below the page, far from the map. It used three verbs for one
action (**Download GRIBs…** → **Prepare files** → **Save**), asked about
eight questions in model names, and gave one Save link per file.

Davi's decisions (2026-09-28):

- Keep **separate files**, one per kind. A combined file risks problems, and
  sailors use other software than Adrena.
- Sailors find it more intuitive to **draw a rectangle** over their zone.
- **ECMWF is the default wind model in Europe**, and defaults always prefer
  the local model.
- A dedicated page with one-click downloads and remembered or bookmarkable
  areas (the rest of the proposal).

Tasks:

1. [x] Adrena fixes: none needed. The `gribLon` override and its
   `localStorage` key are removed; `0-360` is the only convention.
2. [x] **GRIB files page** (`#plan/grib`, the Plan stage's **GRIB files**
   tab). Draw a box (drag or two clicks; corner handles resize it, no redraw
   button since 2026-09-28), choose a
   period, click **Download wind / currents / waves**. Each click builds and
   saves one file. Local model first: ECMWF wind in Europe, IBI currents
   where they cover the whole box. The area and choices are remembered, and
   the address (`#plan/grib?area=S,N,W,E`) can be bookmarked. The Passage
   panel's **Download GRIBs…** is always enabled and hands over the route's
   box ± 1°. Spec: [grib-export.md → GRIB files page](grib-export.md#grib-files-page-viewer).
3. [~] Size guardrails: each file shows its estimate and is blocked above
   200 MB ("Draw a smaller box or choose a shorter period."). Not done: the
   "up to X MB to fetch" upper bound and a 50 MB warning. Tune both with the
   Phase 4 measurements.
4. [x] Window presets are superseded by the **Period** select (next 2 / 3 /
   5 / 7 days, or Full forecast).
5. **Save all (.zip)** was dropped: files stay separate (Davi, 2026-09-28).
6. [x] Docs and the French catalogue; viewer tests
   (`viewer/test/gribExport.test.jsx`) and a Playwright test that draws the
   box on the real map (`viewer/e2e/grib.spec.js`). Only the `plan.png`
   baselines changed: the new tab and the now-enabled button.

Exit criteria:

- [x] Adrena sign-off recorded here: 2026-09-27, Adrena basic edition on
      Windows, wind + currents, box across 0°.
- [x] Fixes and refinements live on production, EN and FR; CI green; docs
      updated. CI run 36479242380 on `74d9dfb`. Production smoke test
      (2026-09-28, `?dr_traffic=qa`): box 48.9–51°N, 4.7°W–1.2°E, next 3
      days. The wind (ECMWF, `fb92d51c7f27dd41`) and currents (IBI,
      `5964449b10638a6b`) files match the CLI `fnv64` for the same box,
      window and runs. `/fr/` has no English left.

## Phase 4 — Measure and decide (optional)

1. Reference exports with a cold cache:
   - Channel (Cherbourg → Solent);
   - Biscay (Brest → A Coruña);
   - western Med (Palma → Barcelona);
   - stress case: Biscay with a 5° margin and the full forecast.

   Measure: bytes fetched, time to prepare, the longest main-thread task
   (`PerformanceObserver` `longtask`), peak JS heap, output size. Do this on
   desktop and in Chrome mobile emulation with 4× CPU throttling (plus a real
   phone if available). Record the results here.
2. Decision rules:
   - **Longest task > 250 ms or heap > 400 MB:** move `runGribExport` into a
     module Web Worker. The engine stays unchanged. The worker builds its own
     `TileForecastStore` pinned to the main store's run ids (a transport
     whose `fetchLatest()` returns the pinned doc) and uses the same IndexedDB
     tile cache.
   - **A cold-cache Channel export fetches > 40 MB**, mostly IBI: present the
     Cloudflare Worker option to Davi. Since 2026-09-29 the four IBI Channel
     tiles alone are about 36.6 MB (0–120 h), so measure the IBI file first. It reads R2 through a binding, uses the
     same engine code, and needs the paid plan. **Don't build it without
     Davi's go-ahead.**
3. Tune the Phase 3 size limits from the measurements.
4. Optional: a "Download GRIBs" entry on the Briefing page, using the
   snapshot's recorded run ids while those runs are still retained (current +
   previous run only).

## Phase 5 — Fresher forecast runs (independent track: forecast-tiles + passage)

**Why.** A GRIB download makes the forecast's age obvious. Today every layer
is ingested once a day, and GitHub starts the scheduled jobs 4–6.5 h late. So
the newest GFS run Passage serves is published about 8 h 45 min after its
cycle time and replaced only a day later: it can be up to about 33 h old.
**Target:** ingest every provider cycle, published within about 30 min of the
provider finishing it.

Work from the container directory `/home/davi/projects/deepregatta`, because
the work spans both repos. Commit and push to each repo's main.

### Measured 2026-09-23

GitHub scheduled-trigger delay, over the last 6 days of runs:

| Workflow | Cron (UTC) | Run actually created (UTC) |
|---|---|---|
| forecast-tiles `ingest-weather` | 03:30 | 08:10–09:08 |
| `ingest-waves` | 03:45 | 08:16–09:17 |
| `ingest-ensemble` | 04:00 | 08:31–09:35 |
| `ingest-weather-ecmwf` | 05:15 | 09:33–10:45 |
| `ingest-currents` | 13:00 | 16:13–18:28 |
| `ingest-currents-ibi` | 15:00 | 17:53–19:55 |
| passage `prepare-synoptic` | 05:25, 11:25, 17:25, 23:25 | 10:05, 15:28, 20:29, 01:33 |

When each provider finishes a cycle. This is the `Last-Modified` time of the
exact file each `resolve()` waits for:

| Layer | File probed | 00Z | 06Z | 12Z | Lag after cycle time |
|---|---|---|---|---|---|
| `weather` (GFS) | `noaa-gfs-bdp-pds/gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.f240.idx` | 04:41 | 10:37 | 16:38 | ≈ 4 h 40 |
| `waves` | `…/wave/gridded/gfswave.tHHz.global.0p25.f384.grib2.idx` | 05:14 | 11:25 | 17:10 | ≈ 5 h 10–5 h 25 |
| `ensemble` | `noaa-gefs-pds/gefs.YYYYMMDD/HH/atmos/pgrb2ap5/gep30.tHHz.pgrb2a.0p50.f384.idx` | 06:29 | 12:30 | 18:31 | ≈ 6 h 30 |
| `weather-ecmwf` | `data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p25/oper/YYYYMMDDHH0000-240h-oper-fc.index` | 07:34 | none (06Z stops at 144 h; published 12:27) | 19:34 | ≈ 7 h 35, 00Z and 12Z only |
| `currents` | CMEMS catalogue | once a day | | | daily |
| `currents-ibi` | STAC `admp_updated_data` of `cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m` (measured 2026-09-28) | ≈ 09:55–11:40, once a day | | | ≈ 10–11 h 40 |

From 2026-09-29 `ingest-currents-ibi` runs hourly from 07:50 to 14:50 UTC
instead of at 15:00.

**CMEMS publication, measured 2026-09-28** (forecast-tiles
`docs/ibi-currents.md` → *When CMEMS publishes*). The IBI bulletin of day D
lands as native files at 09:40–09:44 UTC. Copernicus then rewrites the ARCO
store the ingest reads, and finished at 09:54–11:33 (24–28 Sep; on 28 Sep the
catalogue's `arco_updated_date` is 11:36:46). Each dataset's STAC item is
public and needs no credentials:
`https://s3.waw3-1.cloudferro.com/mdl-metadata/metadata/{product}/{dataset}_{version}/dataset.stac.json`.
It carries `end_datetime`, `admp_updated_data` and `admp_updating_start_date`
(set while an update runs). A new bulletin is complete when `end_datetime`
has moved and `admp_updating_start_date` is null. GLO12's timing is not
measured yet. Watched on 2026-09-29: the time axis moved at 09:48 while
`admp_updating_start_date` named only the appended day, and the data finished
at 11:08:40, so a probe must wait for the flag to clear, not just for
`end_datetime` to move.

Smoke test, 2026-09-29 11:20 UTC, box 48.9–51°N, 4.7°W–1.2°E, next 3 days:

- CLI against production: `currents-ibi-20260929T00Z`, 73 hourly steps
  29 Sep 11:00 → 2 Oct 11:00, 146 messages, fnv64 `e8181f3b82bb9967`, fetch
  ≤ 35.0 MB, 5.7 s, 401 MB peak RSS. `inspect_grib.py` decodes every message.
  At 05:00 the same request from the 0–72 h run `currents-ibi-20260928T00Z`
  ended 1 Oct 00:00: 44 steps, 43 of the 72 h.
- GRIB page (`?dr_traffic=qa`): "Tue 29 Sep 11:00 → Fri 2 Oct 11:00 UTC · 73
  steps · ≈ 3.3 MB" with no "This forecast ends…" note; `/fr/` shows "73
  échéances" and the French tidal-stream disclosure.

Other facts:

- **Job durations:** weather, waves and ensemble take 12–19 min; ECMWF 10–100
  min (its server varies); GLO12 35–46 min; IBI 1–2 min.
- **Retention is by count** (current + previous run per layer), so more
  frequent runs **don't** increase storage: still about 6 GB of the 8 GB
  guard. But a run is deleted one cycle after it's superseded, which at a
  6-hourly cadence means about 12 h after publication instead of about 48 h.
- **R2 writes at the target cadence:** about 9,200 tile PUTs a day (weather
  648, waves 530 and ensemble 648 tiles × 4; ECMWF 648 × 2; GLO12 542; IBI
  11). That's about 280k a month, under R2's free 1M Class A operations a
  month. Today it's about 3,000 a day.
- **Triggering:** `workflow_dispatch` runs start within about 10 s.
  GitHub's `schedule` is best-effort: runs can be delayed or dropped under
  load. Measured 2026-09-29: every daily cron started 5.5–6.5 h late
  (`ingest-weather` 03:30 → 09:59, `ingest-currents` 13:00 → 18:27), and of
  the eight hourly `ingest-currents-ibi` slots (07:50–14:50, live from 05:15)
  GitHub had created **one** run (14:22) by 18:40. More slots don't give more
  runs. Scheduled workflows in a public repo are also disabled after 60 days
  without repository activity, which is a latent risk to all ingestion today.
  Every ingest workflow already has `workflow_dispatch` with a `cycle` input
  and `concurrency: {group: ingest-<layer>, cancel-in-progress: false}`.
- **GLO12's provider time**, seen once: its public STAC item
  (`…/GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i_202406/dataset.stac.json`)
  had `admp_updated_data` 06:25:55 UTC on 2026-09-29, while that day's
  `ingest-currents` run started at 18:27.
- **Peak memory**, from a scaled replay of each layer's array code on
  2026-09-29 (numpy buffers only; downloads and xarray overhead come on top):
  ensemble ≈ 15.2 GB, waves ≈ 4.8, weather ≈ 3.7, GLO12 ≈ 2.9, IBI ≈ 2.6;
  ECMWF ≈ 2 GB estimated from the code. A public-repo `ubuntu-latest` runner
  has 16 GB.
- **Ingest re-publishes a cycle that's already live.** `_update_latest`
  handles the same-cycle case, so a frequent trigger would re-upload whole
  runs. It needs an early "already published" exit.
- **Passage assumes a daily cadence:**
  - `engine/src/briefing.ts` `PUBLICATION_SCHEDULE` has `cadenceHours: 24`
    per layer, and `lag >= cadence` suppresses the next-run estimate.
  - `TileForecastStore` pins runs for the page's lifetime and never refreshes.

### Target: publish every provider update

Every cycle a provider publishes is ingested, as soon as it is out. The
providers' own cadences are:

| Layer | Cycles | Expected publication (UTC) |
|---|---|---|
| `weather` (GFS) | 00/06/12/18 | ~05:00, 11:00, 17:00, 23:00 |
| `waves` | 00/06/12/18 | ~05:45, 11:45, 17:45, 23:45 |
| `ensemble` | 00/06/12/18 | ~07:00, 13:00, 19:00, 01:00 |
| `weather-ecmwf` | 00/12 (full 240 h) | ~08:00, 20:00 |
| `currents-ibi` | 1 bulletin a day (Copernicus) | within ~10 min of Copernicus finishing the update |
| `currents` (GLO12) | 1 bulletin a day (Copernicus) | within ~1 h of the provider update (the job alone takes 35–46 min) |

The worst-case age of the newest GFS run served drops from about 33 h to
about 11 h.

ECMWF also publishes 06Z/18Z, but only to 144 h (checked 2026-09-29: the 06Z
`144h` index was there at 12:27 UTC, `147h` and later were absent; the
`ecmwf_open.py` docstring's "90 h" is stale). **Open, Davi to decide:** serve
them too, and how, given the shorter horizon. Until then, ECMWF publishes
00Z/12Z. Before serving them, check that Passage's model-disagreement analysis
and the GRIB export handle a shorter ECMWF horizon.

### Mechanism: a timetable dispatcher Worker, and an ingest that waits

Chosen with Davi on 2026-09-29. It replaces the Worker first planned here,
which probed every provider every 10 min. Providers publish at known times,
so the Worker only keeps the clock. GitHub's `schedule` can't do this job
because it starts runs hours late and drops slots (*Other facts* above).
`workflow_dispatch` runs start within about 10 s, so ingestion stays on free
GitHub runners and only the clock moves to Cloudflare.

- **New `forecast-tiles/dispatcher/`:** a TypeScript Worker with
  `wrangler.toml`: Cron Triggers only, no `fetch` handler, no routes,
  `workers_dev = false`, Workers Logs on (`[observability] enabled = true`).
  Timetable (UTC):

  | Cron | Layer | Cycle dispatched | Provider ready (measured) | `wait_minutes` |
  |---|---|---|---|---|
  | `25 4,10,16,22 * * *` | `weather` | fire time − 4 h 25 | cycle + 4 h 37–4 h 41 | 90 |
  | `0 5,11,17,23 * * *` | `waves` | fire time − 5 h | + 5 h 10–5 h 25 | 90 |
  | `15 0,6,12,18 * * *` | `ensemble` | fire time − 6 h 15 (00:15 → previous day 18Z) | + 6 h 29–6 h 31 | 90 |
  | `20 7,19 * * *` | `weather-ecmwf` | fire time − 7 h 20 | + 7 h 34 | 120 |
  | `45 5,9 * * *` | 05:45 `currents`, 09:45 `currents-ibi` | that day's 00Z | GLO12 06:25 (seen once); IBI 09:54–11:36 | 180 each |

  Five expressions use all of the Workers Free plan's 5 Cron Triggers per
  account. If the account needs a slot elsewhere, use one `*/5 * * * *`
  expression and keep the same table in code: a tick contacts nothing unless
  a layer is due.
- **On each fire:** take the cycle from `controller.scheduledTime`, not
  `Date.now()`. Then `POST /repos/deepregatta/forecast-tiles/actions/workflows/ingest-<layer>.yml/dispatches`
  with `{"ref":"main","inputs":{"cycle":"YYYYMMDDTHH","wait_minutes":"N"}}`.
  The 200 response carries `workflow_run_id`: log the run URL. Log 401/403
  loudly. If the dispatch fails because the workflow is disabled, `GET` it.
  If its `state` is `disabled_inactivity`, `PUT …/enable` and dispatch once
  more. The Worker never contacts a provider, `latest.json` or the runs list.
- **`DRY_RUN`** (default `true` in `wrangler.toml`): log instead of
  dispatching, e.g. `would dispatch ingest-weather cycle=20260930T06 wait=90
  scheduled=10:25:00Z fired=10:25:02Z`. The docs promise no timing for Cron
  Triggers ("run on underutilized machines"), so the dry run measures it.
- **The ingest waits for its cycle** (`--wait-minutes N`, workflow input
  `wait_minutes`, default 0, so crons and manual dispatches behave as now).
  With an explicit `--cycle`, it retries readiness on `CycleNotAvailableError`
  every 60 s (CMEMS and ECMWF: 120 s) until the deadline, then runs the
  "already published" check and the build as today. When the wait runs out,
  it exits 1 ("cycle not available after N min"), so a missed slot shows up as
  a failed run. Readiness per layer:
  - `weather`, `waves`, `ensemble`: `resolve(requested)` already `HEAD`s the
    completion file.
  - `weather-ecmwf`: `resolve(requested)` already compares with the latest
    full-horizon cycle.
  - `currents-ibi`: check the public STAC item first (`end_datetime` ≥ cycle
    + 239 h and `admp_updating_start_date` null), then the existing catalogue
    checks in `build_cube`.
  - `currents` (GLO12): **new check.** Today `build_cube` raises
    `RuntimeError` for missing instants, and the CLI falls back to RTOFS on
    any exception. At 05:45 that would publish RTOFS as the day's run and
    block GLO12 until the next day. Read GLO12's STAC item
    (`admp_updated_data` on or after the cycle's day, and
    `admp_updating_start_date` null). If it isn't ready, raise
    `CycleNotAvailableError`, which must pass through the RTOFS fallback
    instead of triggering it, and add `currents` to
    `SKIP_WHEN_NOT_AVAILABLE`. RTOFS stays the fallback for real CMEMS
    failures. Record `provider_updated_at` in GLO12's provenance, as IBI
    does, so its publication time gets measured.
- **Workflows:** add the `wait_minutes` input, `run-name: ingest-<layer> ${{
  inputs.cycle || 'scheduled' }}`, and `timeout-minutes: 240`. That covers the
  longest wait plus the longest job: ECMWF 120 + 100, GLO12 180 + 46, all
  under the 6 h job limit. Waiting costs nothing: `forecast-tiles` is public.
- **Concurrency** is unchanged (`ingest-<layer>`, no cancel-in-progress). A
  waiting job holds its group; a fallback cron run queues behind it and exits
  "already published". GitHub keeps one pending run per group, so place the
  fallback crons away from the dispatch times.
- **Token:** a fine-grained personal access token scoped to
  `deepregatta/forecast-tiles` only, with **Actions: read and write**
  (Metadata: read is added automatically), stored as the Worker secret
  `GITHUB_TOKEN`. Actions write covers dispatch and enable. If leaked, the
  token can start, cancel and re-run workflows, delete run logs, and enable
  or disable workflows. It can't read secrets or change code. A token can
  have no expiry unless an organization policy forbids it. A GitHub App
  (installation tokens last 1 h) would avoid expiry entirely, but it isn't
  needed for v1. **Davi creates the token and sets the secret. The session
  must never ask for or handle it.**
- **Fallback:** after 5B each workflow keeps one `schedule` every 6 h, away
  from the dispatch times: `37 2,8,14,20 * * *`. It covers a missed dispatch,
  late by GitHub's usual hours. The "already published" exit makes it
  harmless.
- **Cost** (limits read 2026-09-29):
  - Workers Free allows 5 Cron Triggers per account, 100,000 requests a day,
    10 ms of CPU and 50 subrequests per invocation. The dispatcher makes 16
    invocations a day, each with at most 3 subrequests.
  - GitHub Actions is free on public repos with standard runners (4 CPU,
    16 GB).
  - **Minutes:** all Phase 5 ingestion runs in `forecast-tiles`, which is
    public, so it uses none of the org's 2,000 private minutes. Don't add
    scheduled work to private repos.
- **Expected publication** after 5B:

  | Layer | Publication |
  |---|---|
  | GFS | ≈ cycle + 5 h (today + 8 h 45, one cycle a day) |
  | waves | + 5 h 30–5 h 45 |
  | GEFS | ≈ + 6 h 50 |
  | ECMWF | + 7 h 45 to + 9 h 15 (the job takes 10–100 min) |
  | IBI | ≈ 4 min after Copernicus finishes |
  | GLO12 | ≈ 40–50 min after its provider |
- Optional: the same Worker can dispatch Passage's `prepare-synoptic`, which
  has the same 4–6 h delay. It needs a second token scoped to `passage`. Only
  do this once `passage` is public: while private, its 4×/day runs already
  cost about 570 of the 2,000 monthly minutes.
- **Rejected** (comparison of 2026-09-29):
  - GitHub `schedule` at any frequency: measured above.
  - The 10-minute polling Worker: it works, but once the job waits it only
    adds code (provider probes, `latest.json`, runs listing) for the same
    latency.
  - Ingesting on Cloudflare:
    - Workers, Python Workers and Workflows have 128 MB of memory against
      ≥ 2.6 GB needed, and Pyodide has no eccodes or copernicusmarine.
    - Containers need the $5 paid plan and stop at 12 GiB, so the ensemble
      doesn't fit. They would cost about $30–55 a month.
  - Third-party cron services: they would hold the GitHub token.
  - A GitHub job that re-dispatches itself: it holds a runner 24/7, against
    the Actions terms on serverless use.
  - NOAA's SNS push: it needs an AWS account and covers NOAA only.

### 5A — Build everything, switched off

The publishing cadence doesn't change until 5B, which switches it on. The
split exists because Passage must first cope with runs changing under an
open page (task 4). At a 6-hourly cadence a run is deleted about 12 h after
it is published. 5B can follow as soon as Davi has deployed the Worker.

Tasks:

1. [x] **forecast-tiles ingest:** after resolving the cycle, read `latest.json`.
   If that layer's published cycle is ≥ the resolved cycle, print
   `already published` and exit 0 **before downloading anything**.
   `--force` re-publishes on purpose. Tests. Landed 2026-09-29 in
   forecast-tiles `d4f5b8c` for every layer, with a `force` input on each
   ingest workflow. `currents-ibi` also exits 0 ("not available yet") while
   Copernicus reports an ARCO update in progress.
2. **Contract:** add an optional per-layer `cadence_hours` (integer ≥ 1) to
   `latest.json`.
   - Make the canonical change in `passage/contracts/forecast-latest.schema.json`.
     At the same time add `currents-ibi` to its layer enum, closing the OPEN
     item. Then vendor the schema into `forecast-tiles/contracts/`.
   - The producer writes `cadence_hours` from a per-layer config in
     `forecast-tiles`. It stays 24 everywhere until 5B switches the cadence on.
   - Both CIs validate their fixtures against the schema.
3. **Passage engine:** `LayerInfo` carries `cadence_hours` from `latest.json`.
   `nextForecastRuns` uses it and falls back to `PUBLICATION_SCHEDULE` (keep
   the table; update its comment). Update the engine briefing tests and
   `viewer/test/nextRunProse.test.jsx`.
4. **Passage store freshness:**
   - `TileForecastStore.refresh()` re-reads `latest.json`. For each layer
     whose run changed, it loads the new manifest and swaps it in atomically:
     it drops that layer's decoded tiles and keeps unchanged layers. It never
     runs in the middle of an action.
   - The viewer calls it at the start of each user action (check a passage,
     compare departures, compute a route, prepare GRIBs) when the last check
     is more than 10 min old.
   - If a tile fetch returns 404 for a run no longer in `latest.json`,
     refresh once and retry the action. Otherwise show: "The forecast has
     been updated. Try again."
   - Tests with `MemoryTileTransport`.
5. **Audit:** grep the viewer and engine for code that fetches tiles for an
   **older snapshot's** run ids (briefing replay, evidence, changes).
   Snapshots should be self-contained; any tile re-fetch must fail gracefully
   once its run is deleted. Record the findings in this section.
6. **Dispatcher Worker** in `forecast-tiles/dispatcher/`, per *Mechanism*.
   `DRY_RUN=true` by default. Unit tests with a mocked `fetch`:
   - the cycle for every timetable slot, including the day rollover
     (00:15 → previous day 18Z) and the shared CMEMS expression;
   - the dispatch body;
   - the disabled → enable → dispatch path;
   - 401 logging, and dry-run output.

   Add a README section "Dispatcher" with Davi's setup steps (below).
7. **Ingest waits for its cycle**, per *Mechanism*:
   - `--wait-minutes`, with an injectable clock and sleep for tests;
   - the IBI STAC check, and the new GLO12 readiness check with
     `provider_updated_at`.

   Tests: the wait loop (ready at once, ready after two polls, deadline →
   exit 1), GLO12 not ready → no RTOFS publish, and a real CMEMS failure →
   RTOFS as today.
8. **Workflows:** add `wait_minutes`, `run-name` and `timeout-minutes: 240`
   now. It's safe: the input defaults to 0. Leave the crons as they are until
   5B. Exception: `ingest-currents-ibi` moved to hourly slots 07:50–14:50 UTC
   on 2026-09-29.
9. **Ensemble peak memory** (≈ 15.2 GB of the runner's 16 GB, and it will run
   4× a day). `quantize` converts the whole 2.9 GB anomaly array to float64.
   Quantize one member at a time (or in float32) and check the peak again
   with a scaled replay.
10. **Docs:**
    - forecast-tiles README: the layers table gets a cadence column marked
      "target after 5B"; add the dispatcher runbook and the timetable.
    - `passage/docs/forecast-tile-format.md`: the new `latest.json` field.
    - This plan: status line and audit findings.
11. **Passage copy:** grep the English UI copy for "daily", "once a day" and
    "24 h" about forecasts. Fix any in lockstep with the FR catalogue.
12. Commit and push both repos. forecast-tiles CI must pass. Passage CI needs
    Actions minutes (see Verified facts).

Davi's manual steps after 5A (the session prints these at the end):

1. Create a fine-grained token on GitHub (Settings → Developer settings →
   Fine-grained tokens):
   - resource owner `deepregatta`;
   - only the repository `forecast-tiles`;
   - Repository permissions → **Actions: Read and write**;
   - expiry: none, if the organization allows it; otherwise ≤ 1 year, with a
     calendar reminder to renew;
   - if the organization requires approval for fine-grained tokens, approve
     it.
2. Check that the Cloudflare account has no other Worker using Cron
   Triggers: the dispatcher uses all 5 of the free plan. If one does, tell
   the 5B session to switch to the single `*/5` expression.
3. Deploy the Worker and store the token as its secret:
   ```bash
   cd forecast-tiles/dispatcher && npx wrangler login && npx wrangler deploy && npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token into the `wrangler` prompt, never into a chat.
4. Let the dry run go for about 24 h. Expect 16 lines a day like
   `would dispatch ingest-weather cycle=20260930T06 wait=90
   scheduled=10:25:00Z fired=10:25:02Z`, in the Worker's **Logs** tab (kept
   3 days on the free plan) or live with `npx wrangler tail`. Paste a day of
   them into the 5B prompt.

Exit criteria:

- [x] "Already published" exit live: a manual dispatch of a published cycle
      finishes in under 2 min with no uploads. forecast-tiles run
      36560487159 (`currents-ibi`, 2026-09-29): job 54 s, no upload.
- [ ] `latest.json` carries `cadence_hours`; Passage reads it; the schemas
      match, including `currents-ibi`.
- [ ] Store refresh live in Passage; audit findings recorded.
- [ ] Ingest wait live: a manual dispatch of an upcoming cycle with
      `wait_minutes` waits, then publishes within 2 min of the provider
      finishing. GLO12 before its update exits "not available" instead of
      publishing RTOFS.
- [ ] Ensemble peak memory measured below 12 GB.
- [ ] Dispatcher merged with dry-run as the default; Davi's steps handed over.

### 5B — Switch on: publish every provider update (after Davi has deployed the Worker)

Tasks:

1. Check the pasted dry-run lines:
   - all 16 slots fired;
   - `fired − scheduled` is under 2 min;
   - each cycle matches the timetable.
2. Switch on:
   - `DRY_RUN=false`;
   - `cadence_hours`: weather, waves and ensemble 6; ECMWF 12; currents 24;
   - every workflow's cron to the fallback `37 2,8,14,20 * * *` (IBI's
     hourly slots go too).

   Then ask Davi to run `npx wrangler deploy` if the session can't
   authenticate.
3. Verify over the following cycles (schedule a check, or come back after
   24–48 h). For each layer, compute `published_at − cycle` from
   `latest.json` and `status/{layer}.json`. Targets:

   | Layer | Published within |
   |---|---|
   | weather | +5 h 15 |
   | waves | +5 h 50 |
   | ensemble | +7 h 15 |
   | ECMWF 00Z/12Z | +8 h 15 |
   | currents-ibi | `provider_updated_at` + 15 min |
   | currents | `provider_updated_at` + 60 min |

   Also: no missed cycles, and the bucket stays under the guard.
4. Tune the timetable from the measured provider times: dispatch about
   10 min before the earliest time seen, and wait past the latest.
   Measure GLO12 especially.
5. In Passage, a new briefing's next-run estimate is about 6 h after the
   loaded cycle's publication. The GRIB section (if built) shows the new
   cycle.
6. Update the forecast-tiles README cadence column, the `briefing.ts`
   fallback table, and this plan's Verified facts.

Exit criteria:

- [ ] 8 consecutive GFS cycles published within target; no ECMWF 00Z/12Z cycle missed.
- [ ] A week of IBI and GLO12 runs within target.
- [ ] Bucket under 8 GB; R2 Class A projection under 1M a month.
- [ ] Docs updated in both repos.

### Risks

| Risk | Mitigation |
|---|---|
| Token expires, so dispatching stops | The fallback crons keep a slower cadence going. The dispatcher logs 401s loudly. Prefer a token with no expiry; otherwise set a calendar reminder. Optional: open a GitHub issue when a layer falls 2 cycles behind (the token then also needs Issues: write). |
| A provider publishes later than the wait | The run fails visibly ("not available after N min"), and the fallback cron picks the cycle up later. Widen that layer's wait (5B task 4). |
| Cloudflare cron fires late or skips a slot (no documented timing) | Measured in the dry run. The wait absorbs minutes, and the fallback crons cover a skipped slot. |
| Workflow disabled after 60 days without repository activity | The dispatcher re-enables it and dispatches again. |
| A fallback cron run cancels a pending dispatch (one pending run per group) | Fallback minutes sit away from the dispatch times. The cron run still publishes the latest complete cycle. |
| ECMWF server slowness (10–100 min jobs) | The job takes the time, not the trigger. Follow-up: `Client(source="azure")` downloaded a full cycle in about 90 s locally on 2026-09-28, while data.ecmwf.int answered 429. Measure it on a runner before switching. |
| Ensemble runs out of runner memory at 4 runs a day | 5A task 9. |
| Users re-download tiles 4× a day | Expected. The IndexedDB cache evicts old runs; tile sizes don't change. |
| Runs expire while a page is open | 5A store refresh. |
| Dispatcher and fallback cron fire together | Same concurrency group, plus the "already published" exit. |

## Adrena test (end of Phase 2)

The feature is in the normal production app:

- English: `https://passage.deepregatta.com/#plan/grib`
- French: `https://passage.deepregatta.com/fr/#plan/grib`
- The Phase 2 longitude variant (`?gribLon=signed`) was removed in Phase 3:
  `0-360` passed across 0°.

Result: passed for wind and currents on 2026-09-27 (see Phase 3). Steps
for a re-test (for example of waves), on the Phase 3 page: open **Plan →
GRIB files**, **Draw a box** across the Channel and the 0° meridian, click
each **Download** button, then import the files into Adrena. Open **File
details** under each file for its times, grid and spot values.

Checklist. Report per file, with the Adrena version and screenshots of
anything wrong:

1. The file imports without errors; the model and run date are shown.
2. The area matches the rectangle Passage drew; land masking in waves and
   currents lines up with the coast.
3. No gap, jump or mirror at the 0° meridian.
4. The first and last forecast times match the list in Passage. Mind UTC
   versus local time.
5. Wind at the spot point matches Passage's spot values (±1 kt, ±5°), and the
   arrows blow in the stated direction.
6. Gust is shown, if Adrena displays gust. ECMWF gusts (from the first weather-ecmwf run after 2026-09-28) are a
   maximum over the 1, 3 or 6 h before each time (GRIB template 4.8, at
   10 m): check that they are shown as gust too, not as an unknown parameter.
7. Waves: significant height, period and direction are recognised (not an
   "unknown parameter"). The swell and wind-wave fields are recognised.
8. Currents are recognised as currents, not as wind. The direction matches the
   spot values' set. IBI currents turn with the tide from hour to hour.
9. Adrena routing runs with the wind and current files loaded together.

## Risks and fallbacks

| Risk | Detection | Fallback |
|---|---|---|
| Adrena misplaces boxes across 0° with 0–360 longitudes | Checklist 3 | Did not happen (2026-09-27). The fallback would have been `lonConvention: 'signed'` as the default. |
| Currents not recognised at level 1/0 | Checklist 8 (ecCodes already shows them as `unknown` at any level: see Verified facts) | Level 160/0 (depth below sea surface); then try centre 7 |
| Centre 255 rejected | Import error on current files | Try centre 7 for currents, documented as a compatibility choice |
| Adrena needs GRIB1 | Import fails for all files | Write a GRIB1 encoder (a separate, small plan; the lattice and dataset logic are reused) |
| Swell partitions at level 241 ignored | Checklist 7 | Encode the swell fields at level 1/1 |
| ECMWF gust (template 4.8, 10 m) ignored | Checklist 6 | Try the surface level (1/0), which Adrena already reads for GFS gust; template 4.0 only as a last resort, documented as a compatibility choice, because it labels a 1–6 h maximum as an instantaneous gust |
| IBI tiles make downloads heavy | Phase 4 measurements | Phase 4 decision rules |
| Run rotated mid-session (404) | Tile fetch error | "Forecast updated — reload" message |
| GRIB values differ slightly from the briefing | Contract tolerance | Expected (≤ 0.1 m/s wind rounding at D=1); documented in `docs/grib-export.md` |

## Out of scope (v1)

- MSLP (needs a `forecast-tiles` change).
- Ensemble.
- GFS visibility/CAPE/temperature/dew point/precipitation.
- GRIB1.
- Server-side generation.
- Boxes crossing the antimeridian.
- Spatial decimation.
- The Briefing-page entry (Phase 4 option).
