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
| `weather-ecmwf` | ECMWF open IFS | 0.25° | wind_u_kt, wind_v_kt (0.01), gust if available (0.1) | 3 h→144 h + 6 h→240 h (65 steps) |
| `ensemble` | GEFS, 31 members | 0.5° | wind_kt_mean (i16 0.01) + wind_kt_anom (i8 0.2, per_member, clamped ±25 kt); same pair for gust | 3 h→144 h + 6 h→384 h (89 steps) |
| `waves` | GFS-Wave | 0.25° | hs_m, wind_wave_h_m, swell_h_m (0.01); period/direction ×3 (0.1) | 3 h→384 h (129 steps) |
| `currents` | CMEMS GLO12 (RTOFS fallback) | 1/12° | cur_u_kt, cur_v_kt (0.01) | 6 h→240 h (41 steps) |

Ensemble member values reconstruct as `mean + anomaly` per member. Ensemble
and currents axes reflect the Phase 0 size measurement (see the pipeline
repo's `docs/phase0-results.md`): full generation ≈ 3.26 GB gz, ×2 retention
6.53 GB against the 8 GB storage guard.

These currents are **not tidal stream predictions**; the UI must disclose
that, and tile time axes coarser than the tidal cycle must never be presented
as resolving tides.

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
`{run_id, previous_run_id, cycle, member_count, published_at}`.

## Publish protocol (atomic)

1. Download the latest **complete** provider cycle (`.idx` presence check;
   fall back one cycle rather than publish a partial run).
2. Validate the cube: step coverage, physical ranges, gust ≥ wind at ≥99 % of
   points, land/missing fraction vs previous run.
3. Storage guard: retained + new ≤ 8 GB or fail loudly **before** uploading.
4. Upload all tiles under the new immutable `run_id`.
5. Upload `manifest.json` last; re-download it plus 3 random tiles and decode.
6. Update `latest.json` (previous run recorded as `previous_run_id`).
7. Delete runs older than the previous one for this layer.

Clients must treat a `run_id` as immutable and may cache its tiles forever
(IndexedDB, evicted by run id).

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
