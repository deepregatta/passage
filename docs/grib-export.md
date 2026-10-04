# GRIB2 export

Canonical specification of the route-area GRIB2 files Passage writes from
its PFT1 forecast tiles ([tile format](forecast-tile-format.md)). The phased
delivery plan is [grib-export-plan.md](grib-export-plan.md); this file is the
contract and wins where the two differ.

Status: the engine, the CLI and the contract tests landed in Phase 1. Since
Phase 2 (2026-09-24) GRIB downloads are live in production for everyone, in
English and French. Adrena accepted the wind and currents files on
2026-09-27, including a box across 0°. On 2026-09-28 the planner section
became its own **GRIB files** page (Plan → GRIB files, `#plan/grib`). Also
on 2026-09-28 the ECMWF ingest was fixed to publish gusts from its next
scheduled run on, and ECMWF wind files carry them as ECMWF's own maximum over
the 1, 3 or 6 h before each step, written with template 4.8
([Gusts over a window](#gusts-over-a-window-template-48)).

The crawlable entries are `/grib` and `/fr/grib`; each build emits its own EN/FR
HTML title, description, social metadata, canonical and reciprocal hreflang,
and includes both entries in the sitemap. The campaign's `/#plan/grib` and
`/fr/#plan/grib` links remain supported. Put UTM parameters before the fragment;
an optional `?area=S,N,W,E` belongs in the fragment on hash links, or in the
ordinary query on the crawlable entries. The URL's box wins over a saved box.
The build emits `grib.html` and `fr/grib.html` so these slashless URLs serve 200
directly on Cloudflare Pages. Slashed forms redirect to them with the complete
query intact. A valid `?lang=en` or `?lang=fr` selects the language for that visit
ahead of the path, stored preference and browser language, without saving a new
preference. The language switcher saves the choice and updates any existing
`lang` query. Language switching and area edits preserve the attribution query.

After a non-empty file is prepared and handed to the browser download, the
next-step panel opens Plan with the chart fitted to that box, preserving any
existing planner draft. Replay links appear only where the box intersects a
static OSCAR course: `fastnet2025`, `rmsr2025`, or `arc2018` (public catalogue
and course metadata checked 2026-10-04). These links open in a new tab, use `tab=map`, carry the
selected language and the session attribution tuple, and exclude the box.
`grib_next_step` records only a `target` (`plan` or the selected race ID), plus
the shared event-contract-2 attribution context. It never records coordinates.
The existing `grib_export` fields, models and disclosures are unchanged.

The browser CI job runs the built-app regressions after the fixture suite.
Locally, run `npm run build:pages` then `npm run test:e2e:build -w viewer --
--workers=1`. This uses the `static-dist` launch configuration with intercepted
test tiles and collector requests; live availability and stored-event receipts
require separate production verification. `PASSAGE_E2E_PORT` selects a free
port for either configured server when the default is in use.
For an explicitly authorized live QA, `PASSAGE_E2E_MODE=live npm run test:e2e -w
viewer -- --workers=1 --project=desktop` visits the deployed app and real forecast
host and sends QA events to the live collector under verification label
`passage-grib-20261004`; it does not intercept those services.

## Overview

The export runs in the browser, from the same pinned tile runs Passage uses
for its briefings. There is no server and no `forecast-tiles` change. The same
engine code runs in the Node CLI, so every file the browser writes can be
reproduced and checked with ecCodes.

```
request (bbox, datasets, window, step)
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
| 4 Product (template 4.8, a statistic) | 58 | as 4.0 with template 8 and forecastTime = the **start** of the window, then: end of the overall time interval (year u16, month, day, hour, minute, second = cycle + step), numberOfTimeRanges 1, numberOfMissing 0 (u32), typeOfStatisticalProcessing (2 = maximum), typeOfTimeIncrement 2, unitForTimeRange 1 (hour), lengthOfTimeRange (u32 hours), unitForTimeIncrement 255, timeIncrement 0 (u32) |
| 5 Data representation (template 5.0) | 21 | length, 5, numberOfValues = present count (u32), template 0 (u16), R (IEEE float32), E = 0 (s16), D (s16), bitsPerValue, typeOfOriginalFieldValues 0 |
| 6 Bitmap | 6 or 6+⌈N/8⌉ | length, 6, indicator 255 (no missing values) or 0 followed by the bitmap: MSB first, 1 = value present, zero-padded |
| 7 Data | 5+⌈count·nbits/8⌉ | length, 7, packed values: MSB first, zero-padded |
| 8 End | 4 | `"7777"` |

Flags 0x30: both increments given; u/v components are relative to east/north
(earth-relative, as NCEP writes them).

### Gusts over a window (template 4.8)

GFS's `GUST` is an instantaneous value at the step, so it is written like
NCEP's own message: template 4.0 at the surface (1/0), which ecCodes calls
`gust`. ECMWF's 10 m gust is not: it is the **maximum over the hours before
the step**, and ECMWF's open-data files name it by that window. Read from the
`.index` files of the 2026-09-28T00Z run:

| Steps | ECMWF name | GRIB `stepRange` | Window |
|---|---|---|---|
| 0 | `10fg` | `0` | none (a constant zero field; not exported) |
| +3 … +90 h | `10fg` ("since the previous post-processing", hourly to +90 h) | `2-3` … `89-90` | 1 h |
| +93 … +144 h | `10fg3` | `90-93` … `141-144` | 3 h |
| +150 … +240 h | `10fg` | `144-150` … `234-240` | 6 h |

forecast-tiles publishes each step's window in the manifest (`statistic`,
[tile format](forecast-tile-format.md#json-header)), and the ECMWF gust is
written with **template 4.8**: typeOfStatisticalProcessing 2 (maximum),
lengthOfTimeRange = that step's window, forecastTime = step − window, at
10 m above ground (103/10). That is ECMWF's own encoding, so ecCodes reads
these messages as ECMWF's files: `10fg` (1 h and 6 h windows) or `10fg3`,
step type `max`, `stepRange` `start-end`, valid at the end of the window.
The remaining differences are ours: generatingProcessIdentifier 255 (ECMWF:
161), backgroundProcess 0 (255), and time increment 255/0, as NCEP writes
its template-4.8 precipitation (ECMWF gives the model time step, 450 s,
which the tiles don't carry).

Template 4.0 was rejected: at 10 m it reads as `i10fg`, an **instantaneous**
gust, which this value is not. A maximum over 1–6 h runs systematically higher
than an instant gust, and the window changes along the run, which only 4.8
can state message by message. GRIB readers already meet 4.8 in NOAA files
(GFS precipitation `APCP`); whether Adrena shows this gust is item 6 of the
tester checklist ([plan](grib-export-plan.md#adrena-test-end-of-phase-2)).

The registry declares which variables are statistics (`statistic: 'max'`),
and the plan only exports such a variable when the run's manifest declares
the same statistic with one window per axis step (and an instantaneous one
only when the manifest declares none). Every weather-ecmwf run up to
`weather-ecmwf-20260928T00Z` is wind-only, so its files have no gust.

Checked on 2026-09-28, before any gust run was published: a dry-run ingest
of the 20260928T12Z cycle, exported with the CLI for the Channel (49–51°N,
6°W–2°E, +12 … +138 h, 43 times) next to production GFS 20260928T00Z at the
same valid times. ecCodes read the ECMWF gusts as 27 `10fg` (1 h) and 16
`10fg3` (3 h) messages. Box-mean gust was 14.9 kt against GFS's 13.9 kt, and
the box means correlated at 0.92 over time. Gust ÷ wind averaged 1.72 against 1.33,
the gap coming from light winds and the 3 h windows. Every ECMWF gust was
at least the wind speed − 2 kt.

In production since `weather-ecmwf-20260929T00Z`, the first gust run (published
by the scheduled ingest on 2026-09-29, 255.0 MB against 182 MB wind-only). A CLI
export of the same Channel box from production, against GFS from the same
cycle (`weather-20260929T00Z`), covered 60 shared times from +15 to +240 h.
ecCodes read 26 `10fg` (1 h), 18 `10fg3` (3 h) and 16 `10fg` (6 h) messages,
and every ECMWF gust was at least the wind speed − 2 kt.

| ECMWF window | Times | ECMWF wind / gust (box mean, kt) | GFS wind / gust | Gust ÷ wind, ECMWF / GFS |
|---|---|---|---|---|
| 1 h | +15 … +90 h (26) | 11.4 / 16.9 | 11.2 / 15.7 | 1.60 / 1.39 |
| 3 h | +93 … +144 h (18) | 5.5 / 9.5 | 4.2 / 4.6 | 1.93 / 1.05 |
| 6 h | +150 … +240 h (16) | 8.2 / 14.3 | 11.4 / 14.5 | 2.08 / 1.29 |

With the wind nearly equal (1 h stretch), ECMWF's gust ran about 1 kt above
GFS's instantaneous one. The longer windows widen the gap, most in light winds.

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
  section-1 reference time. For a statistic (template 4.8) it is the start
  of the window, and the end of the overall time interval is the step's time.
- Message order: step-major, then variables in registry order.

## Dataset registry

`engine/src/export/gribDatasets.ts`. Keys mirror NCEP's own GFS / GFS-Wave
messages (centre 7, subCentre 0, tablesVersion 2, productionStatus 0,
typeOfGeneratingProcess 2, shapeOfTheEarth 6, scanningMode 0, hours).

| Dataset id | Layer | Tile variable → GRIB (discipline/category/number) | Level (type/value) | Output unit | D | centre / process |
|---|---|---|---|---|---|---|
| `wind-gfs` | `weather` | `wind_u_kt` → 0/2/2 UGRD · `wind_v_kt` → 0/2/3 VGRD | 103/10 | m/s (kt ÷ 1.943844) | 1 | 7 / 96 |
|  |  | `gust_kt` → 0/2/22 GUST | 1/0 | m/s | 1 |  |
| `wind-ecmwf` | `weather-ecmwf` or `weather-ecmwf-short` (one run per file, see below) | `wind_u_kt`, `wind_v_kt` as `wind-gfs` | 103/10 | m/s | 1 | 98 / 255 |
|  |  | `gust_kt` → 0/2/22, **maximum over the step's window** (template 4.8), only if the manifest lists it with its `statistic` | 103/10 | m/s | 1 |  |
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
  `gust` (GFS), `10fg` / `10fg3` (ECMWF), `swh`, `perpw`, `dirpw`, `shww` and so on, but shows the currents as
  `unknown`. Its only GRIB2 surface-current concepts (`ocu`/`ocv`) are
  time-averaged fields (template 4.8) at level 160, so no instantaneous
  10/1/2 message gets a name. Readers using NCEP tables (wgrib2, g2clib) name
  them UOGRD/VOGRD. Adrena's recognition is item 8 of the tester checklist.

## Plan and availability

`planGribExport(manifests, request)`: the request is `bbox` (margin applied),
`datasetIds`, `startIso`, `endIso`, `step`, `lonConvention`, optional
`checkpoints: [{lat, lon}]`, `fixture` and `extent: 'window' | 'full'`.
The default window preserves existing callers; full keeps the requested start
and uses each dataset's last available time as its end.

Every message of a file has the same reference time, so a file is read from
one run. For ECMWF wind that run is chosen per request (`gribRunFor`, from
Phase 5C of the plan): the newest of `weather-ecmwf` (00Z/12Z, to 240 h) and
`weather-ecmwf-short` (06Z/18Z, to 144 h) whose axis covers the whole window,
else the 240 h run, clipped to its horizon like any dataset. In practice the
next 2, 3 or 5 days come from the 06Z/18Z run for the six hours or so after
it goes live, and the next 7 days or the full forecast from the 00Z/12Z one.
The plan's `layer`, `run_id`, `cycle` and file name follow the chosen run.

Per dataset it returns:

- `availability`: `ok`, `no-layer` (no pinned manifest or no exportable
  variable), `no-tiles` (nothing published in the area, e.g. IBI outside its
  domain) or `outside-horizon`.
- the lattice, the selected steps, the tiles (published ones in manifest
  order, then unpublished ones, which stay missing), the message count,
- `windowsH`: per exported variable, null when instantaneous, else the window
  in hours ending at each selected step, from the manifest (null at a step
  with no value, such as ECMWF's step 0),
- `estBytes` = messages × (179 bytes of sections + bitmap if the dataset has
  land + ⌈points·estBits/8⌉), plus 24 bytes per template-4.8 message, and
  `downloadBytesUpperBound` = the manifest bytes of the published tiles (a
  cold-cache fetch).

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
  `coverage` (present fraction over all messages), `statistics` (for each
  variable written with template 4.8: `{kind, window_h}` aligned with
  `times`) and `checkpoints`. A statistic step without a window (ECMWF's step
  0) is skipped and counted, never written as an instantaneous value.
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
  evict the analysis's tiles. A decoded IBI tile is about 125 MB of Float32
  (360 × 360 points × 121 steps × 2; 76 MB for the 73-step runs before
  2026-09-29).
- The runner yields after every tile and every 12 ms while encoding, checks
  the `AbortSignal` before every tile and message, and reports
  `{datasetId, stage, done, total}` with one unit per tile and per message.
- A tile fetch answering HTTP 404 (the run was rotated while the page stayed
  open) or a tile from a different run id raises `GribExportError` with code
  `forecast-updated` and the message "The forecast has been updated. Try
  again." Other errors propagate unchanged. The page refreshes the pinned
  runs before each file when they were last checked over 10 minutes ago, and
  after a `forecast-updated` error it refreshes once and prepares the file
  again from the new run; the message shows only when that fails too
  (`forecast-tile-format.md` → *Runs change under an open page*). A file's
  key includes the run ids, so a file prepared from a replaced run is never
  offered again.

## GRIB files page (viewer)

`viewer/src/pages/Grib.jsx` (the page), `viewer/src/pages/grib/GribMap.jsx`
(the chart and the box), `viewer/src/stores/gribStore.js` (remembered
choices) and `viewer/src/lib/gribExport.js` (area, period, model choice, plan,
run, downloads). It is the **GRIB files** tab of the Plan stage
(`#plan/grib`). It was redesigned on 2026-09-28 after the first Adrena test,
because a sailor could not find the download on his own: it needed a route
first, the button was third in the Passage panel, and it took three verbs
(Download → Prepare → Save) and about eight choices.

The page is three numbered steps next to the chart:

1. **Area.** **Draw a box** (on the chart) enters draw mode: press and drag
   across the chart, or click two opposite corners. Panning pauses while
   drawing; Escape or **Cancel** leaves. The box snaps outward to 0.1°, is at
   least 0.25° on each side, and is clamped (never wrapped) to ±90° / ±180°,
   so it cannot cross the 180° meridian. Once a box exists the **Draw a box**
   button goes away and the four corner handles resize it (drag one; the
   opposite corner stays put). The handles' positions are memoised per box:
   react-leaflet moves a marker whenever its `position` prop is a new array,
   so re-rendering during a drag would snap the handle back.
2. **Period.** Next 1, 2, 3 (default), 5 or 7 days, or **Full forecast**, from
   now floored to the hour. Full uses `extent: 'full'` in the export request:
   each file runs to its own model's last available forecast step, including
   AROME, ICON-EU and UKV. The longest pinned forecast supplies the planning
   envelope (`gribForecastEnd`), rather than a required end for every model.
   Model horizons differ (IBI +120 h from the runs published on 2026-09-29, +72 h
   before; GFS wind +240 h, GFS-Wave +384 h).
   Fixed-day periods retain the regional wind models' whole-window coverage
   requirement. The page shows each file's actual start/end times and, for
   Full forecast, explains that the end depends on the selected model.
3. **Download.** One button per kind (**Download wind**, **Download
   currents**, **Download waves**). One click builds that file and starts
   the browser download. Files stay separate, one per kind, so any GRIB
   software can open them.

| Setting | Default |
|---|---|
| Wind model | **ECMWF** when the box's centre is in Europe (25–72°N, 35°W–45°E), else GFS. The other model is the fallback when the first has no data here. |
| Currents model | **IBI** (regional, hourly, tide included) when it covers the whole box (no unpublished IBI tile in it), else global GLO12 |
| Waves model | GFS-Wave (the only one) |
| Step | `all` (every step on the dataset's axis); 3 h and 6 h thin it |
| Longitudes | `0-360`, validated in Adrena across 0° on 2026-09-27 |
| Spot values | the centre of the box |

The rule is **local model first**. Under each download button, a row of
model chips (name and grid spacing of the pinned run, e.g. `IBI 3.1 km`)
shows every model of that kind with a published run; the chosen one is
pressed and one click switches. Unavailable models stay visible but
disabled, with the reason as a tooltip. When a model's forecast ends before
the period (a regional wind model over Next 3 days), a **Shorter forecast**
line names it and offers the longest period it covers. A model the sailor
picks overrides the default wherever it is available. **More options** holds
only the time step.

- Sources of the area, in order: a `#plan/grib?area=S,N,W,E` link (adopted
  once, when the page opens), the remembered area, or none (the page asks for
  a box). The Passage panel's **Download GRIBs…** button is always enabled.
  With a route it hands over the route's box ± 1° (the waypoints; in compute
  mode the computed route, else the two endpoints), and the chart zooms to it.
  Without a route it just opens the page.
- The address follows the box (`history.replaceState`), so the page can
  always be bookmarked for a usual area. The area stays in the URL fragment,
  which the browser never sends to a server, and analytics never read it.
- `useGrib` persists the area, the period, the step and any chosen models in
  `localStorage` (`deepweather.grib`, zustand `persist`), validated on load.
- The plan uses `forecastStore()`, the same pinned runs as the analysis, and
  is recomputed synchronously whenever an input changes. Tiles are read with
  `readTile(..., {retain: false})`, so the analysis's decoded tiles stay put.
- Each kind shows its model's registry label, availability (`no-layer`: "Not
  in the current forecast runs."; `no-tiles`: "No data for this area.";
  `outside-horizon`: "Your dates are beyond this forecast's range."), the UTC
  time range, the step count and `estBytes`. It adds a partial-coverage note
  when a chosen regional model (IBI) has unpublished tiles in the box, a
  horizon note when the model ends before the period (not for Full forecast),
  and each currents model's disclosure. An ECMWF wind file with gusts adds
  "Gusts are the maximum over the 1, 3 or 6 h before each time, as ECMWF
  publishes them, not an instantaneous value like GFS gusts." (the windows
  in its planned steps).
