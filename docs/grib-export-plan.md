# GRIB export from the planner — implementation plan

Status: direction approved 2026-09-23. **No phase started.**
Update the status line and tick the exit criteria as phases land.

## How to use this plan

Implement **one phase per session**, in order. Before starting, read:

1. `CLAUDE.md` (repo conventions: commit and push to main, launch configs, provider modes).
2. `docs/forecast-tile-format.md` (PFT1 tiles, manifests, `latest.json`).
3. This whole file, including [Verified facts](#verified-facts). Don't
   re-derive them. If one turns out to be wrong, fix it here in the same commit.

Stop at each phase's exit criteria, commit, push, and report. Phase 3 needs
the Adrena tester's feedback first.

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
| Tester access | The Adrena tester only uses production, so Phase 2 ships a **hidden, link-only** version to `https://passage.deepregatta.com`. It becomes public in Phase 3 after the tester signs off. |

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
| `currents` | CMEMS GLO12 | ≈1/12° (header dlat 0.08333588) | `cur_u_kt`, `cur_v_kt` | `steps`: 6 h → 240 h (41) |
| `currents-ibi` | CMEMS IBI | ≈1/36° (0.02777863) | `cur_u_kt`, `cur_v_kt` | hourly → 72 h (73); IBI domain only (11 tiles) |
| `ensemble` | GEFS | 0.5° | wind *speed* mean + member anomalies only | not exportable as vectors, out of scope |

- Compressed tile sizes for N40W010: weather 1.39 MB, waves 0.93 MB, GLO12
  0.55 MB, ECMWF 0.31 MB, **IBI 9.8 MB** (IBI run total 64 MB).
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
  (`engine/src/cli.ts`) currently only has `run`. `FsTileTransport` in
  `engine/src/io/node.ts` reads a local tile directory.
- Engine test helpers: `engine/test/helpers/fixtureRun.ts` provides
  `buildFixtureRun(specs)` and `MemoryTileTransport`. `pointsPerSide` builds
  small partial tiles. The golden weather tile
  `engine/test/fixtures/tiles/golden-N40W010-weather.bin.gz` is 8×8 at 0.25°
  from 40N/10W, with 4 hourly steps.
- Viewer:
  - Hash routes: the planner is `#plan/planner`. `parseRoute()`
    (`viewer/src/lib/routes.js`) splits `?query` off the hash.
  - No Web Worker or file download exists yet.
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
- Pages auto-deploys from main. Test Pages-like static hosting locally with
  `npm run build:pages` and then the `static-dist` launch config.
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

All multi-byte integers are big-endian. **Signed integers** (latitudes,
section-5 E and D) use **sign-magnitude**: the top bit is the sign, not two's
complement. Every message holds exactly one field at one time, and the file is
the concatenation of its messages.

### Section layouts

| Section | Bytes | Content |
|---|---|---|
| 0 Indicator | 16 | `"GRIB"`, 2 reserved zero bytes, discipline (0 meteorological / 10 oceanographic), edition 2, total length (u64) |
| 1 Identification | 21 | length, 1, centre (u16), subCentre (u16) 0, masterTablesVersion 2, localTablesVersion 0, significanceOfRefTime 1, year (u16), month, day, hour, minute, second = the **layer's model cycle**, productionStatus 0, typeOfProcessedData 1 |
| 3 Grid (template 3.0) | 72 | length, 3, source 0, numberOfDataPoints Ni·Nj (u32), 0, 0, template 0 (u16); shapeOfTheEarth 6, then 3× (scale factor 0xFF, value 0xFFFFFFFF); Ni, Nj (u32); basicAngle 0; subdivisions 0xFFFFFFFF; La1 (i32 µ°); Lo1 (u32 µ°); resolutionAndComponentFlags 0x30; La2; Lo2; Di (u32 µ°); Dj (u32 µ°); scanningMode 0x00 |
| 4 Product (template 4.0) | 34 | length, 4, NV 0 (u16), template 0 (u16), category, number, typeOfGeneratingProcess 2, backgroundProcess 0, generatingProcessIdentifier, hoursAfterCutoff 0 (u16), minutesAfterCutoff 0, unitOfTimeRange 1, forecastTime (u32 hours from cycle), typeOfFirstFixedSurface, scaleFactorOfFirst 0, scaledValueOfFirst (u32), typeOfSecond 255, scaleFactorOfSecond 0xFF, scaledValueOfSecond 0xFFFFFFFF |
| 5 Data representation (template 5.0) | 21 | length, 5, numberOfValues = non-missing count (u32), template 0 (u16), R (IEEE float32), E = 0 (i16 s-m), D (i16 s-m), bitsPerValue, typeOfOriginalFieldValues 0 |
| 6 Bitmap | 6 or 6+⌈N/8⌉ | length, 6, indicator 255 (no missing values) or 0 followed by the bitmap: MSB first, 1 = value present, zero-padded |
| 7 Data | 5+⌈count·nbits/8⌉ | length, 7, packed values: MSB first, zero-padded |
| 8 End | 4 | `"7777"` |

### Simple packing (E = 0)

```
s     = 10^D
ints  = present values.map(v => Math.round(v * s))
R     = min(ints)                  // an integer, |R| < 2^24, so it is exact as float32
X_i   = ints_i − R
nbits = max(X) === 0 ? 0 : ceil(log2(max(X) + 1))   // throw if max(X) ≥ 2^24
decoded = (R + X) / s
```

If a message has no present values, **skip it** and count it in the summary.
It isn't an error.

### Grid lattice (exact integer mapping; no float drift between tiles)

- `n = round(10 / manifest.resolution_deg)` points per tile side (40, 120 or
  360). `stepµ = round(1e7 / n)` µ° (250000, 83333 or 27778).
- Global lattice index `k` ↔ degrees `k·10/n`. For the padded bbox:
  - `kS = floor(minLat·n/10)`, `kN = ceil(maxLat·n/10)`,
    `kW = floor(minLon·n/10)`, `kE = ceil(maxLon·n/10)`.
  - `Nj = kN − kS + 1`, `Ni = kE − kW + 1`.
- Lattice point → tile: `row = floor(k_lat / n)`, `lat0 = 10·row`,
  `i = k_lat − n·row`. The same for longitude, giving the tile id via
  `tileIdFromOrigin`. If `i ≥ header.nlat` or `j ≥ header.nlon` (partial
  fixture tiles), or the tile isn't published, the point is **missing**.
- `La1 = kN·stepµ`, `La2 = kS·stepµ`, `Dj = Di = stepµ`.
  `Lo1 = mod(kW·stepµ, 360e6)`, `Lo2 = mod(kE·stepµ, 360e6)`. This is the
  NCEP 0–360 convention: a box across Greenwich gives, say, Lo1 = 355e6 and
  Lo2 = 2e6.
- Rows are written **north→south**, so tile rows (south→north) are flipped.
  i (longitude) varies fastest.
- The encoder takes `lonConvention: '0-360' | 'signed'`. `'signed'` writes Lo1
  and Lo2 as sign-magnitude degrees in [−180, 180). It is the Adrena fallback
  only; the default is `'0-360'`.
- Known approximation: integer µ° increments for 1/12° and 1/36° drift by
  ≤ 0.0007° (≤ 80 m) at the edge of the globe and ≤ 50 m in scope. Document
  it; it's acceptable.
- Boxes crossing the antimeridian are rejected, like `routeBbox`.

### Times

- Per dataset, all exported variables share one tile axis (`hourly` for GFS
  wind/gust, `steps` otherwise). Axis times = `base + offsets_h`.
- Optional thinning step `s ∈ {all, 3, 6}` h: keep offsets with
  `offset % s === 0`.
- Then keep the steps inside `[start, end]`, **plus** the last step before
  `start` and the first after `end` (so apps can interpolate), clipped to the
  axis.
- `forecastTime` = offset in hours. Section 1 time = the layer's cycle.
- Message order: step-major, then variables in registry order.

### Dataset registry (`gribDatasets.ts`)

| Dataset id | Layer | Tile variable → GRIB (discipline/category/number) | Level (type/value) | Output unit | D | centre / process |
|---|---|---|---|---|---|---|
| `wind-gfs` | `weather` | `wind_u_kt` → 0/2/2 · `wind_v_kt` → 0/2/3 | 103/10 | m/s (kt ÷ 1.943844) | 1 | 7 / 96 |
|  |  | `gust_kt` → 0/2/22 | 1/0 | m/s | 1 |  |
| `wind-ecmwf` | `weather-ecmwf` | `wind_u_kt` 0/2/2 · `wind_v_kt` 0/2/3 · `gust_kt` 0/2/22 **only if listed in the manifest** | as above | m/s | 1 | 98 / 255 |
| `waves-gfs` | `waves` | `hs_m` 10/0/3 · `period_s` 10/0/11 · `dir_deg` 10/0/10 · `wind_wave_h_m` 10/0/5 · `wind_wave_period_s` 10/0/6 · `wind_wave_dir_deg` 10/0/4 | 1/1 | m, s, ° true | 2 (heights), 1 (periods, directions) | 7 / 11 |
|  |  | `swell_h_m` 10/0/8 · `swell_period_s` 10/0/9 · `swell_dir_deg` 10/0/7 | 241/1 |  | 2 / 1 / 1 |  |
| `currents-global` | `currents` | `cur_u_kt` → 10/1/2 · `cur_v_kt` → 10/1/3 | 1/0 (fallback 160/0) | m/s | 2 | 255 / 255 |
| `currents-ibi` | `currents-ibi` | same as `currents-global` | same | m/s | 2 | 255 / 255 |

D is chosen so the output precision is never coarser than the coarser of the
tile and the NCEP original. u/v are earth-relative (flags 0x30).

The registry also holds, for each dataset:

- **UI label**: "Wind – GFS", "Wind – ECMWF", "Waves – GFS-Wave",
  "Currents – global (6-hourly)", "Currents – IBI regional (hourly, tide included)".
- **Attribution**: NOAA; ECMWF CC BY 4.0; "Generated using E.U. Copernicus
  Marine Service Information".
- **Estimated bits per value** for size estimates: wind 10, gust 10, heights
  11, periods 9, directions 12, currents 10.
- **Whether the dataset has land**, i.e. a bitmap (waves and currents).

### Files, summary and honesty rules

- File name: `passage_<datasetId>_<YYYYMMDDTHHZ cycle>_<SW corner>_<NE corner>.grb2`.
  Corners are whole degrees, e.g.
  `passage_wind-gfs_20260923T00Z_N48W006_N51E002.grb2`. When the tiles aren't
  live (dev fixture: `import.meta.env.DEV` or the CLI `--tiles-dir`), the
  prefix is `passage-fixture_` and the UI shows the emulated badge.
- The runner returns one entry per file with:
  - `name`, the byte `parts`, total `bytes` and the `fnv64` of the
    concatenated file;
  - `messages` and `skippedMessages`;
  - `run_id` and `cycle`, the time list, the grid (Ni, Nj, corners, step);
  - `coverage` = fraction of present points;
  - `checkpoints`: values at the lattice point nearest the route's first
    waypoint (and its last) for the first three steps. Wind in kt and
    "from" degrees; gust in kt; Hs in m, period in s, direction in degrees;
    current in kt with its set ("towards"). They are computed from the
    **rounded values actually written**.
- Currents copy must never suggest tidal streams:
  - **Global:** "6-hourly ocean-model currents. Tides are not resolved; do not
    use as tidal streams."
  - **IBI:** "Hourly regional model currents including tide. Not an official
    tidal-stream prediction."
- Always shown: "Forecast data for planning, not for navigation. Check official
  forecasts and warnings." Plus the attribution lines for the ticked datasets.

### Runner algorithm (bounded memory)

```
for each selected dataset (one file at a time):
  cubes[var] = Float32Array(nSteps · Nj · Ni).fill(NaN)
  for tileId of tiles intersecting the lattice (manifest order):
    tile = await source.tile(layer, tileId)      // null → stays missing
    copy the intersecting window of each variable at each selected step index
    drop the tile reference; yield; signal.throwIfAborted(); onProgress
  for step, for variable: encode the message (flip rows, apply units + D), push the part
  compute coverage, checkpoints, fnv64
```

At most one decoded tile is alive at a time. A tile fetch 404 (the run was
rotated while the page stayed open) becomes: "The forecast has been updated.
Reload the page and try again."

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

- [ ] CI green on main (all three jobs).
- [ ] Production CLI export decodes cleanly in ecCodes; NOAA cross-check passes.
- [ ] `docs/grib-export.md` committed; this plan's status line updated.

## Phase 2 — Hidden planner export on production (tester build)

The goal is a working, link-only UI on production for the Adrena tester.

Tasks:

1. `viewer/src/lib/gribExportFlag.js`:
   - Read `grib` and `gribLon` from the hash query (`#plan/planner?grib=1`,
     optional `&gribLon=signed`) on load and on `hashchange`.
   - Persist them in `localStorage` (`deepweather.gribExport`,
     `deepweather.gribLonConvention`), each read and write wrapped in
     try/catch.
   - `?grib=0` clears both. The flag is needed because in-app navigation
     rewrites the hash and drops the query.
2. `viewer/src/lib/gribExport.js`:
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
3. `viewer/src/pages/planner/GribExport.jsx`: a section below the planner grid
   (the `DepartureComparison` pattern), shown when the flag is on and a route
   exists. It has:
   - margin input;
   - one checkbox per dataset, showing its availability (disabled with a
     reason when unavailable), its time range and its estimated size;
   - a step select;
   - **Prepare files**, which shows progress and becomes **Cancel** while
     running;
   - after preparing, one **Save** link per file (`download` attribute) with
     its size and a short `fnv64`;
   - a spot-values table (checkpoints) for the tester to compare in Adrena;
   - the attribution, not-for-navigation and currents copy.
4. A "Download GRIBs…" button in the Passage panel (`Planner.jsx`), shown only
   when the flag is on. It opens and scrolls to the section.
   `PlannerMap.jsx` gets an `exportBbox` prop that draws a dashed react-leaflet
   `Rectangle` while the section is open.
5. French: every new string goes into `viewer/src/i18n.js` and
   `viewer/test/i18n.test.js` in the same commit. Watch JSX text-node
   splitting. The tester may use `/fr/`.
6. Viewer tests, `viewer/test/gribExport.test.jsx`, with a mocked store
   (`describe()` + manifests):
   - flag parse and persist;
   - bbox and margin; window defaults and clipping;
   - availability states;
   - Save links are created and revoked;
   - no UI when the flag is off.
7. Verify locally:
   - `viewer-demo` for UI states (no live tiles there: expect "unavailable").
   - `npm run build:pages` then the `static-dist` launch config for real
     Pages behaviour.
   - E2E suite unchanged: `npm run test:e2e -w viewer -- --workers=1`. With
     the flag off, screenshots must not change.
8. Commit and push to main (Pages deploys). Then smoke-test production in the
   built-in browser:
   - Open `https://passage.deepregatta.com/#plan/planner?grib=1`.
   - Draw a Cherbourg → Solent route and prepare all available datasets.
   - Check: no console or CSP errors; tile requests go to
     `forecast.deepregatta.com`.
   - The `fnv64` of each file equals the CLI's `summary.json` for the same
     bbox, datasets, window and runs. This proves browser output = CLI output
     = the ecCodes-validated path.
   - Repeat on `/fr/` for untranslated text.

Exit criteria:

- [ ] Hidden UI live on production; smoke test passed; hashes match the CLI.
- [ ] Tester links and checklist (below) handed to Davi to forward.

## Phase 3 — Adrena feedback and public release

**Prerequisite:** the tester's checklist results. Apply the fixes first. Each
fix updates `docs/grib-export.md`, the fixtures (re-run the generator) and
`expected.json`, and the contract test must still pass.

Tasks:

1. Fix whatever Adrena rejected (see [Risks](#risks-and-fallbacks)). If a
   variant was needed (longitude convention, current level), make it the
   default.
2. Size guardrails:
   - Show the estimated output per dataset and in total, plus the "up to X MB
     of forecast data to fetch" upper bound.
   - Warn above 50 MB total. Block above 200 MB with a suggestion (a coarser
     step, a smaller margin, fewer datasets). Tune these numbers in Phase 4.
3. Controls:
   - margin 0–5° in 0.5° steps;
   - window presets "Passage window" (default) and "Full forecast";
   - step `all` / 3 h / 6 h;
   - per-dataset messages for partial coverage (IBI) and a horizon shorter
     than the window (IBI 72 h).
4. **Save all (.zip)**: add `fflate` to the viewer and use `zipSync` at level
   0 (GRIB is already packed). Include `SOURCES.txt`: datasets, run ids,
   cycles, attribution, the not-for-navigation notice and the currents notes.
   Individual Save links remain.
5. Remove the flag. The button shows whenever a route (or two endpoints)
   exists. Drop `gribLon` unless Adrena needed it, in which case the chosen
   convention is the default. Keep the fnv64 and spot values in a collapsed
   "File details" section.
6. Analytics: `track('grib_export', { datasets: 'wind-gfs,waves-gfs', size_bucket: '1-5MB' })`.
   Low-cardinality values only; never coordinates.
7. Docs:
   - `README.md` product flow: add the GRIB download.
   - `docs/product-brief.md`, *Current product surface → Plan*: add
     "download GRIB2 files of the forecast for the route area".
   - `docs/grib-export.md`: finalise.
   - French catalogue for all new copy.
8. Tests: extend the viewer tests. Update Playwright screenshot baselines only
   for the intended Planner change (`--update-snapshots`), and review the
   diffs.
9. Commit, push, and re-run the production smoke test without the flag.

Exit criteria:

- [ ] Tester sign-off recorded here (date, Adrena version).
- [ ] Public on production, EN and FR; CI green; docs updated.

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

## Adrena tester handoff (end of Phase 2)

Links:

- English: `https://passage.deepregatta.com/#plan/planner?grib=1`
- French: `https://passage.deepregatta.com/fr/#plan/planner?grib=1`
- Longitude variant, only if files crossing 0° misbehave:
  `https://passage.deepregatta.com/#plan/planner?grib=1&gribLon=signed`

Steps: draw a route (for example Cherbourg → the Solent, which crosses 0°),
click **Download GRIBs…**, tick every dataset, **Prepare files**, save each
file, then import them into Adrena.

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
| Currents not recognised at level 1/0 | Checklist 8 | Level 160/0 (depth below sea surface); then try centre 7 |
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
