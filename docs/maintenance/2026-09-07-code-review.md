> Companion tracker: [2026-09-07-review-tracker.md](2026-09-07-review-tracker.md). One step per agent session; move both files to `trashbin/documentation/` when the campaign is closed.

# Passage — exhaustive code review (2026-09-07)

Reviewed at commit `08de648` (main). **No repository files were modified by this review.**
During the review the working tree gained uncommitted changes from another session
(`viewer/src/pages/Example.jsx` + edits to App.jsx, Shell.jsx, i18n.js, routes.js,
Planner.jsx, appStore.js — an "example briefing" page and `pushState` navigation).
Findings below refer to HEAD; where those uncommitted changes already address a point it
is noted.

## 1. Method and verified baseline

| Check | Result |
|---|---|
| `npm test` (engine build + vitest) | engine 18 files / 112 tests pass; viewer 8 files / 40 tests pass |
| `cd analysis && uv run pytest -q` | 157 passed |
| `ruff check` / `ruff format --check` | clean |
| `npm run build -w viewer` | builds; see §5 for what the chunk graph actually does |
| `npm audit` | 0 production vulnerabilities; 5 high in dev deps (postcss, browserslist, nanoid, fast-uri, undici), all `npm audit fix`-able |
| `tsc --noUnusedLocals --noUnusedParameters` (engine/src) | 4 unused symbols |
| Type-checking `engine/test` (not done by any script today) | 4 real type errors (see §7) |

Every engine, contract, config, script and CI file was read in full by me. The Python
factory (~11.7k lines) and the React viewer (~7.8k lines) were read in full by two
sub-reviews; I independently re-verified every finding marked **[verified]** below by
reading the code or running a probe. Items marked **[reported]** come from the
sub-reviews and were spot-checked but not individually reproduced.

Two experiments were run to confirm suspected bugs:

- Router thinning: `computeRoute` on a comb-shaped land mask (6 walls, alternating gaps) returns a route whose **12 of 20 emitted legs cross land** although the internal Dijkstra path did not.
- Build graph: the production `index.html` `modulepreload`s `vendor-echarts` (375 KB gz) and `vendor-leaflet` (87 KB gz) because React itself ended up inside those chunks.

---

## 2. Priority list (what to fix first)

Ordered by user impact × confidence. Each item names the section with detail.

1. **UK gale warnings can silently emit zero bulletins** during a fleet-wide gale ("warnings of gales in all areas except …") — analysis/warnings_uk.py §4.1 **[verified]**
2. **Météo-France feed crashes instead of degrading** on any CSV column/date change, and publishes "FIN D'AVIS DE COUP DE VENT" cancellations as active gales — §4.1 **[verified]**
3. **Computed routes can cross land** after waypoint decimation — engine/src/routing/isochrone.ts:256 §3.1 **[verified by experiment]**
4. **Startup downloads ECharts + Leaflet eagerly** (≈460 KB gz wasted on first paint) because Vite 8/rolldown ignores the intended `manualChunks` split — viewer/vite.config.js §5 **[verified]**
5. **One transient tile-host failure poisons the app until reload**: `TileForecastStore.init()` memoises a rejected promise and the viewer holds a singleton store — engine/src/forecast/tileStore.ts:71 §3.1 **[verified]**
6. **IndexedDB tile cache does a full `getAll()` (all tile bytes) on every write and rewrites the full tile on every read** — viewer/src/lib/tileCache.js §3.2 **[verified]**
7. **Regional expansion left Channel-only assumptions behind**: `positionPhrase()` geography, `tides/channel.json` for every route, `fr_zones+uk_zones` only, `GENOA_BOX` outside the ECMWF crop, Channel-only synoptic windows — §3.1, §3.2, §4 **[verified]**
8. **Honesty gaps in the UI**: emulated bulletins without a badge, a "Compare safer departure" overlay that is the same polyline shifted 5 px, and a "Models used" panel describing feeds production never loads — §3.2 **[verified]**
9. **French leaks**: ≥8 production-path strings (tile errors, routing errors, progress labels, Suspense fallbacks) are untranslated; `/fr/index.html` ships an English no-JS body; engine prose is translated by 106 regexes keyed on exact English — §6 **[verified]**
10. **`jsonschema` is a runtime dependency declared only in the dev group** — every publisher imports it — analysis/pyproject.toml §4.1 **[verified]**
11. **Naive-datetime `.astimezone(utc)` bugs** in `tides.prepare_tides`, `scenarios.generate_scenario`, `_iso_utc` (×2): an offset-less "ISO UTC" input is read as local machine time — §4.1 **[verified]**
12. **Departure-scan selection outline never shows** (`.000Z` vs `Z` string comparison) and `crypto.randomUUID()` throws on non-HTTPS LAN testing — viewer/src/pages/Planner.jsx §3.2 **[verified]**
13. **Playback rAF loop never stops on unmount**; map/timeline re-render every frame — §5 **[verified]**
14. **No lint/type gates for TS/JS**: no ESLint, tests never type-checked, `noUnusedLocals` off; CI pins Node 22 while dev runs Node 24 — §7
15. **R2 publish path re-uses run ids with changed content and prunes by lexicographic id across families** — scripts/upload-prepared-run.py §4.2 **[verified]**

