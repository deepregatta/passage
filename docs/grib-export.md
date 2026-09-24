# GRIB2 export

Canonical specification of the route-area GRIB2 files Passage writes from
its PFT1 forecast tiles ([tile format](forecast-tile-format.md)). The phased
delivery plan is [grib-export-plan.md](grib-export-plan.md); this file is the
contract and wins where the two differ.

Status: the engine, the CLI and the contract tests landed in Phase 1. Since
Phase 2 (2026-09-24) the planner's **Download GRIBs…** section is live in
production for everyone, in English and French; Adrena sign-off is Phase 3.

## Overview

The export runs in the browser, from the same pinned tile runs Passage uses
for its briefings. There is no server and no `forecast-tiles` change. The same
engine code runs in the Node CLI, so every file the browser writes can be
reproduced and checked with ecCodes.

```
request (bbox + margin, datasets, window, step)
  → planGribExport(manifests, request)       engine/src/export/exportPlan.ts   sync, no I/O
  → runGribExport(source, plan, opts)        engine/src/export/exportGrib.ts   one tile at a time
      source = gribExportSourceFromStore(store)  → TileForecastStore.readTile(layer, tile, {retain: false})
  → encodeGrib2Message(field) per step × variable   engine/src/export/grib2.ts
  → one .grb2 file per dataset = the concatenated messages
```

## Message format

Every message holds one field at one time; a file is the concatenation of its
messages. Multi-byte integers are big-endian. **Signed integers** (latitudes,
signed-convention longitudes, section-5 E and D) are **sign-magnitude**: the
top bit is the sign, not two's complement.

| Section | Bytes | Content |
|---|---|---|
| 0 Indicator | 16 | `"GRIB"`, 2 reserved zero bytes, discipline (0 meteorological / 10 oceanographic), edition 2, total length (u64) |
| 1 Identification | 21 | length, 1, centre (u16), subCentre (u16) 0, masterTablesVersion 2, localTablesVersion 0, significanceOfRefTime 1, year (u16), month, day, hour, minute, second = the **layer's model cycle**, productionStatus 0, typeOfProcessedData 1 |
| 3 Grid (template 3.0) | 72 | length, 3, source 0, numberOfDataPoints Ni·Nj (u32), 0, 0, template 0 (u16); shapeOfTheEarth 6, then 3× (scale factor 0xFF, value 0xFFFFFFFF); Ni, Nj (u32); basicAngle 0; subdivisions 0xFFFFFFFF; La1 (s32 µ°); Lo1 (µ°); resolutionAndComponentFlags 0x30; La2; Lo2; Di (u32 µ°); Dj (u32 µ°); scanningMode 0x00 |
| 4 Product (template 4.0) | 34 | length, 4, NV 0 (u16), template 0 (u16), category, number, typeOfGeneratingProcess 2, backgroundProcess 0, generatingProcessIdentifier, hoursAfterCutoff 0 (u16), minutesAfterCutoff 0, unitOfTimeRange 1, forecastTime (u32 hours from the cycle), typeOfFirstFixedSurface, scaleFactorOfFirst 0, scaledValueOfFirst (u32), typeOfSecond 255, scaleFactorOfSecond 0xFF, scaledValueOfSecond 0xFFFFFFFF |
| 5 Data representation (template 5.0) | 21 | length, 5, numberOfValues = present count (u32), template 0 (u16), R (IEEE float32), E = 0 (s16), D (s16), bitsPerValue, typeOfOriginalFieldValues 0 |
| 6 Bitmap | 6 or 6+⌈N/8⌉ | length, 6, indicator 255 (no missing values) or 0 followed by the bitmap: MSB first, 1 = value present, zero-padded |
| 7 Data | 5+⌈count·nbits/8⌉ | length, 7, packed values: MSB first, zero-padded |
| 8 End | 4 | `"7777"` |

Flags 0x30: both increments given; u/v components are relative to east/north
(earth-relative, as NCEP writes them).

### Simple packing

