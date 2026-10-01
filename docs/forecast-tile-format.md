# PFT1 forecast tile format and publishing protocol

Canonical specification for the precomputed forecast tiles that replace
Open-Meteo in the production runtime. The ingestion pipeline lives in the
public [deepregatta/forecast-tiles](https://github.com/deepregatta/forecast-tiles)
repo; this document and the `contracts/forecast-*.schema.json` schemas are the
source of truth. The pipeline repo vendors copies plus the shared golden
fixtures — both the Python (`tilekit.codec`) and TypeScript
(`engine/src/forecast/tileCodec.ts`) codecs must decode the golden fixtures
identically.

## Binary layout (PFT1)

Little-endian throughout.

```
bytes 0-3    magic "PFT1"
bytes 4-7    u32 header_len (unpadded JSON byte length)
bytes 8-..   UTF-8 JSON header, zero-padded to a 4-byte boundary
then         payload: per-variable arrays in header order,
             each C-order [member?][time][lat][lon]
```

- Every payload array is zero-padded at its end to a 4-byte boundary so
  typed-array views stay aligned; `byte_length` excludes the padding and the
  next variable's `byte_offset` includes it.
- Decoded value = `raw * scale + offset` (float32); the per-dtype sentinel
  decodes to missing (NaN in Python, `null` in TypeScript).
- dtypes: `i16` (sentinel −32768) and `i8` (sentinel −128). Quantization
  clamps to `[min+1, max]` so the sentinel is reserved.
- Cross-language tolerance: decoded values may differ by ≤ 1e-3 between
  float32/float64 arithmetic paths; consumers must not compare exactly.

### JSON header

Validated by `contracts/forecast-tile.schema.json`:

```json
{
  "spec": "PFT1", "schema_version": 1,
  "layer": "weather", "model": "gfs_0p25", "run_id": "weather-20260713T06Z",
  "cycle": "2026-07-13T06:00Z", "generated_at": "2026-07-13T10:12:00Z",
  "tile_id": "N40W010", "lat0": 40.0, "lon0": -10.0,
  "dlat": 0.25, "dlon": 0.25, "nlat": 40, "nlon": 40,
  "time_axes": {
    "hourly": { "base": "2026-07-13T06:00Z", "offsets_h": [0, 1, 2] },
    "h3":     { "base": "2026-07-13T06:00Z", "offsets_h": [0, 3, 6] }
  },
  "member_count": 1,
  "variables": [
    { "name": "wind_u_kt", "axis": "hourly", "dtype": "i16", "scale": 0.01,
      "offset": 0, "missing": -32768, "byte_offset": 0, "byte_length": 153600 }
  ],
  "provenance": { "source_urls_digest": "…", "fetched_at": "…" }
}
```

Grid points sit at `lat0 + i*dlat`, `lon0 + j*dlon` (ascending latitude,
longitude in [−180, 180)). Point (i=0, j=0) is the SW corner.

A variable whose values are a statistic over the interval ending at each step,
rather than an instantaneous value, carries `statistic` in both the header and
the manifest (optional; absent = instantaneous):

```json
{ "name": "gust_kt", "axis": "steps", "dtype": "i16", "scale": 0.1,
  "statistic": { "kind": "max", "window_h": [null, 1, 1, "…", 3, "…", 6] } }
```

`window_h` has one entry per step of the variable's axis: the interval length
in hours, `null` where the step carries no value. Only ECMWF's gust uses it
today (the maximum over the last 1 h to +90 h, 3 h to +144 h, 6 h after; none
at step 0). The GRIB export writes such a variable with template 4.8
([GRIB export](grib-export.md#gusts-over-a-window-template-48)).

## Tiling

10°×10° tiles, half-open `[lat0, lat0+10) × [lon0, lon0+10)`, id =
`{N|S}{lat2}{E|W}{lon3}` of the SW corner (`N40W010` = lat [40, 50), lon
[−10, 0)). 18 × 36 = 648 tiles cover the globe; the single lat = 90 grid row
is dropped. Fully-missing (all-land) tiles are not published. Antimeridian:
route bounding boxes never cross ±180 (`routeBbox` rejects them), so tile
requests never wrap.

## Layers

| Layer | Model | Res | Variables (scale) | Time axes |
|---|---|---|---|---|
| `weather` | GFS | 0.25° | wind_u_kt, wind_v_kt (0.01); gust_kt (0.1) — hourly. visibility_m (50), cape_jkg (1), temp_c (0.1), dew_point_c (0.1), precip_mm (0.1) — h3 | hourly: 1 h→120 h + 3 h→240 h (161 steps); h3: 3 h→240 h (81 steps) |
| `weather-ecmwf` | ECMWF open IFS | 0.25° | wind_u_kt, wind_v_kt (0.01); gust_kt (0.1), the maximum over the 1, 3 or 6 h before each step (`statistic`), when every step has one; runs up to `weather-ecmwf-20260928T00Z` are wind-only | 3 h→144 h + 6 h→240 h (65 steps) |
| `ensemble` | GEFS, 31 members | 0.5° | wind_kt_mean (i16 0.01) + wind_kt_anom (i8 0.2, per_member, clamped ±25 kt); same pair for gust | 3 h→144 h + 6 h→384 h (89 steps) |
| `waves` | GFS-Wave | 0.25° | hs_m, wind_wave_h_m, swell_h_m (0.01); period/direction ×3 (0.1) | 3 h→384 h (129 steps) |
| `currents` | CMEMS GLO12 (RTOFS fallback) | 1/12° | cur_u_kt, cur_v_kt (0.01) | 6 h→240 h (41 steps) |
| `currents-ibi` | CMEMS IBI analysis-forecast, IBI domain only (26–56°N, 19°W–5°E) | ≈1/36° (0.02777863°) | cur_u_kt, cur_v_kt (0.01) | 1 h→120 h (121 steps) from the runs published on 2026-09-29; 1 h→72 h (73) before |

Ensemble member values reconstruct as `mean + anomaly` per member. Ensemble
and currents axes reflect the Phase 0 size measurement (see the pipeline
repo's `docs/phase0-results.md`): full generation ≈ 3.26 GB gz, ×2 retention
6.53 GB against the 8 GB storage guard.

These currents are **not tidal stream predictions**; the UI must disclose
that, and tile time axes coarser than the tidal cycle must never be presented
as resolving tides. `currents-ibi` is hourly model current including tide, so
it resolves the tidal cycle, and it is still not a tidal-stream prediction.
Its 120 h horizon keeps the next 3 days inside the served run at any moment:
forecast-tiles `docs/ibi-currents.md`.

Tiles slice the provider grid without resampling, and the header's `lat0`,
`lon0`, `dlat` and `dlon` describe that grid. The 0.25° and 0.5° layers sit
exactly on the 10° lines and their own lattice. So does GLO12 (`currents`) in
runs published from 2026-09-24: `dlat = dlon = 1/12`, N40W010 has lat0 40,
lon0 −10, and the manifest `resolution_deg` is 1/12 (0.08333333333333333).
Two geometries are not aligned (measured on N40W010):

- IBI (`currents-ibi`, 2026-09-23 run): lat0 40.02689, lon0 −9.99923,
  d 0.02777863. The provider's coordinates are their own regular 0.02777863°
  lattice, up to 0.0013° off the 1/36° lines. Tiles keep them, so the row
  nearest 40.0° (39.99912°) is the last row of the tile below.
- GLO12 runs published before 2026-09-24 (the last is `currents-20260923T00Z`):
  lat0 40.00366, lon0 −9.92705, dlat 0.08333588, dlon 0.0833282. The step
  came from two float32 coordinates, so header positions drift from the true
  1/12° grid (0.011° of longitude at 2°W, up to ≈ 0.02° at 180°E), and each
  true 10° boundary column is the last column of the western tile. Published
  runs are immutable, so a consumer holding one of these still sees this
  geometry.

Consumers that need lattice positions round the header position to the
nearest 1/12° or 1/36° rather than assume `lat0 = 10·row`; the GRIB export
does this ([grib-export.md](grib-export.md)).

Nearest-point sampling must look across tile edges. Within one cell of a 10°
line, the grid point nearest to a query can be in the neighbouring tile. On
aligned grids that is the neighbour's first row or column, the one on the line.
On the offset grids above it can be the southern or western tile's last row or
column. `TileForecastStore` samples the tile containing the point first. When
the rounded index there falls outside that tile's grid, it checks the
neighbour on that side, using the neighbour's own header geometry. If the
containing tile is unpublished, it checks each neighbour within one cell. This
also covers mosaic lattice points that float noise puts just below a line.

## R2 layout and caching

```
forecast-runs/{run_id}/manifest.json                     written LAST
forecast-runs/{run_id}/{layer}/z{res}/{tile_id}.bin.gz   Cache-Control: public, max-age=31536000, immutable
latest.json                                              Cache-Control: public, max-age=300, must-revalidate
status/{layer}.json                                      per-run metrics
```

`run_id = {layer}-{cycleCompact}` (e.g. `weather-20260713T06Z`) — runs are
per-layer so a currents outage never blocks wind updates. `z{res}` encodes
native resolution: `z025`, `z050`, `z008`. Tiles are gzip (level 9, mtime 0);
the browser decompresses with `DecompressionStream('gzip')` (brotli is not
available there).

`manifest.json` (`contracts/forecast-manifest.schema.json`): geometry, time
axes, variables, per-tile `{bytes, fnv64}`, totals, validation results.
`latest.json` (`contracts/forecast-latest.schema.json`): per-layer
`{run_id, previous_run_id, cycle, member_count, published_at, cadence_hours}`.
`cadence_hours` (optional, integer ≥ 1, from 2026-09-29) is the hours between
the layer's scheduled publications, from forecast-tiles' per-layer config.
Since 2026-10-01 the dispatcher publishes every provider cycle
(`grib-export-plan.md` Phase 5B): GFS, GFS-Wave and GEFS 6; ECMWF 12; both
current layers 24. It was 24 for every layer before, and each entry changes
at its layer's next publish. The briefing's next-update estimate uses it and
falls back to its own daily table (`PUBLICATION_SCHEDULE` in
`engine/src/briefing.ts`) when it is absent, as it is only in entries
published before 2026-09-29.

### Runs change under an open page

Retention keeps the current and previous run of each layer, so a run is
deleted one cycle after it is superseded (about 12 h once GFS publishes every
6 h). `TileForecastStore` pins one run per layer and never changes it during
a call. `refresh()` re-reads `latest.json`, loads the manifest of each layer
whose run changed and swaps them in together, dropping those layers' decoded
tiles; unchanged layers keep theirs, and a layer whose new manifest cannot be
read yet keeps its pinned run. A tile that answers 404 raises
`ForecastRunGoneError` (`status` 404, with the layer and run id), which the
analysis and the departure scan pass through rather than treating as missing
currents or a skipped candidate. The viewer (`viewer/src/lib/forecastFreshness.js`)
refreshes at the start of each action (check a passage, compare departures,
compute a route, prepare a GRIB file) when the last check is over 10 minutes
old and no other action is running; after a 404 it refreshes once and
retries the action when the run was replaced, otherwise it shows "The
forecast has been updated. Try again." Snapshots never re-read tiles: a
briefing, its evidence and the change story are read from the snapshot's own
files.

## Publish protocol (atomic)

1. Download the latest **complete** provider cycle (`.idx` presence check;
   fall back one cycle rather than publish a partial run).
2. Validate the cube: step coverage, physical ranges, gust ≥ wind at ≥99 % of
   points, land/missing fraction vs previous run, and a `statistic` window
   for every step that carries data.
3. Storage guard: retained + new ≤ 8 GB or fail loudly **before** uploading.
4. Upload all tiles under the new immutable `run_id`.
5. Upload `manifest.json` last; re-download it plus 3 random tiles and decode.
6. Update `latest.json` (previous run recorded as `previous_run_id`).
7. Delete runs older than the previous one for this layer.

Clients must treat a `run_id` as immutable and may cache its tiles forever
(IndexedDB, evicted by run id).

### Passage decoded-memory policy

`TileForecastStore` retains at most **64 MiB of decoded Float32 array bytes**
by default, shared across all layers. `maxDecodedBytes` can override that
budget with a non-negative safe integer; zero disables decoded retention.
The viewer singleton uses the default. Reads refresh recency, and loading a
tile evicts the least recently used entries until its arrays fit. Missing
tiles are checked against the manifest without retaining negative entries.

Tiles larger than the budget remain usable by current callers but are not
retained. Eviction drops references without mutating arrays; in-flight loads
remain shared and failures remain retryable. Later reads decode the stored
gzip bytes again, or fetch them if the compressed cache no longer has them.
Grid time-index memoization uses weak references so it does not retain
evicted tiles for the whole mosaic operation.

This is a retained-array budget, not a total browser-memory limit: tile
headers, compressed cache bytes, active fetch/decode work and consumer output
arrays are outside it. IndexedDB storage quotas remain a separate policy.

## Golden fixtures

Shared between both repos; regenerate only with the pipeline repo's
`scripts/make_golden_fixture.py` and update both copies plus the digests here.
`fnv64` is FNV-1a 64-bit over the **uncompressed** PFT1 bytes.

| Fixture | fnv64 |
|---|---|
| `golden-N40W010-weather.bin.gz` | `f81cd54ab70d458e` |
| `golden-N40W010-ensemble.bin.gz` | `a3f3e984096cac7f` |

Passage copies live in `engine/test/fixtures/tiles/`; pipeline copies in
`tests/fixtures/`. Each CI decodes its copy and compares against the committed
`*.expected.json` (values within 1e-3).