---

## 3. Bugs

### 3.1 Engine (`engine/src`) — all [verified]

| # | Where | Finding | Proposed fix |
|---|---|---|---|
| E1 | routing/isochrone.ts:247-257 | After collinear thinning, `keepEvery = floor(n/16)` decimates by index and drops real corners; emitted `route.waypoints` legs cross land (experiment: 12/20 legs). Downstream the audit samples leg midpoints that may be on land and the map draws a route through the coast. | Decimate only runs of near-collinear points; after decimation, walk the kept list and re-insert the dropped corner whenever `segmentCrossesLand(prev, next)`; add a test asserting no emitted leg crosses the mask. |
| E2 | forecast/tileStore.ts:71-74 | `init()` caches a rejected promise forever. The viewer singleton (`viewer/src/lib/forecastStore.js`) therefore fails every later analysis and scan after one failed `latest.json`/manifest fetch. | `initPromise = this.initOnce().catch(e => { this.initPromise = null; throw e; })`. Same pattern in `viewer/src/lib/localSnapshots.js:13` (`dbPromise ??=`). |
| E3 | briefing.ts:340-343 | `positionPhrase()` uses absolute thresholds (lat 47/52, lon −12/−6) — "west of the approaches", "to the south" are wrong for Newport→NYC, Brisbane→Gladstone, Palma→Barcelona. | Phrase relative to the route bbox (bearing + distance band from the route centroid). |
| E4 | briefing.ts:346-356 vs diff.ts:269-273 | Two "next run" helpers disagree: `nextEcmwfRun()` returns model `gfs_0p25` with 4.5 h lag; `diff.nextRun()` returns `ecmwf_ifs025` with 8 h/14 h lag. The briefing and the change story tell the user different next-update times. | One helper fed by `store.describe()` (cycle + cadence per layer); pass the result into both renderers. |
| E5 | cli.ts:27-39 | `parseArgs` consumes the token after every `--flag`, so `--print --departure X` sets `print="--departure"` and loses the departure. | Treat a following `--token` as "no value". |
| E6 | cli.ts:99-104, viewer/src/lib/browserAnalysis.js:87-90 | Route zone ids are built from `fr_zones + uk_zones` only; config/route-zones.json has `us_zones`, `meteoalarm_zones`, `au_zones`. Non-Channel routes get an empty list, and the viewer then falls back to *all* bulletin zones (a Channel gale would raise the authority banner on a US route in dev). | Flatten every `*_zones` key; add a test over every route in route-zones.json. |
| E7 | cli.ts:136, browserAnalysis.js:77 | `tides/channel.json` is loaded for every route; route-sources.json defines `tides.artifact_name` per route. Non-Channel routes get Channel tide data and coverage reports `tidal_gates: assessed`. | Publish a small `tides/index.json` (route_id → artifact) or embed `artifact_name` in the route doc; load per route. |
| E8 | io/node.ts:12-23 | `exists()` checks only `snapshot.json` while `write()` refuses any existing artifact → a snapshot interrupted mid-write can never be completed or retried (same for the dev-middleware POST path, which 409s on any existing file). Browser fallback is fine (`put` overwrites). | `exists()` = directory contains any artifact; or allow idempotent rewrites when content is byte-identical. |
| E9 | window.ts:63 | `catch {}` swallows every candidate failure, including E2 and programming errors; the Planner then reports "beyond the forecast horizon" for candidates that failed for other reasons. | Record `{departure, reason}` per skipped candidate and return it; the Planner already renders a "N of M not shown" line. |
| E10 | briefing.ts:131, 288-298 | `worstDet` is computed and never used; `pickWorst(…, 'deterministic')` sorts with `value/limit` on evidence whose value is a string/object or whose limit is null → NaN comparator (unstable sort). Dead today, a trap tomorrow. | Delete `worstDet`; if the deterministic pick is ever needed, rank via the same `evidenceMateriality` used in findings.ts. |
| E11 | findings.ts:1021-1030, window.ts:70-71 | Materiality/worst-ratio use `value/limit`, which is inverted for visibility (`V-VIS-01`, lower is worse). A 0.5 nm visibility vs 2 nm minimum ranks as ratio 0.25 (good). | Special-case minimum-type limits (`limit/value`) or carry a `severity_ratio` on the evidence. |
| E12 | grids.ts:79-86 | A grid with a single time step yields `t1 = 1`, `times[1]` undefined → every sample null. Reachable when `mosaicGrid` clips to one step. | Guard `times.length === 1` (return that step's field when `timeMs === times[0]`). |

### 3.2 Viewer (`viewer/src`)

| # | Where | Finding | Proposed fix |
|---|---|---|---|
| V1 **[verified]** | lib/tileCache.js:57, 76, 98-112 | `get()` re-`put`s the whole record (tile bytes) to bump `used_at`; `put()` calls `enforceBudget()` which `getAll()`s every cached tile's bytes into memory to sum sizes; `evictExcept()` also `getAll()`s. With hundreds of MB cached this is a memory/IO cliff on every analysis. `MAX_BYTES = 1.5 GiB` is above common origin quotas so the budget never trims before `QuotaExceededError`, which is swallowed. | Keep `{key, run_id, size, used_at}` in a second object store (or use `getAllKeys()` + an index on `size`); touch `used_at` at most once per session per key; set the budget from `navigator.storage.estimate()`. |
| V2 **[verified]** | pages/Planner.jsx:757 + lib/format.js:46 | `localDateTimeToIso()` returns `…T06:00:00.000Z`; `candidateDepartures()` returns `…T06:00:00Z`; strict equality never matches → the "selected departure" outline never renders. | Normalise both to second precision (`toIso()` from the engine). |
| V3 **[verified]** | pages/Planner.jsx:288 | `crypto.randomUUID()` is undefined in insecure contexts; "Check this passage" throws on `http://192.168.x.x:5174` (phone testing). `analyticsClient.js` already has a safe `id()` fallback. | Reuse that fallback. |
| V4 **[verified]** | components/SynopticHero.jsx:88 | "Compare safer departure" draws the same route polyline translated by `−5u` px — a decorative fake in an explainability product. | Remove the button until a real alternative-departure route exists (the scan already has one per candidate). |
| V5 **[verified]** | components/BulletinPanel.jsx, pages/Briefing.jsx:229-233 | With the demo's synthetic warning active, the bulletin panel titles itself "Source bulletin" with no emulated stamp and offers "Open official bulletin". Contradicts the repo rule "every emulated value carries a visible badge". | Read `evidence.source_kind === 'emulated'` / `warnings.source.mode` and badge. |
| V6 **[verified]** | pages/Planner.jsx:641-698 ("Models used") vs lib/browserAnalysis.js:77-81 | The static prose claims Météo-France/Met Office warnings and CMEMS-derived tides, but production never loads warnings (`DEV_WRITES` only) and tides come from `public/data/tides/channel.json`, whose own note says synthetic. | Render the panel from `findings.coverage` + `inputs.forecast_tiles` instead of prose. |
| V7 **[verified]** | stores/appStore.js:117-150 | `openSnapshot` has no sequence token; opening A then B quickly can show A's findings under B's id; it also forces `page` on completion and never resets `usePlayback` (cursor/playing carry over). `loadError` was rendered nowhere at HEAD (the uncommitted Example.jsx now reads it, for the example flow only). | Token + abort per open; render `loadError` in Snapshots/Briefing; reset playback on open. |
| V8 **[verified]** | stores/playbackStore.js:63-80, components/TimeRuler.jsx | Only the play/pause button calls `pause()`; leaving the Brief page while playing leaves a 60 fps rAF loop writing to the store forever. | `useEffect(() => () => pause(), [])` in TimeRuler (or in the Briefing page). |
| V9 **[verified]** | pages/Settings.jsx:18-19, 29 | `JSON.parse(localStorage.getItem(…))` unguarded (corrupt draft crashes the page); `setItem` unguarded (private mode/quota throws in the change handler). Same key string repeated 4× across Settings/Planner. | `loadProfileDraft()`/`saveProfileDraft()` helpers with try/catch and `{...defaults, ...stored}` merge. |
| V10 **[verified]** | components/RouteMap.jsx:117-139 | `fetch('/data/config/gates.json')…` has no `.catch` (unhandled rejection offline); three uncancelled loads in one effect race when `findings` changes. | AbortController + `.catch`; take `route` from the store instead of re-fetching `route.json`. |
| V11 **[verified]** | lib/localSnapshots.js:13, 38-43 | `openDb()` memoises a rejected promise; `exists()`/`write()`/`remove()` don't catch → in browsers where `indexedDB` exists but `open()` fails (Firefox private mode, some WebViews) even the served demo cannot open, and with V7 nothing is shown. | Reset on rejection; `exists()` returns false on error. |
| V12 **[verified]** | App.jsx:38-43, components/Shell.jsx:31 | Navigation uses `history.replaceState` only, so the browser Back button leaves the site (the uncommitted `setPage` change switches to `pushState` — good). The skip link sets `#main-content`, which the hash sync ignores and leaves in the URL. | Keep the pushState change; skip link → `onClick` focus + `preventDefault`. |
| V13 **[reported]** | pages/Planner.jsx:427,147 | Empty speed input → `Number('') = 0` → `passageHours = Infinity` ("~Infinity h"); zero speed reaches the scan. | Validate min speed; disable the CTA. |
| V14 **[reported]** | pages/Changes.jsx:18-26, pages/Verification.jsx:28-40, components/SynopticCompare.jsx:6-7, SynopticHero.jsx:27, EnsemblePlume.jsx:43 | Uncancelled fetches (wrong "previous" after fast switching), unhandled rejections offline, `.at(-1)`/`sort(...)[0]` on empty arrays, wrong limit fallback for wind plumes. | Guard empties; AbortController in effects. |
| V15 **[verified]** | pages/Briefing.jsx:146 | `import.meta.env.VITE_DW_MODE === 'production'` — the variable is set nowhere; the "authority styling refused" branch is dead. | Delete the branch or wire the variable. |
| V16 **[verified]** | pages/Settings.jsx:86-95 + config/providers.json:5-7 | Settings lists every provider from providers.json, so `openmeteo_forecast/ensemble/marine: live` still show as active data sources although Open-Meteo was replaced by tiles. | Remove the three keys (and the test in analysis that asserts them live) or add `forecast_tiles`. |
| V17 **[reported]** | components/FooterActions.jsx:197-206 | "Share this analysis" copies `location.href`, which carries no snapshot id; user briefings live only in the sharer's IndexedDB → recipient sees "No analysis open". | Either encode the snapshot id (served demos) or disable share for local briefings. |
| V18 **[reported]** | vite.config.js:86,124,192,176; scripts/serve-pages.mjs:28 | `decodeURIComponent`/`JSON.parse` outside try inside async middleware → unhandled rejection, request hangs (dev only). | Wrap → 400. |

### 3.3 Analysis (`analysis/`) — top items [verified], rest [reported]

| # | Where | Finding | Proposed fix |
|---|---|---|---|
| P1 **[verified]** | warnings_uk.py:32,69-73 | `GALES_RE` captures the sentence tail literally: "warnings of gales in all areas except Trafalgar." → `gale_areas = ["all areas except Trafalgar"]`, which matches no zone → **zero bulletins during a fleet-wide gale**. "There are no warnings of gales in force." → `["force"]`. | Parse the three Met Office forms explicitly: list, "all areas", "all areas except …", "no warnings"; add fixtures for each. |
| P2 **[verified]** | warnings_mf.py:232-249 | Row parsing (`row["date"]`, `strptime`, `row["langue"]`…) sits outside the `try` at 216-225; any upstream CSV change raises instead of degrading to `feed_status: unavailable` as the docstring promises. | Move the loop inside the try, or catch per row and count parse failures into `parse-degraded`. |
| P3 **[verified]** | warnings_mf.py:203-207 | `_severity` is substring matching with no negation: `"FIN D'AVIS DE COUP DE VENT"` → `gale`, and `_parse_validity` gives it a future `valid_to`, so a cancellation publishes as an active gale. | Detect "FIN D'AVIS"/"LEVÉE" and either drop or emit `kind: cancellation` that clears the matching bulletin. |
| P4 **[verified]** | pyproject.toml:39-43 vs 8 runtime `import jsonschema` sites | `jsonschema` lives only in the `dev` group; every artifact publisher imports it at runtime (works only because `uv sync` installs dev by default; the CI workflow comment even relies on it). | Move to `[project.dependencies]`. |
| P5 **[verified]** | tides.py:391-395, scenarios.py:105-107, warnings_us.py:55-58, warnings_meteoalarm.py:51-54 | `datetime.fromisoformat(x).astimezone(utc)` on an offset-less input interprets it as **local machine time** (probe: `10:00` → `08:00Z` in Europe/Paris). The package has five different ISO parsers. | One `parse_iso_utc()` (naive ⇒ UTC) in a `timeutil.py`; use it everywhere. |
| P6 **[verified]** | verification/match.py:184, verification/__init__.py | `write_verification` is exported but never called; `verify` runs `match_snapshot` and drops the per-snapshot pairs (only calibration.json survives). | Call it from `cli.verify` (or delete). |
| P7 **[verified]** | synoptic/regimes.py:52-56,93 | `_box_mean` uses `nanmean`; an all-NaN box returns NaN and both comparisons are False, so the Mistral gate *passes* instead of returning None. | `if not np.isfinite(x): return None`. |
| P8 **[verified]** | scripts/upload-prepared-run.py:79-82, 103-105 | Existing keys are never re-uploaded, but `prepare-run --force` (or a re-run once the 240 h tail exists) regenerates different content under the same run_id → stale artifacts on R2 behind a fresh `latest.json`. Pruning sorts mixed-prefix run ids lexicographically, so one family dominates the keep-set. | Compare a content hash (ETag) before skipping; prune per family by trailing timestamp. |
| P9 **[verified]** | tests/test_polars.py:24-29 | The ORC fixture skips 6 of 10 polar tests whenever `data/raw/polars/ALL2025.json` is absent — always in CI. The match cascade and `extract_polar` never run in CI; `build_polar_db` has no test. | Commit a 20-record ORC sample fixture. |
| P10 **[reported]** | warnings_mf.py:165-182 | `_resolve_day` with an explicit month earlier than the issue month always adds a year (issued 15 Jan, "31 DECEMBRE" → next year). | Prefer the nearest date within ±7 days. |
| P11 **[reported]** | observations.py:246-261, 364-371, 569-573 | `_num` raises on any non-`MM` non-numeric token and nothing catches it, so one bad token in one NDBC line flips the whole observations document to synthetic; `records_from_insitu_nc` assumes `(TIME, DEPTH)`; the outer `except Exception` hides the cause (no logging in the module). | Per-line/per-variable tolerance, log the reason, keep partial documents. |
| P12 **[reported]** | environment_grid.py:405-408, 507-532 | Nearest-neighbour fallbacks return edge-cell values for points outside the box/time range while the docstring says None. Latent (grids_prep queries inside the buffer). | Return NaN outside coverage. |
| P13 **[reported]** | verification/era5.py:218-222 | year/month/day lists form a cartesian product; a window crossing a month boundary requests phantom days. All 11 corpus cases are single-month today. | Build the request per (year, month) with that month's day list, or assert single-month. |
| P14 **[reported]** | verification/corpus.py:250-252 | `hours_from_start % STEP_H != 0` on floats drops every step if a case window starts off the hour. | Round to minutes first. |
| P15 **[reported]** | grids_prep.py:170-184, synoptic_prep.py:173-190, land_mask.py:83-116 | Three read-modify-write implementations of `runs/latest.json`; none atomic. | One `update_latest()` with tmp+rename. |
| P16 **[reported]** | scenarios.py:191-213 | Synthetic `warnings.json` is written without schema validation, unlike every other writer; zone id `casquets` and the point layout are Cherbourg-specific. | Validate; derive from route-zones. |

---

## 4. Robustness and correctness risks (not yet observed failures)

### 4.1 Analysis (continued) [reported unless marked]
- warnings_uk.py:63-67 — issue/validity times are the first three timestamps in page order; any extra timestamp shifts all three.
- warnings_uk.py:89-91 — `_area_matches` is bare substring containment.
- warnings_us.py:73-88 — no filter on `properties.status` (`Actual` vs `Test`), unlike the Meteoalarm parser.
- warnings_mf.py:218-221, 283-284 — full-year gzip on every call (no ETag), timestamped output files never pruned.
- warnings_au.py:135 — `urllib` FTP fetch, no retry; the flakiest of the five feeds.
- tides.py:175-188, 226-227, 284-299, 364 — one NaN in the chosen SSH cell fails the port and degrades the whole doc; CO-OPS `end_date` inclusivity unverified; QLD downloads the yearly dump per port per call; the degraded note always blames CMEMS.
- observations.py:412-432 — In Situ cache grows without bound.
- ecmwf_open_data.py:53-58, synoptic_prep.py:46-51, synoptic/render.py:39-65 — synoptic crop (35–65N, 35W–10E) and wind-grid windows are hardcoded Channel/NE-Atlantic; `regimes.GENOA_BOX` (7–11E) extends past the 10E crop, so the Genoa mean is computed on 7–10E only **[verified: box constants]**.
- synoptic/track.py:150 — `points[-2]` with `min_track_steps = 1` → IndexError.
- environment_fetcher.py:845-846 — unconditional 2 s sleep after every successful fetch (vendored leftover).
- observations.py:59-81, tides.py:73, grids_prep.py:38 — registry lookups at import time bind the default route into module constants; importing with an unknown `DEEPWEATHER_ROUTE_ID` raises at import.

### 4.2 Engine / viewer
- forecast/httpTransport.ts — no timeout/AbortSignal, no retry; a hung R2 fetch hangs analysis at "reading … tiles". `latest.json` fetched with default cache mode; immutable tiles fetched without `cache: 'force-cache'`. **[verified]**
- forecast/tileStore.ts:120-152 — no `fnv64` verification and no self-heal: a corrupt IndexedDB entry makes `decodeTile` throw "not a PFT1 tile" on every analysis. Delete the key and refetch once on decode failure (hash.ts already has FNV-1a 64). **[verified]**
- forecast/tileStore.ts — no in-flight de-duplication in `tileFor()`; decoded tiles are kept forever (an ensemble tile decodes to ~20–25 MB). **[verified]**
- eta.ts:125 — `parseUtc` treats only `+` as an offset marker; `-05:00` inputs get `Z` appended and throw. Latent.
- routing/isochrone.ts:99 — `Date.parse(departureUtc)` unvalidated; NaN propagates silently.
- viewer/src/lib/forecastStore.js:11 — `VITE_FORECAST_BASE_URL` falls back to `/data/forecast`, which does not exist in `dist/`; production depends on a Pages-dashboard variable that no checked-in config documents.
- viewer/playwright.config.js:19 — `reuseExistingServer: true`: a non-fixture dev server on 5174 makes e2e run against the real warehouse.
- viewer/src/lib/preparedRun.js:14,54 — `runsBase()` singleton is only correct "once `preparedRun()` settled"; callers rely on ordering.

---

## 5. Performance

| # | Where | Finding | Proposed fix |
|---|---|---|---|
| F1 **[verified]** | viewer/vite.config.js:273-280 | Under Vite 8 (rolldown) the `manualChunks` function puts React core into `vendor-echarts` and react-dom into `vendor-leaflet`; `vendor-react` is 543 B and statically imports both, so `index.html` preloads ~460 KB gz of charts + maps before the planner renders. The `lazy()` wrappers in `components/lazy/*` are defeated. | Use rolldown's `build.rolldownOptions.output.advancedChunks` groups (react first, then echarts/leaflet) and add a build assertion that `dist/index.html` does not preload `vendor-echarts`. |
| F2 **[verified]** | components/lazy/EChartsLazy.jsx:3 | `echarts-for-react` imports the full `echarts` build (1.14 MB / 375 KB gz). Only LineChart + Grid/Tooltip/Legend/Mark* components + SVGRenderer are used. | `echarts-for-react/lib/core` + `echarts/core` with registered components; drop `chunkSizeWarningLimit: 1200`. |
| F3 **[verified]** | viewer/src/lib/tileCache.js | See V1 — `getAll()` of tile bytes on every put/evict; full-record rewrite on every get. | Metadata store / key index. |
| F4 **[verified]** | stores/playbackStore.js, components/RouteMap.jsx:105,215-247, RouteTimeline.jsx:18-21, Briefing.jsx:267 | During playback every subscriber of `cursorHours` re-renders per frame: RouteMap rebuilds ~30 `L.divIcon`s per frame; RouteTimeline rebuilds the whole ECharts option to move the NOW line; `WeatherStoryCard` re-sorts evidence per frame. | Only the boat marker / NOW mark-line should subscribe; memoise icons; use `setOption` with `{replaceMerge: ['series']}` or a graphic element for the cursor. |
| F5 **[verified]** | viewer/src/i18n.js:1067-1099 | `localize()` walks every text node and 4 attributes under `#root` on every mutation batch, in both languages (EN still walks). During playback this is a full-document walk per frame. | Skip observing when `language === 'en'`; localise only `MutationRecord.target` subtrees. |
| F6 **[verified]** | engine analyze.ts:99-106, tileStore.ts:82-93 | Deterministic/ensemble/wave/hazard layers are read sequentially; manifests are fetched sequentially per layer. | `Promise.all` (keep per-layer progress messages). |
| F7 **[verified]** | engine grids.ts:52-96 | `GridSampler.sample()` allocates 16 objects and does a linear `findIndex` per call; called per node pop in Dijkstra. | Binary search on the time axis; scalar bilinear without temporaries. |
| F8 **[verified]** | engine tileStore.ts:503 | `mosaicGrid` builds a `Map` of the tile's time axis per grid point (up to 4000 × steps entries). | Index once per tile. |
| F9 **[reported, agent-measured]** | analysis/grids_prep.py:263-270 | The target grid is a strided subset of native nodes at native steps, yet values go through batched trilinear `interp` + KDTree fill (~10 s per 120 h Channel window); linear interp at a node adjacent to NaN returns NaN so coastal cells are "filled" by themselves. | Direct `isel` + fill only genuinely masked cells (~100× faster and exact). |
| F10 **[reported]** | viewer/src/lib/localSnapshots.js:66-95 | `list()` does `getAll()` on the whole store (every plume.json body) to build the manifest. | Use the `snapshot_id` index with key ranges or store manifest rows separately. |
| F11 **[reported]** | analysis/warnings_mf.py:152,292, polars.py:801-808 | route-zones.json re-read per call; ORC JSON parsed twice per process. | `lru_cache` / reuse `load_orc_polars`. |

---

## 6. Localisation

- **Structural risk [verified]**: the viewer translates engine-generated prose with 106 regexes keyed on the exact English sentence (`FR_PATTERNS`, i18n.js:493-604) plus word-level `FR_FRAGMENTS` applied to every string. Any engine wording change silently leaks English into `/fr/`, and fragments produce franglais on unknown strings ("This route uses vent alone", "bateau polar"). Long-term: the engine should emit `message_id + params` alongside `register_plain` and the viewer should own both languages; short-term: a test that renders every golden/demo briefing through `translateText` and fails on any untranslated engine sentence.
- **Untranslated production strings [verified absent from i18n.js]**: "No forecast tiles cover this area yet", "Couldn't load the forecast tiles…", "This departure is beyond the forecast horizon", "Currents unavailable right now…", "Drawing forecast…", "Loading passage chart…", every progress label ("reading forecast run manifest", "evaluating against your limits", "computing route…", "scanning departures 3/21…"), "Specify at least two valid waypoints.", plus `arrives`/`avg` in the computed-route line and split text nodes in EvidenceInspector/SynopticCompare.
- **`/fr/index.html` no-JS body is English [verified]**: prerender-fr.mjs localises only `<head>` and `lang`; crawlers see a French title on an English page.
- **Catalogue drift [reported]**: 30 FR keys match nothing in src/fixtures; 3 duplicate keys; Verification/CaseStudy use inline ternaries while everything else uses the DOM localiser.

---

## 7. Maintainability, dead code, duplication

### 7.1 Tooling gaps
- No ESLint/Prettier for TS/JS (ruff covers Python). Recommend `typescript-eslint` + `eslint-plugin-react-hooks` (would have flagged several effect issues above).
- engine/tsconfig.json: enable `noUnusedLocals`, `noUnusedParameters`; add `tsconfig.test.json` and a `typecheck` script run in CI. Type-checking tests today reveals: routing.test.ts passes a `stepMinutes` option that no longer exists; landmaskPack.test.ts possibly-undefined index; tileStore.test.ts `Ajv2020.default`.
- CI: Node 22 pinned, local Node 24, no `engines`/.nvmrc. Python job doesn't lint `scripts/upload-prepared-run.py` (outside analysis/). `npm audit` not run.
- `npm run dev -w viewer` consumes `engine/dist` (package `main`); no predev build and no vite alias to `engine/src`, so a stale dist silently runs old engine code and engine edits don't hot-reload. Add `predev: npm run build -w engine` or alias `@deepweather/engine` → `engine/src/index.ts` in dev.

### 7.2 Dead code [verified unless marked]
- engine: briefing.ts:131 `worstDet`; diff.ts:222 unused `previous` param; tileStore.ts:12,18 unused imports (`TileVariable`, `tilesForBbox`); convective.ts `SQUALL_LABEL` (0 usages); findings.ts:155 legacy `VIS_MODELS` fallbacks `icon_eu`, `gfs_global`; briefing.ts:233 `generated_at ?? departure_utc` (generated_at is required); tides.ts:137 `gates.find(g => g.gate_id === gate.gate_id)?.verified` ≡ `gate.verified`; `matchSystems` exported but unused outside tests.
- viewer: components/VerdictBanner.jsx never imported; Briefing.jsx:146 `VITE_DW_MODE` branch; index.css `.section-rule` [reported]; EnsemblePlume `buildOption` export unused [reported].
- analysis [reported, spot-checked]: environment_grid.py `_interpolate_variable`/`get_current`/`get_current_polar` (only reachable from each other and a docstring); observations.py `write_observations`; verification `write_verification` (see P6); ecmwf_open_data.py `CACHE_MAX_AGE_HOURS`, `STEPS` alias; numpy `ImportError` guards in environment_fetcher.py; 12 unused `# noqa` directives (`ruff --select RUF100`); `tests/__pycache__/test_scaffold*.pyc`.

### 7.3 Duplication
- Along-course current formula ×3 (eta.ts:78, grids.ts:103, isochrone.ts:199); wind-from-u/v ×2 (tileStore.ts:564, isochrone.ts:183); "Forecast grid coarsened to…" sentence ×2 (tileStore.ts:536, liveGrids.ts:115); manual evidence construction in findings.ts:427-502 beside the `nextEvidence()` helper; cross-sea 45° and CAPE 300/1000 thresholds duplicated between hazards/* and findings.ts:563,601; approaching ratio 0.75 in limits.ts and plainLanguage.ts:21; verdict labels in briefing.ts, diff.ts and viewer i18n; `Briefing.next_run` + `next_runs`.
- viewer: palette hex literals (`#A87718` ×17, `#F3EEE3` ×13, `#16283E` ×11) beside tailwind.config.js and format.js; `recomputePersonalState` in Briefing.jsx and VerdictBanner.jsx; `evidenceById` in appStore and evidenceSelectors; profile-draft load/save ×3; forecast horizon constant ×2 (Planner.jsx:246, routingInputs.js:6); two rule-label vocabularies (changeStory.js vs i18n.js).
- analysis: five m/s→kt constants with two different values (1.94384 vs 1.9438445); `haversine_km`/`_parse_iso`/`_iso_z` re-defined in 5-6 modules; `_open_nc_robust`/`_check_xarray`/`compute_file_checksum` ×3; slugify ×3; User-Agent with a personal e-mail ×3; Pa→hPa sniff ×4 despite the ingest docstring promising "never unit-sniffs"; four copy-paste `_merge_*` warning mergers.

### 7.4 Structure
- findings.ts (1084 lines, one 580-line function): split the per-hour evaluation into pure helpers (wind limits, sea state, hazards, ensemble) returning accumulators; `deriveCausalEvents`/`deriveOperationalEvents`/`deriveCoverage` are already separable.
- Planner.jsx (808) and Briefing.jsx (568) hold 5 and 9 components respectively; `DepartureComparison`, `ModelsUsed`, `DepartureField`, `DecisionBand`, `WeatherStoryCard`, `LegProgressBar` are natural files.
- 28 milestone tags (M1…M11) and ~20 "brief §N" comments in engine/src cite a document now in trashbin; product-brief.md has no numbered sections. Stale names: `openmeteo-*` fixtures and "recorded Open-Meteo fixture" in the golden test; "Supabase" in snapshot.ts and vite.config.js; `openmeteo_history.py` says it mirrors a deleted `openMeteo.ts`; FooterActions "Request a race"/`race_id` (vendored from Coach Regatta); "snapshot" vs "briefing" in English UI copy.
- analysis: import-time side effects (`matplotlib.use("Agg")` in synoptic/render.py; registry lookups binding the default route); `cli.py` `__import__("json")` hack; `paths.cache_dir()` mkdir on read paths.

---

## 8. Test gaps

| Area | Gap | Suggested test |
|---|---|---|
| engine | `window.ts` (`scanDepartures`, used by the Planner) has no test; `plainLanguage.ts`, `exceedance.ts`, `hash.ts`, `httpTransport.ts` untested directly | scan with one failing candidate + `routeFor`; phrase tables; FNV vectors; transport with a 500 and a gzip body |
| engine | no test that computed routes never cross land | comb mask from this review + `segmentCrossesLand` over emitted waypoints |
| engine | tests are never type-checked | `tsc -p tsconfig.test.json --noEmit` in CI |
| viewer | `appStore.openSnapshot`/`deleteSnapshot`/`loadManifest` untested; `localSnapshots.js`, `tileCache.js` zero tests; `Planner.jsx` no unit test; hash router untested | `fake-indexeddb`; two-snapshot race; `DepartureComparison` render (would catch V2) |
| viewer | `e2e/briefing.spec.js:26` asserts `nav.w-44` count 0 — no such class exists (vacuous); `test/app.test.jsx:25` sets a non-existent store field; snapshotCompatibility only asserts "renders" | tighten |
| viewer | i18n tests only sample strings | walk `src/**/*.jsx` literals + golden briefings through `translateText`, fail on identity |
| analysis | ORC polar cascade skipped in CI; BMS CSV path, `fetch_warnings` dispatch/degradation, ECMWF parse/cache, `hw_lw_events`, `prepare_tides` degrade, `openmeteo_history`, CLI `--bounds`, In Situ/QLD fetch loops untested | small committed fixtures |
| contracts | `contracts.test.ts` validates only one route and one profile; every route in config/routes and both polars should validate; findings golden validates output but no test validates snapshot.json/briefing.json/changes.json/plume against their schemas in the engine suite | loop over config/, add schema checks to the scenario harness |

---

## 9. Suggested execution plan ("don't break anything")

Guardrails for every change: `npm test` + `uv run pytest` green; `node scripts/build-demo-snapshots.mjs` byte-identical unless the change intends a product/contract change; `UPDATE_GOLDEN=1` only with a reviewed diff; e2e screenshots re-inspected at both viewports.

**Phase 0 — zero-risk hygiene (1 short session)**
`npm audit fix`; delete dead code (§7.2); enable `noUnusedLocals`/`noUnusedParameters`; add `tsconfig.test.json` typecheck + fix the 4 test type errors; move `jsonschema` to runtime deps; remove stale `openmeteo_*` providers + their test; fix stale comments; add `engines`/.nvmrc; `predev` engine build.

**Phase 1 — safety-relevant bugs (with tests first)**
P1 UK gale parsing; P2/P3 Météo-France degrade + cancellations; P5 `parse_iso_utc`; E6/E7 route-aware zones and tides; V5/V6 honesty badges; E2/V11 init poisoning; E1 router thinning (test with the comb mask, then fix; expect the reference-demo fixture to stay byte-identical since it uses fixed routes).

**Phase 2 — performance**
F1 chunking (verify `dist/index.html` preloads), F2 ECharts core, V1/F3 tile-cache metadata store, V8/F4 playback subscriptions, F5 localiser scope, F6 parallel layer reads. Each is behaviour-preserving and observable in the build output or DevTools.

**Phase 3 — localisation**
Add the "every string translates" test, fix the leaks it reveals, localise the `/fr/` body, then design the message-id contract for engine prose (a `contracts/briefing.schema.json` change — do it deliberately, keeping `register_plain` for old snapshots).

**Phase 4 — structure**
Split findings.ts / Planner.jsx / Briefing.jsx; consolidate duplicated formulas and constants into `engine/src/geo.ts` + `hazards/thresholds.ts`; one `timeutil.py`/`geo.py` in analysis; ESLint with react-hooks; shared palette module.

**Phase 5 — pipeline**
R2 uploader content-hash + per-family pruning; atomic `latest.json` helper; grids_prep `isel` sampling; route-aware synoptic windows or an explicit "Channel-only prepared run" disclosure in coverage.