```
s     = 10^D
ints  = present values.map(v => Math.round(v * s))
R     = min(ints)                  // an integer, |R| < 2^24, so exact as float32
X_i   = ints_i − R
nbits = ceil(log2(max(X) + 1))     // throw if max(X) ≥ 2^24
decoded = (R + X) / s
```

- **Constant fields** (`max(X) = 0`): `nbits = 0`, and the message is written
  with **D = 0 and R = the rounded value itself** (`Math.round(v·s)/s` as
  float32). ecCodes and NCEP's g2clib both return R unscaled when
  `nbits = 0` and ignore D, so a constant 4.5 s written with D = 1 and R = 45
  decoded as 45 s (found by the ecCodes contract test).
- A message with **no present values is skipped** and counted in the file
  summary. It is not an error.
- Readers decode `round(v·10^D)/10^D`. `gribRound()` gives the same value in
  TypeScript (never −0), and spot values are computed from it.

## Grid lattice

The export grid is a regular lattice per dataset resolution, anchored so
tiles and runs never drift against each other.

- `n = round(10 / manifest.resolution_deg)` points per 10° (40, 120 or 360);
  `stepµ = round(1e7 / n)` µ° (250000, 83333 or 27778).
- Global lattice index `k` ↔ `k·10/n` degrees. For the padded bbox:
  `kS = floor(minLat·n/10)`, `kN = ceil(maxLat·n/10)`, `kW = floor(minLon·n/10)`,
  `kE = ceil(maxLon·n/10)` (each snapped by 1e-9 first), clamped to the globe;
  `Nj = kN − kS + 1`, `Ni = kE − kW + 1`.
- `La1 = kN·stepµ`, `La2 = kS·stepµ`, `Dj = Di = stepµ`. With the default
  `'0-360'` convention `Lo1 = mod(kW·stepµ, 360e6)` and `Lo2 = mod(kE·stepµ, 360e6)`
  (NCEP style: a box across Greenwich has, say, Lo1 = 355e6 and Lo2 = 2e6).
  `'signed'` writes `kW·stepµ` and `kE·stepµ` as sign-magnitude µ°; it is an
  Adrena fallback only.
- Rows are written **north→south** (tile rows are south→north, so they are
  flipped); i (longitude) varies fastest.
- Boxes crossing the antimeridian are rejected, like `routeBbox`.
- Known approximation: integer µ° increments for 1/12° and 1/36° put the
  corners up to 0.0007° (≤ 80 m) off the exact `k·10/n` at the edge of the
  globe and ≤ 50 m in scope. Corners stay self-consistent (`La1 − La2 = (Nj−1)·Dj`).

### Sampling tiles onto the lattice

Each tile is **forward-mapped** through its own header: native point `(i, j)`
sits at `header.lat0 + i·dlat`, `header.lon0 + j·dlon` and lands on lattice
index `k = round(position·n/10)` when that is inside the window. Unmapped
lattice points stay missing.

This matters for IBI, and for GLO12 runs published before 2026-09-24. Their
tile grids are **not** anchored on the 10° boundaries:

| Layer | Tile N40W010 header | Consequence |
|---|---|---|
| `weather`, `weather-ecmwf`, `waves` (0.25°) | lat0 40.0, lon0 −10.0, d 0.25 | exact; native index = lattice index − n·tile row |
| `currents` (GLO12), runs from 2026-09-24 | lat0 40.0, lon0 −10.0, d 1/12; `resolution_deg` 1/12 | exact, like the 0.25° layers |
| `currents` (GLO12), runs up to `currents-20260923T00Z` | lat0 40.00366, lon0 −9.92705, dlat 0.08333588, dlon 0.0833282; `resolution_deg` 0.08333587646484375 | the ingest took the step from two float32 coordinates, so headers drift (0.011° of longitude at 2°W). The true 10° column (−10.0) is the **last column of N40W020**, and N40W010 starts at the true −9.9167. |
| `currents-ibi` (2026-09-23 run) | lat0 40.02689, lon0 −9.99923, d 0.02777863 | the provider's own 0.02777863° lattice sits just below each 1/36° row here: lattice 40.0° is the **last row of N30W010** |

