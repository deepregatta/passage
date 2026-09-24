# GRIB export from the planner — implementation plan

Status: direction approved 2026-09-23. **Phase 1 landed 2026-09-24** (engine,
CLI, golden fixtures, ecCodes contract; CI green). **Phase 2 landed
2026-09-24** (planner **Download GRIBs…** live in production for everyone, EN
and FR). **Phase 3 is next**; it needs the Adrena checklist results. Phase 5
(fresher forecast runs) is an independent track added 2026-09-23. Update the
status line and tick the exit criteria as phases land.

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
| `weather-ecmwf` | ECMWF open IFS | 0.25° | `wind_u_kt`, `wind_v_kt` (gust currently absent: step-sparse upstream) | `steps`: 3 h → 144 h, 6 h → 240 h (65) |
| `waves` | GFS-Wave | 0.25° | `hs_m`, `period_s`, `dir_deg`, `wind_wave_h_m`, `wind_wave_period_s`, `wind_wave_dir_deg`, `swell_h_m`, `swell_period_s`, `swell_dir_deg` | `steps`: 3 h → 384 h (129) |
| `currents` | CMEMS GLO12 | 1/12° (runs before 2026-09-24: header dlat 0.08333588) | `cur_u_kt`, `cur_v_kt` | `steps`: 6 h → 240 h (41) |
| `currents-ibi` | CMEMS IBI | ≈1/36° (0.02777863) | `cur_u_kt`, `cur_v_kt` | hourly → 72 h (73); IBI domain only (11 tiles) |
| `ensemble` | GEFS | 0.5° | wind *speed* mean + member anomalies only | not exportable as vectors, out of scope |

- Compressed tile sizes for N40W010: weather 1.39 MB, waves 0.93 MB, GLO12
  0.55 MB, ECMWF 0.31 MB, **IBI 9.8 MB** (IBI run total 64 MB).
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
    about 76 MB of Float32 (360×360×73×2), so it is never retained and must be
    released before the next tile loads.
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
  - No Web Worker exists. The GRIB section (Phase 2) is the viewer's only
    file download: Blob URLs on `<a download>` links.
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
- `passage/contracts/forecast-latest.schema.json` lacks `currents-ibi` in its
  layer enum, although the live `latest.json` includes it. `forecast-tiles`'
  vendored copy already has it (a known OPEN item). Phase 5A closes it.
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

- [ ] Feature live on production for everyone, EN and FR; smoke test passed;
      hashes match the CLI; CI green; docs updated.
- [ ] Adrena test steps and checklist (below) handed to Davi and Jacques.

## Phase 3 — Adrena feedback and refinements

**Prerequisite:** the Adrena checklist results. Apply the fixes first. Each
fix updates `docs/grib-export.md`, the fixtures (re-run the generator) and
`expected.json`, and the contract test must still pass.

Tasks:

