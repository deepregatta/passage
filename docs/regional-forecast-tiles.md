# Optional AROME, ICON-EU and UKV forecast tiles

The consumer supports forecast-tiles' separate `latest-regional.json` alongside
required root `latest.json`. The producer's 2026-10-02/03 activation record
confirms reduced-cadence production canaries for all three models; full cadence
remains gated by seven-day acceptance. `VITE_REGIONAL_MODELS` is empty by default;
an explicit comma-separated
`weather-arome,weather-icon-eu,weather-ukv` allowlist enables only those named models.
The deployed allowlist is recorded in the producer's
[regional delivery evidence](https://github.com/deepregatta/forecast-tiles/blob/main/docs/regional-delivery.md).
Do not expand cadence or claims beyond those gates. The public regional pointer
was readable at 2026-10-04 06:00 UTC with `updated_at=2026-10-04T05:49:26Z`.
This metadata read does not prove complete coverage or canary acceptance.

Missing/failed regional discovery is harmless to root forecasts. Refresh
retires removed regional runs and evicts caches using both catalogues. GFS
remains the default point/routing/wind-grid source; ECMWF selection retains
its existing full/short run behavior. Named `getRegionalWindGrid()` requires
complete coverage and horizon and never substitutes global values. Ordinary
comparison adds only opted-in regionals with finite wind and complete temporal
coverage; unavailable hazard fields remain unavailable.

New runs declare 5° AROME / 10° ICON-EU / 3° UKV tiles and explicit served geometry.
All lookup, neighbor probes, mosaics and exports use the manifest layout.
Regional transfer admission shares 20 MiB across models per analysis. Each
tile is limited to 8 MiB gzip and 32 MiB decoded Float32 arrays. Declared
inflated/decoded sizes are checked before allocations, decode is serialized,
and working-set admission adds transient buffers to retained regional arrays
under 128 MiB. Automatic comparison also preflights aggregate retained bytes
against the 64 MiB shared cache remaining after the root workload, and accounts
for each candidate's transient buffers alongside previously admitted models.
Models are admitted in allowlist order; those that cannot coexist are omitted
before transfer. Explicit named grids and exports remain available within
their separate request budgets. The shared retained cache remains 64 MiB. Regional compressed
data use IndexedDB; the memory fallback does not accumulate another cache.

The GRIB selector offers AROME/ICON-EU/UKV only when their opted-in manifests exist.
Their fixed-period export plans require full time and rectangular-domain coverage;
Full forecast keeps the requested start and ends at each model's own last step.
Both retain
missing mask cells, use source attribution and one-hour maximum gust windows,
and cap compressed tile transfer at 50 MiB for an explicit download. UKV
preserves instantaneous +0 h gust at 10 m, Met Office centre 74, its upstream
CC BY-SA licence and transformation notice. Exports
are opt-in; default local/global model order is preserved. The evidence
inspector displays model-originator/Open-Meteo attribution. Unsupported regional
next-publication estimates are omitted because AROME delay depends on cycle.

## Reproduce the desktop scratch benchmark

Generate producer dry runs with verified gust, plus a clearly identified root
fixture or a representative live root workload, then run:

```sh
node scripts/serve-regional-bench.mjs --root /tmp/root-fixture --arome /tmp/arome-dry-run --icon /tmp/icon-dry-run --ukv /tmp/ukv-dry-run --root-kind live --out /tmp/regional-browser --port 8791
```

Open `http://127.0.0.1:8791/?start=2026-10-02T12:00Z&workload=full`. The page uses this
repository's actual engine and HTTP transport. Run root, then AROME/ICON-EU/UKV,
and repeat warm. Buttons report transfer bytes, requests and total call time.
Use fresh tabs for each cold comparison and instrument the browser for memory;
total call time includes fetch/decode/sampling, not isolated decode CPU time.
The server binds localhost and reads only the supplied scratch layouts.

Recorded 2026-10-02 on headless desktop Chrome, Brest–Cherbourg points,
12–18 UTC, actual regional tiles and copied public production root bytes
(`latest.updated_at=2026-10-02T17:27:15Z`). The full workload fetches GFS, GEFS,
waves, global currents and short ECMWF tiles; it loads seven manifests but
this route does not fetch full ECMWF or IBI tiles.

| Workload | Cold regional bytes / total call time | Warm bytes / total call time | Sampled JS heap plus backing-storage increase |
|---|---:|---:|---:|
| Root only | 0 / 326 ms | 0 / 7 ms | 44,410,068 B (42.35 MiB) |
| Root + AROME 09Z | 3,845,933 / 484 ms | 0 / 15 ms | 100,149,996 B (95.51 MiB) |
| Root + ICON-EU 12Z | 4,888,594 / 517 ms | 0 / 15 ms | 111,394,470 B (106.23 MiB) |
| Root + UKV 12Z | 5,682,390 / 506 ms | 0 / 15 ms | 94,981,105 B (90.58 MiB) |

AROME/ICON-EU request one regional tile; UKV requests two. CDP
`Runtime.getHeapUsage` was sampled every 25 ms, with fresh pages/GC between
models. Increases include the root workload; these are not process RSS or
proof of the absolute peak. All stay below 128 MiB and transfer limits.
### Historical phone checkpoint, before combined-admission refinement

Samsung Galaxy A53 (SM-A536B), Android 16, Chrome 154.0.8037.92 ran the same
root workload through USB loopback. This measures real phone decoding and
sampling, not mobile-network latency. Each cold comparison used a fresh page;
CDP heap plus backing storage was sampled every 25 ms.

| Workload | Cold regional bytes / total call time | Warm regional bytes / total call time | Sampled increase |
|---|---:|---:|---:|
| Root only | 0 / 2,394 ms | 0 / 71 ms | 38,448,152 B (36.67 MiB) |
| Root + AROME | 3,845,933 / 3,269 ms | 0 / 65 ms | 89,224,220 B (85.09 MiB) |
| Root + ICON-EU | 4,888,594 / 3,481 ms | 0 / 62 ms | 97,507,961 B (92.99 MiB) |
| Root + UKV | 5,682,390 / 3,604 ms | 0 / 66 ms | 74,657,461 B (71.20 MiB) |

All three individual selections passed sampled memory and transfer limits.
Selecting all three together exposed warm cache churn: 14,416,917 regional
bytes downloaded again. Automatic comparison now preflights declared retained
bytes against the 64 MiB cache remaining after root loading, and each model's
transient peak against the shared 128 MiB regional ceiling. It admits models
in allowlist order and omits those that cannot coexist; named requests/export
remain explicit. No cache or forecast resolution is increased to fix this.

The final desktop all-model selection admitted AROME alongside the root,
transferred 3,845,933 B cold / zero warm, took 462 / 17 ms, and increased sampled
heap plus backing storage by 100,139,367 B. Root-only increase was 47,859,812 B.
Regression tests cover both retained and transient refusal before a second
model downloads. The phone became unavailable before this combined fix could
be retested at this checkpoint; final combined-phone proof was still open then.
The later evidence below supersedes that gate state. Boundary/mask
regressions are separate from these three-point route measurements.


A desktop boundary route at 49.9–50.1°N crossed AROME's 5° and ICON-EU's
10° tile lines. Named grids returned finite vectors for all three models.
AROME transferred 8,508,522 B and reused both tiles warm; UKV reused its one
already-admitted tile. The larger explicit ICON-EU mosaic transferred
10,381,719 B again warm because serialized transient admission evicted a
previous tile. Automatic comparison omitted that request before transfer,
preserving the root workload. Explicit mosaics remain subject to their request
budgets and may require a smaller region for warm reuse. Boundary-phone
measurement was outstanding at this checkpoint and is superseded below.

## Later phone and production evidence

The producer's 2026-10-02 final Galaxy A53 measurements passed individual,
combined and boundary workloads using the actual consumer. Automatic warm
repeats made zero tile requests/decodes; the combined three-point selection
admitted AROME and the boundary selection admitted UKV. Named ICON-EU boundary
mosaics still evict/redownload warm; the smaller one-tile request reuses warm.
These close the phone gate for those workloads, not network latency, absolute
process peak or operational forecast accuracy. Detailed bytes, sampled memory
and decoder times remain in the linked producer record rather than replacing
the historical tables above.

That record also confirms a Passage deployment at `b8108c1` with all three
model flags and live one-day GRIB exports independently decoded with ecCodes.
Reduced cadence remains two selected cycles/day. Seven-day acceptance has not
passed: preserve AROME/UKV's original windows, ICON-EU's original miss and the
owner-approved separate ICON-EU recheck. Do not infer activation/freshness from
an empty source default or a successful local test.

Tactician requires its own model/export audit before adopting the new layers.

Producer evidence, capacity configuration, per-model activation and rollback:
[forecast-tiles regional delivery](https://github.com/deepregatta/forecast-tiles/blob/main/docs/regional-delivery.md).