Rounding the header position recovers the true lattice point in every case
(offsets stay below 0.3 of a step). A fixed "tile index = lattice index − n·row"
mapping would shift every value of an older GLO12 run one column (≈ 6 km) west
and every IBI value one row. When `|resolution_deg·n − 10| ≥ 1e-6` (the layer
is not aligned: IBI and the older GLO12 runs), the plan also reads the
neighbouring tile across a 10° line that the lattice edge sits exactly on.

## Times

- Per dataset, all exported variables share one tile axis (`hourly` for GFS
  wind and gust, `steps` otherwise). Axis times = `base + offsets_h`.
- Optional thinning step `s ∈ {all, 3, 6}` h keeps offsets with `offset % s = 0`.
- Then keep the steps inside `[start, end]`, plus the step before `start`
  when `start` falls between two steps, and the step after `end` when `end`
  falls between two steps, so apps can interpolate across the whole window.
  A step equal to `start` or `end` needs no neighbour. Clipped to the axis.
- A window entirely before or after the axis is `outside-horizon`.
- `forecastTime` = whole hours from the layer's cycle, which is also the
  section-1 reference time.
- Message order: step-major, then variables in registry order.

## Dataset registry

`engine/src/export/gribDatasets.ts`. Keys mirror NCEP's own GFS / GFS-Wave
messages (centre 7, subCentre 0, tablesVersion 2, productionStatus 0,
typeOfGeneratingProcess 2, shapeOfTheEarth 6, scanningMode 0, hours).

| Dataset id | Layer | Tile variable → GRIB (discipline/category/number) | Level (type/value) | Output unit | D | centre / process |
|---|---|---|---|---|---|---|
| `wind-gfs` | `weather` | `wind_u_kt` → 0/2/2 UGRD · `wind_v_kt` → 0/2/3 VGRD | 103/10 | m/s (kt ÷ 1.943844) | 1 | 7 / 96 |
|  |  | `gust_kt` → 0/2/22 GUST | 1/0 | m/s | 1 |  |
| `wind-ecmwf` | `weather-ecmwf` | as `wind-gfs`; gust **only if the manifest lists it** | as above | m/s | 1 | 98 / 255 |
| `waves-gfs` | `waves` | `hs_m` 10/0/3 HTSGW · `period_s` 10/0/11 PERPW · `dir_deg` 10/0/10 DIRPW · `wind_wave_h_m` 10/0/5 WVHGT · `wind_wave_period_s` 10/0/6 WVPER · `wind_wave_dir_deg` 10/0/4 WVDIR | 1/1 | m, s, ° true | 2 (heights), 1 (periods, directions) | 7 / 11 |
|  |  | `swell_h_m` 10/0/8 SWELL · `swell_period_s` 10/0/9 SWPER · `swell_dir_deg` 10/0/7 SWDIR | 241/1 |  | 2 / 1 / 1 |  |
| `currents-global` | `currents` | `cur_u_kt` → 10/1/2 UOGRD · `cur_v_kt` → 10/1/3 VOGRD | 1/0 (fallback 160/0) | m/s | 2 | 255 / 255 |
| `currents-ibi` | `currents-ibi` | same as `currents-global` | same | m/s | 2 | 255 / 255 |

- The knot constant is the pipeline's `MS_TO_KT = 1.943844`
  (`forecast-tiles/src/ingest/sources/base.py`). Wave directions pass through
  unchanged (degrees true, the direction waves come from, as NCEP writes them).
- D keeps the output precision no coarser than the tile or the NCEP original.
  Measured against NOAA's own 2026-09-23 00Z f024 messages for five Channel
  points: wind within 0.03 m/s (target 0.1), Hs identical (target 0.01).
- The registry also holds each dataset's UI label, attribution, whether it has
  land (a bitmap, counted in size estimates), and estimated bits per value
  (wind 10, gust 10, heights 11, periods 9, directions 12, currents 10).
