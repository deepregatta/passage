# Forecast consumers and freshness

P02 verification, 2026-10-04. The current consumer already uses the custom
domain; no client defect or four-hour application staleness was reproduced.
No runtime code, saved payload, forecast identity or R2 access setting changed.

## Supported consumers

| Consumer | Source and configuration | Identity / cache behavior |
|---|---|---|
| Planner Compute, Check and Scan | `forecastStore.js`, `HttpTileTransport`; build-time `VITE_FORECAST_BASE_URL` defaults to `https://forecast.deepregatta.com` | Root `latest.json`, then immutable `forecast-runs/<run_id>/manifest.json` and manifest-declared tile paths. JSON uses `no-cache`; gzip tiles use `force-cache`, with `reload` for retries/corruption recovery. |
| Regional comparison and GRIB | Same store; `VITE_REGIONAL_MODELS` explicitly allows `weather-arome,weather-icon-eu,weather-ukv` | Adds separate `latest-regional.json`; does not replace the root catalogue. Regional discovery is optional; failed discovery does not prevent root analysis. |
| Prepared action inputs | `preparedRun.js`, `browserAnalysis.js`; production uses `<forecast-base>/prepared/` | `prepared/latest.json` uses `no-cache` and is rediscovered at each Check/Scan action. One pointer and its exact artifact revisions are frozen into the action. Concurrent discovery shares a promise; failures can retry. |
| Prepared background wind | `RouteMap.jsx` uses the same prepared resolver | Uses the memoized prepared source for display; an example never loads current wind. This is not a new forecast action or a background polling loop. Saved background-wind coherence remains the separate issue recorded in the capability map. |
| Saved synoptic charts | `synopticCharts.js` resolves `runs/...` against the prepared base and `charts/...` against `/data/snapshots/<id>/` | Producer content revisions and legacy relative paths remain verbatim. Resolution does not depend on successfully loading latest. No old record is rewritten. |
| Browser GRIB download | `gribExport.js`, `Grib.jsx`, engine export modules | Uses the same pinned store and action freshness guard. Download bytes and run provenance are independent of future pointer changes. |
| Engine CLI analysis / GRIB | Analysis: `--tiles-url` or `DEEPWEATHER_FORECAST_BASE_URL`; local `--tiles-dir` / `--fixture-dir`. GRIB: `--base-url`, then that environment variable, then the custom domain | Public `HttpTileTransport` also supports caller-supplied hosts. CLI GRIB metadata records `source.base_url` or `tiles_dir`; historical provenance is not an instruction to migrate an archive. |
| Development / demo | `VITE_DW_FIXTURE=demo`, `viewer-demo`; tiles default to `/data/forecast`, prepared reads always use `/data/` | Failed reads do not switch hosts. `static-dist` tests production source resolution. |

Another public host needs the matching `connect-src` and `img-src` CSP entries
in `viewer/public/_headers`. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_BUCKET` belong to the publisher's authenticated
S3 path, not a browser public URL; do not replace them with a custom domain.

The dated provider read-back confirmed production and preview
`VITE_FORECAST_BASE_URL=https://forecast.deepregatta.com`, production's three
regional models, `npm run build:pages`, and the current deployed source commit.
The deployed app-store chunk contains the custom domain, regional allowlist and
`no-cache`, with no `r2.dev` reference. No active `r2.dev` dependency was found
in Passage's tracked source, fixtures or available local saved data. Private
inventory, deployment IDs and raw provider evidence stay outside this repository.

## Three distinct cache lifetimes

The producer publishes root/regional/prepared pointers with
`public, max-age=300, must-revalidate`. Run manifests, PFT1 gzip tiles and
content-versioned prepared JSON/PNG objects use
`public, max-age=31536000, immutable`. The producer's current object path and
run identity must never be replaced by a speculative latest-data substitution.

On 2026-10-04 the active hostname cache rule marked forecasts eligible and
selected **Use cache-control header if present, bypass cache if not** for Edge
TTL. It had no Browser TTL setting. The zone's Browser Cache TTL was **4 hours**.
GETs for all three pointers consequently advertised `max-age=14400`, while HEAD
and the alternate endpoint advertised 300. A normal GET hit at age 281 seconds;
a later GET revalidated after the five-minute edge lifetime, still advertising
14400. HEAD returned `DYNAMIC`; that does not contradict the observed GET hits.