- A download runs `runGribExport` for that one dataset on the main thread.
  The button becomes **Cancel** with a progress bar. One file builds at a
  time, and the other buttons wait. The finished file gets a Blob URL. A
  hidden `<a download>` is clicked to save it, and the kind shows **Saved**,
  the file name, its size, a **Save again** link (the same Blob URL, for
  browsers that block the programmatic save) and a collapsed **File
  details** block: model, the run (named as sailors do, "ECMWF 06Z", then
  its run id), base time, grid, area, messages, share of points with data,
  `fnv64`, the UTC times and the spot values. Clicking the
  button again re-saves the same file without rebuilding it. Run ids, model
  ids, file names and hashes sit in `<code>` so the French DOM translator
  leaves them alone.
- Blob URLs are revoked when a file is rebuilt, when anything it depends on
  changes (area, period, step, that kind's model, or the hour of "now") and
  when the page unmounts. A change during a run aborts it silently;
  **Cancel** reports "Cancelled. No file was saved."
- A file whose estimate is over 200 MB is blocked, with "Draw a smaller box or
  choose a shorter period." Every cube is held in memory.
- Analytics: `track('grib_export', { datasets: 'wind-ecmwf', window: '3d', size_bucket: '0-1MB' })`
  after each successful file (`window` is `2d`, `3d`, `5d`, `7d` or `full`).
  Buckets: `0-1MB`, `1-5MB`, `5-20MB`, `20-50MB`, `50MB+`. Never coordinates.
- Dev (`viewer-demo`, or any build whose `FORECAST_BASE_URL` is not an
  `https://` URL) reads the local warehouse, so files are named
  `passage-fixture_…` and the page shows the emulated stamp. The demo
  fixture has no forecast runs, so it shows "The forecast runs are
  unavailable…".
- The Phase 2 `gribLon` test override is gone (the 0–360 convention passed
  in Adrena). A leftover `deepweather.gribLonConvention` key in
  `localStorage` is ignored.

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
| Encoder: section lengths, sign-magnitude, bit order, constant and all-missing fields, template 4.8 | `engine/test/grib2.test.ts` |
| Plan and runner: windows, availability, sizes, mosaic with an unpublished tile, Greenwich, CMEMS offsets, abort, 404, checkpoints, ECMWF gust windows and the registry–manifest statistic agreement | `engine/test/exportGrib.test.ts` |
| `readTile` / `manifestFor`: no LRU effect, shared in-flight load, unpublished tile | `engine/test/tileStore.test.ts` |
| CLI output = in-process engine output | `engine/test/cliGrib.test.ts` |
| Page: box snapping, route area, bookmark links, periods, local-first models, one-click save and re-save, revocation, cancel, rotated runs, French identifiers | `viewer/test/gribExport.test.jsx` |
| Drawing the box on the real map (drag, two clicks, Escape), remembered area, entry points | `viewer/e2e/grib.spec.js` |
| French copy for the page, the registry labels and the generated text | `viewer/test/i18n.test.js`, `viewer/test/i18nCoverage.test.js` |
| Golden files re-encode byte-for-byte | `engine/test/exportGrib.test.ts` against `engine/test/fixtures/grib/` |
| ecCodes decodes every golden file: keys, geometry, values, missing points; the ECMWF gust reads as `10fg` / `10fg3`, `max`, valid at the window end | `analysis/tests/test_grib_export_contract.py` |
| Manual inspection | `cd analysis && uv run python scripts/inspect_grib.py <file> [--point lat,lon]` |

Golden fixtures (regenerate with `npm run make:grib-fixtures -w engine` after
an intentional encoder or registry change, review the diff, then re-run the
contract test):

| Fixture | Covers |
|---|---|
| `wind-gfs-golden` | GFS wind + gust from the shared golden PFT1 tile: 8×8 points, 4 hourly steps, one missing point |
| `waves-greenwich` | GFS-Wave from two tiles across 0° (0–360 wrap), land bitmap, swell level 241, constant fields, one all-missing message skipped |
| `currents-glo12` | 1/12° lattice (µ° step 83333), negative components, land bitmap, D = 2 |
| `wind-ecmwf-gust` | ECMWF wind + gust: template 4.8 with 1, 3 and 6 h windows at 10 m, step 0 skipped (no window) |
| `wind-south` | southern hemisphere with the signed convention: negative latitudes and longitudes |

Each `<name>.expected.json` lists, per message, the ecCodes keys and about six
points (corners, centre, a missing point when there is one) with the source
tile value in output units, the value a reader must decode, and the tolerance
`0.5·10^-D` + half the tile quantum. The expected values come from the tiles
through the aligned index mapping, independently of the runner.