- Reader names: ecCodes calls the wind and wave messages `10u`, `10v`,
  `gust`, `swh`, `perpw`, `dirpw`, `shww` and so on, but shows the currents as
  `unknown`. Its only GRIB2 surface-current concepts (`ocu`/`ocv`) are
  time-averaged fields (template 4.8) at level 160, so no instantaneous
  10/1/2 message gets a name. Readers using NCEP tables (wgrib2, g2clib) name
  them UOGRD/VOGRD. Adrena's recognition is item 8 of the tester checklist.

## Plan and availability

`planGribExport(manifests, request)`: the request is `bbox` (margin applied),
`datasetIds`, `startIso`, `endIso`, `step`, `lonConvention`, optional
`checkpoints: [{lat, lon}]` and `fixture`. Per dataset it returns:

- `availability`: `ok`, `no-layer` (no pinned manifest or no exportable
  variable), `no-tiles` (nothing published in the area, e.g. IBI outside its
  domain) or `outside-horizon`.
- the lattice, the selected steps, the tiles (published ones in manifest
  order, then unpublished ones, which stay missing), the message count,
- `estBytes` = messages × (179 bytes of sections + bitmap if the dataset has
  land + ⌈points·estBits/8⌉), and `downloadBytesUpperBound` = the manifest
  bytes of the published tiles (a cold-cache fetch).

## Files, summary and honesty rules

- File name: `passage_<datasetId>_<YYYYMMDDTHHZ cycle>_<SW corner>_<NE corner>.grb2`,
  with whole-degree corners (floor of SW, ceil of NE), for example
  `passage_wind-gfs_20260923T00Z_N48W006_N51E002.grb2`. When the tiles aren't
  live (`fixture: true`: the dev fixture or the CLI `--tiles-dir`), the prefix
  is `passage-fixture_` and the UI shows the emulated badge.
- `runGribExport` returns one entry per dataset with availability `ok`:
  `name`, the message `parts`, total `bytes`, `fnv64` (FNV-1a 64 of the whole
  file), `messages`, `skippedMessages`, `run_id`, `cycle`, `model`, `times`,
  `grid` (Ni, Nj, corners in exact degrees, step, longitude convention),
  `coverage` (present fraction over all messages) and `checkpoints`.
- `checkpoints`: for each requested point, the lattice point nearest to it
  (clamped into the box) for the first three steps, computed from the
  **rounded values actually written**. Wind: `wind_kt` (0.1) and
  `wind_from_deg`; gust: `gust_kt`; waves: the written values by tile variable
  name; currents: `current_kt` (0.01) and `current_set_deg` (the direction it
  flows towards).
- Currents copy must never suggest tidal streams:
  - **Global:** "6-hourly ocean-model currents. Tides are not resolved; do not
    use as tidal streams."
  - **IBI:** "Hourly regional model currents including tide. Not an official
    tidal-stream prediction."
- Always shown: "Forecast data for planning, not for navigation. Check
  official forecasts and warnings." (`GRIB_EXPORT_NOTICE`), plus the
  attribution lines for the ticked datasets: NOAA/NCEP; ECMWF open data,
  CC BY 4.0; "Generated using E.U. Copernicus Marine Service Information".

## Runner (bounded memory)

```
for each dataset with availability ok (one file at a time):
  cubes[var] = Float32Array(nSteps · Nj · Ni).fill(NaN)
  for each published tile (manifest order):
    tile = await source.tile(layer, tileId)      // null → stays missing
    check tile.header.run_id = plan run id
    forward-map its points and copy the selected steps of each variable
    drop the tile; tick progress; yield
  for step, for variable: convert units, encode, push the part (or count a skip)
  compute coverage, checkpoints, fnv64
```

- At most one decoded tile is alive at a time. `readTile(..., {retain: false})`
  shares the store's checksum validation, IndexedDB/memory cache and in-flight
  loads, but never enters or reorders the decoded LRU, so an export cannot
  evict the analysis's tiles. A decoded IBI tile is about 76 MB of Float32.
