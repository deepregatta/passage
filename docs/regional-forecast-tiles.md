# Optional AROME and ICON-EU forecast tiles

The consumer supports forecast-tiles' separate `latest-regional.json` alongside
required root `latest.json`. Production regionals remain disabled at the
producer. `VITE_REGIONAL_MODELS` is empty by default; an explicit comma-separated
`weather-arome,weather-icon-eu` allowlist enables only those named models.
Do not enable the production feature before the producer plan's browser,
capacity and canary gates pass.

Missing/failed regional discovery is harmless to root forecasts. Refresh
retires removed regional runs and evicts caches using both catalogues. GFS
remains the default point/routing/wind-grid source; ECMWF selection retains
its existing full/short run behavior. Named `getRegionalWindGrid()` requires
complete coverage and horizon and never substitutes global values. Ordinary
comparison adds only opted-in regionals with finite wind and complete temporal
coverage; unavailable hazard fields remain unavailable.

New runs declare 5° AROME / 10° ICON-EU tiles and explicit served geometry.
All lookup, neighbor probes, mosaics and exports use the manifest layout.
Regional transfer admission shares 20 MiB across models per analysis. Each
tile is limited to 8 MiB gzip and 32 MiB decoded Float32 arrays. Declared
inflated/decoded sizes are checked before allocations, decode is serialized,
and working-set admission adds transient buffers to retained regional arrays
under 128 MiB. The shared retained cache remains 64 MiB. Regional compressed
data use IndexedDB; the memory fallback does not accumulate another cache.

The GRIB selector offers AROME/ICON-EU only when their opted-in manifests exist.
Their export plans require full time and rectangular-domain coverage, retain
missing mask cells, use source attribution and one-hour maximum gust windows,
and cap compressed tile transfer at 50 MiB for an explicit download. Exports
are opt-in; default local/global model order is preserved. The evidence
inspector displays model-originator/Open-Meteo attribution. Unsupported regional
next-publication estimates are omitted because AROME delay depends on cycle.

## Reproduce the desktop scratch benchmark

Generate producer dry runs with verified gust, plus a clearly identified root
fixture or a representative live root workload, then run:

```sh
node scripts/serve-regional-bench.mjs --root /tmp/root-fixture --arome /tmp/arome-dry-run --icon /tmp/icon-dry-run --out /tmp/regional-browser --port 8791
```

Open `http://127.0.0.1:8791/?start=2026-10-02T12:00Z`. The page uses this
repository's actual engine and HTTP transport. Run root, then AROME/ICON-EU,
and repeat warm. Buttons report transfer bytes, requests and total call time.
Use fresh tabs for each cold comparison and instrument the browser for memory;
total call time includes fetch/decode/sampling, not isolated decode CPU time.
The server binds localhost and reads only the supplied scratch layouts.

Recorded 2026-10-02 on headless desktop Chrome, Brest–Cherbourg points,
12–18 UTC, actual regional tiles but a **small synthetic root fixture**:

| Model | Cold regional bytes / call time | Warm bytes / call time | Sampled added JS heap plus backing storage |
|---|---:|---:|---:|
| AROME 09Z | 3,845,933 / 194 ms | 0 / 0 ms | 54,931,889 B (52.4 MiB) |
| ICON-EU 12Z | 4,888,594 / 228 ms | 0 / 1 ms | 63,754,930 B (60.8 MiB) |

Each requested one regional tile. CDP `Runtime.getHeapUsage` was sampled every
25 ms. This is sampled heap plus backing storage, not RSS or proof of the
absolute peak. Physical-phone and representative full root-workload checks
are still unverified; mobile-viewport regressions do not establish phone memory.
Tactician requires its own model/export audit before adopting the new layers.

Producer evidence, capacity configuration, per-model activation and rollback:
[forecast-tiles regional delivery](https://github.com/deepregatta/forecast-tiles/blob/main/docs/regional-delivery.md).