Chromium's actual `fetch(..., {cache: 'no-cache'})` sent `max-age=0` plus ETag
and Last-Modified validators for each pointer, received raw `304 HIT`, and
exposed a usable `200` JSON response. It did not reuse an unvalidated disk or
service-worker response. A fresh browser had zero registered service workers
and no CacheStorage entries. This reproduces the header discrepancy, not a
four-hour client staleness defect. It does not observe a newly published run
crossing an edge lifetime or establish every client/browser's behavior.

The store refreshes at the next user action when its successful check is
**more than ten minutes** old. It does not poll while idle or replace runs
during an action. An obsolete run's 404 triggers one rediscovery/retry; a
still-missing run fails honestly. Existing store/freshness tests exercise actual
rotation, single-run actions, previous-run fallback and failed refreshes.

## Persistence and compatibility

`passage-forecast-tiles` IndexedDB stores validated immutable gzip bytes keyed
by run and tile path, with separate size/LRU metadata; it stores neither latest
pointers nor manifests. Initialization and refresh evict other run IDs from this
disposable cache. They do not migrate or delete saved decision evidence.
`passage-local-snapshots` separately preserves write-once briefing artifacts.
Planner drafts and localStorage settings do not select a forecast hostname.

Scratch Chromium loaded all ten current manifests through the custom domain,
decoded a real weather tile, retained the pinned grid during an offline refresh,
rediscovered on reconnect and served the tile after online reload with zero new
tile network requests. This does not promise a cold offline start: the app shell,
JSON discovery and uncached images are separate dependencies. Frozen saved
findings must remain readable without loading current forecast evidence.
The served legacy example was copied byte-for-byte into scratch snapshot
storage and remained readable after online reload, while offline in the loaded
page, and after reconnect. A complete offline navigation reload failed with
`ERR_INTERNET_DISCONNECTED` even with HTTP caching enabled and no Playwright
routing. P02 does not add an offline app shell or change this availability limit.

Existing substantive checks cover revised/legacy saved chart resolution,
unavailable latest, byte-preserving snapshot round trips, action inputs,
run rotation, corrupt cache recovery, bilingual shared links and GRIB goldens.
Keep the original demo, compatibility/i18n fixtures and scientific baselines.

## F02 handoff and access gates

Passage's current production consumer is ready to keep using the custom domain.
Disabling `r2.dev` is **not approved or globally cleared** by P02. The alternate
endpoint was still enabled at read-back. Before proposing disablement, F02 must
map other projects, caller environment overrides, old installed/offline bundles,
historical public deployments and externally saved absolute URLs. A source
search cannot enumerate those clients; unreachable consumers remain blockers
until there is an explicit compatibility decision. Preserve historical prepared
paths and briefing links; changing a hostname cannot recover already-deleted data.

For F02, the precise cache proposal is to add
`browser_ttl: {mode: "respect_origin"}` to the existing forecast-host rule,
preserving its expression, `cache: true` and
`edge_ttl: {mode: "bypass_by_default"}` plus any other verified settings.
This makes GET pointer headers match the 300-second origin policy while
preserving year-long immutable caching. Read the complete current rule privately
before constructing its update; do not overwrite uninspected fields or change
the whole zone's browser TTL. This is provider-side policy alignment, not a
required client bug fix. It requires F02's scoped approval and current review.

Rollback restores the prior rule's absence of Browser TTL override. If an
approved endpoint disablement breaks a required client, re-enable only the
managed public endpoint after the applicable approval, then read back both
settings and public GETs. It restores the alternate exposure as well as access;
it is not a data rollback. Never delete/migrate objects or change cadence here.

Read-back must check root, regional and prepared GETs, actual browser conditional
revalidation, immutable manifest/tile/chart bytes and CORS/CSP, normal export,
saved briefing reload and offline/reconnect, and the alternate endpoint's final
denial after any approved disablement. Cache purge cannot remove old browser
entries. Ordinary misses/revalidations and alternate-host reads can still reach
R2: neither caching nor the observed retained-tile byte limit is a spending cap.
The allocation remains EUR 20/month including tax/conversion, domains excluded:
EUR 12 Google/Firebase, EUR 4 R2 and EUR 4 reserve. Preserve free plans and pause
new optional paid production at limits while retaining data and ordinary reads.

Provider references checked on 2026-10-04:
[R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/),
[Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/),
[Edge and Browser TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/).