- The runner yields after every tile and every 12 ms while encoding, checks
  the `AbortSignal` before every tile and message, and reports
  `{datasetId, stage, done, total}` with one unit per tile and per message.
- A tile fetch answering HTTP 404 (the run was rotated while the page stayed
  open) or a tile from a different run id raises `GribExportError` with code
  `forecast-updated` and the message "The forecast has been updated. Reload
  the page and try again." Other errors propagate unchanged.

## Planner (viewer)

`viewer/src/pages/planner/GribExport.jsx` (the section) and
`viewer/src/lib/gribExport.js` (defaults, plan, run, Save links). The
**Download GRIBs…** button in the Passage panel is enabled once there is a
route (two drawn waypoints, a computed route, or two endpoints); it opens the
section below the planner grid and scrolls to it. While the section is open
the map draws the export box as a dashed rectangle.

| Setting | Default |
|---|---|
| Area | the route's points (draw: the waypoints; compute: the computed route, else the two endpoints) ± the margin, clamped to ±90° / ±180° |
| Margin | 1.0°; a select from 0 to 5° in 0.5° steps |
| Window | from max(departure, now), floored to the hour, to that + ETA + 24 h (rounded up to the hour). ETA = `distance / speeds.slow` in draw mode, `computed.duration_h` in compute mode, else 48 h. Each dataset is clipped to its own horizon by the plan. |
| Step | `all` (every step on the dataset's axis); 3 h and 6 h thin it |
| Datasets | GFS wind ticked; the sailor ticks the others. Unavailable ones are disabled with the reason. |
| Longitudes | `0-360` (see the override below) |
| Spot values | the route's first and last points |

- The plan uses `forecastStore()`, the same pinned runs as the analysis, and
  is recomputed synchronously whenever an input changes. Tiles are read with
  `readTile(..., {retain: false})`, so the analysis's decoded tiles stay put.
- Per dataset the section shows availability (`no-layer`: "Not in the current
  forecast runs."; `no-tiles`: "No data for this area."; `outside-horizon`:
  "Your dates are beyond this forecast's range."), the UTC time range, the
  step count and `estBytes`. It adds a partial-coverage note when a regional
  dataset (IBI) has unpublished tiles in the box, a horizon note when the last
  step ends before the window, and each currents dataset's disclosure.
- **Prepare files** runs `runGribExport` on the main thread with a progress
  bar and becomes **Cancel**. Each file gets a **Save** link (a Blob URL with
  the `download` attribute) and a collapsed **File details** block: model,
  run id, base time, grid, area, longitude convention, messages, share of
  points with data, the file's `fnv64`, the UTC times and the spot values.
  Run ids, model ids, file names and hashes sit in `<code>` so the French DOM
  translator leaves them alone.
- Blob URLs are revoked when files are prepared again, when any input changes
  (route, departure, margin, step, datasets, longitude convention, or the
  hour of "now") and when the section unmounts. A change during a run aborts
  it silently; **Cancel** reports "Cancelled. No files were prepared."
- Until Phase 3's size guardrails, **Prepare files** is disabled when the
  ticked datasets' estimates add up to more than 200 MB, with a suggestion
  (coarser step, smaller margin, fewer datasets). Every cube is held in memory.
- Analytics: `track('grib_export', { datasets: 'wind-gfs,waves-gfs', size_bucket: '1-5MB' })`
  after a successful export. Buckets: `0-1MB`, `1-5MB`, `5-20MB`, `20-50MB`,
  `50MB+`. Never coordinates.
- Dev (`viewer-demo`, or any build whose `FORECAST_BASE_URL` is not an
  `https://` URL) reads the local warehouse, so files are named
  `passage-fixture_…` and the section shows the emulated stamp. The demo
  fixture has no forecast runs, so it shows "The forecast runs are
  unavailable…".

### Longitude override (Adrena test)

`#plan/planner?gribLon=signed` switches the files to signed longitudes
(−180…180); `#plan/planner?gribLon=0-360` switches back. The choice is kept
in `localStorage` under `deepweather.gribLonConvention` (reads and writes in
try/catch), because in-app navigation drops the hash query. While `signed` is
active the section says so. It changes one encoding detail and hides nothing.
Phase 3 removes the override or makes the chosen value the default.

## CLI

```bash
npm run cli -w engine -- grib --bbox 48,51,-6,2 \
  --datasets wind-gfs,wind-ecmwf,waves-gfs,currents-global,currents-ibi \
  --from 2026-09-23T22:00Z --to 2026-09-25T22:00Z [--step all|3|6] [--out output/grib] \
  [--base-url https://forecast.deepregatta.com | --tiles-dir <local run dir>] \
  [--lon-convention 0-360|signed] [--check "49.65,-1.62;50.77,-1.3"]
```

`--bbox` is `minLat,maxLat,minLon,maxLon` with the margin already applied.
`--datasets` defaults to all five. Without `--tiles-dir`, the CLI reads
`--base-url`, then `DEEPWEATHER_FORECAST_BASE_URL`, then production. It writes
the non-empty `.grb2` files and `summary.json` (plan per dataset, attribution,
notice and the runner summary without the bytes) to `--out`, by default
`output/grib/` at the repository root.

Production run on 2026-09-23 at about 22:50 UTC (cold cache, Channel box, all
five datasets, next 48 h): 6.8 s and 339 MB peak RSS in Node. Files: GFS wind 82 kB (147 messages),
ECMWF 20 kB (36), waves 71 kB (162), GLO12 43 kB (20), IBI 2.2 MB (98,
289×109 points). The planner estimates were 0.11, 0.03, 0.13, 0.10 and 4.26 MB,
and at most 33 MB of tiles to fetch (IBI 20 MB of it).

## Verification

| Check | Where |
|---|---|
| Encoder: section lengths, sign-magnitude, bit order, constant and all-missing fields | `engine/test/grib2.test.ts` |
| Plan and runner: windows, availability, sizes, mosaic with an unpublished tile, Greenwich, CMEMS offsets, abort, 404, checkpoints | `engine/test/exportGrib.test.ts` |
| `readTile` / `manifestFor`: no LRU effect, shared in-flight load, unpublished tile | `engine/test/tileStore.test.ts` |
| CLI output = in-process engine output | `engine/test/cliGrib.test.ts` |
| Planner defaults, availability notes, Save links and their revocation, cancel, rotated runs, `gribLon`, French identifiers | `viewer/test/gribExport.test.jsx` |
| French copy for the section, the registry labels and the generated text | `viewer/test/i18n.test.js`, `viewer/test/i18nCoverage.test.js` |
| Golden files re-encode byte-for-byte | `engine/test/exportGrib.test.ts` against `engine/test/fixtures/grib/` |
| ecCodes decodes every golden file: keys, geometry, values, missing points | `analysis/tests/test_grib_export_contract.py` |
| Manual inspection | `cd analysis && uv run python scripts/inspect_grib.py <file> [--point lat,lon]` |

Golden fixtures (regenerate with `npm run make:grib-fixtures -w engine` after
an intentional encoder or registry change, review the diff, then re-run the
contract test):

| Fixture | Covers |
|---|---|
| `wind-gfs-golden` | GFS wind + gust from the shared golden PFT1 tile: 8×8 points, 4 hourly steps, one missing point |
| `waves-greenwich` | GFS-Wave from two tiles across 0° (0–360 wrap), land bitmap, swell level 241, constant fields, one all-missing message skipped |
| `currents-glo12` | 1/12° lattice (µ° step 83333), negative components, land bitmap, D = 2 |
| `wind-south` | southern hemisphere with the signed convention: negative latitudes and longitudes |

Each `<name>.expected.json` lists, per message, the ecCodes keys and about six
points (corners, centre, a missing point when there is one) with the source
tile value in output units, the value a reader must decode, and the tolerance
`0.5·10^-D` + half the tile quantum. The expected values come from the tiles
through the aligned index mapping, independently of the runner.