1. Fix whatever Adrena rejected (see [Risks](#risks-and-fallbacks)). If a
   variant was needed (longitude convention, current level), make it the
   default. Remove the `gribLon` override once the convention is settled.
2. Size guardrails:
   - Show the total estimated output, plus the "up to X MB of forecast data
     to fetch" upper bound.
   - Warn above 50 MB total. Block above 200 MB with a suggestion (a coarser
     step, a smaller margin, fewer datasets). Tune these numbers in Phase 4.
3. Window presets: "Passage window" (default) and "Full forecast".
4. **Save all (.zip)**: add `fflate` to the viewer and use `zipSync` at level
   0 (GRIB is already packed). Include `SOURCES.txt`: datasets, run ids,
   cycles, attribution, the not-for-navigation notice and the currents notes.
   Individual Save links remain.
5. Docs: finalise `docs/grib-export.md`; French catalogue for all new copy.
6. Tests: extend the viewer tests. Update Playwright baselines only for
   intended changes, and review the diffs.
7. Commit, push, and re-run the production smoke test.

Exit criteria:

- [ ] Adrena sign-off recorded here (date, Adrena version).
- [ ] Fixes and refinements live on production, EN and FR; CI green; docs updated.

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
     Cloudflare Worker option to Davi. It reads R2 through a binding, uses the
     same engine code, and needs the paid plan. **Don't build it without
     Davi's go-ahead.**
3. Tune the Phase 3 size limits from the measurements.
4. Optional: a "Download GRIBs" entry on the Briefing page, using the
   snapshot's recorded run ids while those runs are still retained (current +
   previous run only).

## Phase 5 — Fresher forecast runs (independent track: forecast-tiles + passage)

**Why.** A GRIB download makes the forecast's age obvious. Today every layer
is ingested once a day, and GitHub starts the scheduled jobs 4–5 h late. So
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
| `currents`, `currents-ibi` | CMEMS catalogue | once a day | | | daily |

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
- **Triggering:** `workflow_dispatch` runs start within about a minute.
  GitHub's `schedule` is best-effort: runs can be delayed or dropped under
  load. Scheduled workflows in a public repo are also disabled after 60 days
  without repository activity, which is a latent risk to all ingestion today.
  Every ingest workflow already has `workflow_dispatch` with a `cycle` input
  and `concurrency: {group: ingest-<layer>, cancel-in-progress: false}`.
- **Ingest re-publishes a cycle that's already live.** `_update_latest`
  handles the same-cycle case, so a frequent trigger would re-upload whole
  runs. It needs an early "already published" exit.
- **Passage assumes a daily cadence:**
  - `engine/src/briefing.ts` `PUBLICATION_SCHEDULE` has `cadenceHours: 24`
    per layer, and `lag >= cadence` suppresses the next-run estimate.
  - `TileForecastStore` pins runs for the page's lifetime and never refreshes.

### Target

| Layer | Cycles | Expected publication (UTC) |
|---|---|---|
| `weather` (GFS) | 00/06/12/18 | ~05:00, 11:00, 17:00, 23:00 |
| `waves` | 00/06/12/18 | ~05:45, 11:45, 17:45, 23:45 |
| `ensemble` | 00/06/12/18 | ~07:00, 13:00, 19:00, 01:00 |
| `weather-ecmwf` | 00/12 (full 240 h) | ~08:00, 20:00 |
| `currents`, `currents-ibi` | daily | within ~30 min of the provider update |

The worst-case age of the newest GFS run served drops from about 33 h to
about 11 h.

ECMWF 06Z/18Z (144 h only) is a later follow-up. First check that Passage's
model-disagreement analysis and the GRIB export handle a shorter ECMWF horizon.

### Mechanism: a poll-and-dispatch Cloudflare Worker (recommended)

- New `forecast-tiles/dispatcher/`: a TypeScript Worker with `wrangler.toml`
  and a Cron Trigger every 10 min. Cron Triggers are included in the Workers
  free plan, and waiting on the network doesn't count as CPU time.
- On each tick, for each 6- or 12-hourly layer:
  1. **Candidate cycle:** the newest cycle whose completion file (table above;
     the same URL templates as the Python `resolve()` functions) answers
     `HEAD` with 200.
  2. **Published cycle:** from `https://forecast.deepregatta.com/latest.json`
     (5-min cache, which is fine).
  3. If the candidate is newer and the workflow has no queued or in-progress
     run (`GET /repos/deepregatta/forecast-tiles/actions/workflows/{file}/runs?status=…`),
     then `POST …/actions/workflows/{file}/dispatches` with
     `{"ref":"main","inputs":{"cycle":"YYYYMMDDTHH"}}`.
- **CMEMS layers:** there's no cheap unauthenticated probe. Dispatch at fixed
  daily slots (hourly for 4 h from the current cron times) and rely on the
  ingest's "already published" and "not available yet" exits.
- **`DRY_RUN`** (default `true` in `wrangler.toml`): log decisions without
  dispatching.
- **Token:** a fine-grained personal access token (or a GitHub App) scoped to
  `deepregatta/forecast-tiles` only, with **Actions: read and write**, stored
  as the Worker secret `GITHUB_TOKEN`. **Davi creates the token and sets the
  secret. The session must never ask for or handle it.**
- Keep each workflow's `schedule` as a fallback every 6 h at an off-peak
  minute (e.g. `17 */6 * * *`). The "already published" exit makes it
  harmless.
- **Minutes:** all Phase 5 ingestion runs in `forecast-tiles`, which is
  public, so it uses none of the org's 2,000 private minutes. Don't add
  scheduled work to private repos.
- Optional: the same Worker can dispatch Passage's `prepare-synoptic`, which
  has the same 4–5 h delay. It needs a second token scoped to `passage`. Only
  do this once `passage` is public: while private, its 4×/day runs already
  cost about 570 of the 2,000 monthly minutes.
- **Rejected:** GitHub cron every 15–30 min without a Worker. It's simpler,
  but the measured 4–5 h delays and possible drops make timing unpredictable,
  and it gets disabled after 60 days without activity. Use it only if Davi
  declines the Worker.

### 5A — Build (safe: the cadence stays daily)

Tasks:

1. **forecast-tiles ingest:** after resolving the cycle, read `latest.json`.
   If that layer's published cycle is ≥ the resolved cycle, print
   `already published` and exit 0 **before downloading anything**.
   `--force` re-publishes on purpose. Tests.
2. **Contract:** add an optional per-layer `cadence_hours` (integer ≥ 1) to
   `latest.json`.
   - Make the canonical change in `passage/contracts/forecast-latest.schema.json`.
     At the same time add `currents-ibi` to its layer enum, closing the OPEN
     item. Then vendor the schema into `forecast-tiles/contracts/`.
   - The producer writes `cadence_hours` from a per-layer config in
     `forecast-tiles`. It stays 24 everywhere for now, which is still true.
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
6. **Dispatcher Worker** in `forecast-tiles/dispatcher/`, with unit tests (mock
   `fetch`) for cycle arithmetic, probe URLs and the dispatch decision.
   `DRY_RUN=true` by default. Add a README section "Dispatcher" with Davi's
   setup steps (below).
7. **Workflows:** leave the crons as they are until 5B.
8. **Docs:**
   - forecast-tiles README: the layers table gets a cadence column marked
     "target after 5B"; add the dispatcher runbook.
   - `passage/docs/forecast-tile-format.md`: the new `latest.json` field.
   - This plan: status line and audit findings.
9. **Passage copy:** grep the English UI copy for "daily", "once a day" and
   "24 h" about forecasts. Fix any in lockstep with the FR catalogue.
10. Commit and push both repos. forecast-tiles CI must pass. Passage CI needs
    Actions minutes (see Verified facts).

Davi's manual steps after 5A (the session prints these at the end):

1. Create a fine-grained token on GitHub (Settings → Developer settings →
   Fine-grained tokens):
   - resource owner `deepregatta`;
   - only the repository `forecast-tiles`;
   - Repository permissions → **Actions: Read and write**;
   - expiry ≤ 1 year, with a calendar reminder to renew.
2. Deploy the Worker and store the token as its secret:
   ```bash
   cd forecast-tiles/dispatcher && npx wrangler login && npx wrangler deploy && npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token into the `wrangler` prompt, never into a chat.
3. Watch a few dry-run ticks with `npx wrangler tail`. Expect lines like
   `would dispatch ingest-weather cycle=20260924T06`. Paste some into the 5B
   prompt.

Exit criteria:

- [ ] "Already published" exit live: a manual dispatch of a published cycle
      finishes in under 2 min with no uploads.
- [ ] `latest.json` carries `cadence_hours`; Passage reads it; the schemas
      match, including `currents-ibi`.
- [ ] Store refresh live in Passage; audit findings recorded.
- [ ] Dispatcher merged with dry-run as the default; Davi's steps handed over.

### 5B — Switch on (after Davi has deployed the Worker)

Tasks:

1. Check the pasted dry-run lines: the decisions match the Target table.
2. Switch on:
   - `DRY_RUN=false`;
   - `cadence_hours`: weather, waves and ensemble 6; ECMWF 12; currents 24;
   - workflow crons to the 6-hourly fallback.

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

   Also: no missed cycles, and the bucket stays under the guard.
4. In Passage, a new briefing's next-run estimate is about 6 h after the
   loaded cycle's publication. The GRIB section (if built) shows the new
   cycle.
5. Update the forecast-tiles README cadence column, the `briefing.ts`
   fallback table, and this plan's Verified facts.

Exit criteria:

- [ ] 8 consecutive GFS cycles published within target; no ECMWF 00Z/12Z cycle missed.
- [ ] Bucket under 8 GB; R2 Class A projection under 1M a month.
- [ ] Docs updated in both repos.

### Risks

| Risk | Mitigation |
|---|---|
| Token expires, so dispatching stops | The fallback crons keep a slower cadence going. The dispatcher logs 401s loudly. Calendar reminder. Optional: open a GitHub issue when a layer falls 2 cycles behind (the token then also needs Issues: write). |
| ECMWF server slowness (10–100 min jobs) | The concurrency group queues runs; the 12-hourly cadence leaves slack. |
| Users re-download tiles 4× a day | Expected. The IndexedDB cache evicts old runs; tile sizes don't change. |
| Runs expire while a page is open | 5A store refresh. |
| Dispatcher and fallback cron fire together | Same concurrency group, plus the "already published" exit. |

## Adrena test (end of Phase 2)

The feature is in the normal production app:

- English: `https://passage.deepregatta.com/#plan/planner`
- French: `https://passage.deepregatta.com/fr/#plan/planner`
- Longitude variant, only if files crossing 0° misbehave: open
  `https://passage.deepregatta.com/#plan/planner?gribLon=signed` once. The
  setting is remembered; `?gribLon=0-360` switches it back.

Steps: draw a route (for example Cherbourg → the Solent), click **Download
GRIBs…**, set the margin to 2° (at the default 1° this box stops at about
0.3°W; 2° takes it across the 0° meridian for checklist item 3), tick every
dataset, **Prepare files**, save each file, then import them into Adrena.
Open **File details** under each file for its times, grid and spot values.

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
6. Gust is shown, if Adrena displays gust.
7. Waves: significant height, period and direction are recognised (not an
   "unknown parameter"). The swell and wind-wave fields are recognised.
8. Currents are recognised as currents, not as wind. The direction matches the
   spot values' set. IBI currents turn with the tide from hour to hour.
9. Adrena routing runs with the wind and current files loaded together.

## Risks and fallbacks

| Risk | Detection | Fallback |
|---|---|---|
| Adrena misplaces boxes across 0° with 0–360 longitudes | Checklist 3 | `lonConvention: 'signed'` becomes the default |
| Currents not recognised at level 1/0 | Checklist 8 (ecCodes already shows them as `unknown` at any level: see Verified facts) | Level 160/0 (depth below sea surface); then try centre 7 |
| Centre 255 rejected | Import error on current files | Try centre 7 for currents, documented as a compatibility choice |
| Adrena needs GRIB1 | Import fails for all files | Write a GRIB1 encoder (a separate, small plan; the lattice and dataset logic are reused) |
| Swell partitions at level 241 ignored | Checklist 7 | Encode the swell fields at level 1/1 |
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
