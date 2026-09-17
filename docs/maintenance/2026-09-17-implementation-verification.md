# Verification of the 2026-09-07 review implementation

Verified on 2026-09-17 against `5c9eb2eb4a24ac61ec037073d45286a41d36b6fd`, matching `origin/main`. The working tree was initially clean. This verification changes documentation only.

The original [review](../../trashbin/documentation/2026-09-07-code-review.md) and [tracker](../../trashbin/documentation/2026-09-07-review-tracker.md) were moved out of `docs/maintenance/` when the campaign was archived. The tracker contains **66 done tasks and one not reproducible task**; every referenced implementation commit is an ancestor of the reviewed head.

**The campaign implemented most of its scoped work, but the full review is not completely resolved.** Existing checks all pass. A new endpoint case still produces a computed leg crossing land, and several original findings were omitted from the tracker or deferred without a follow-up row. The archive's “none open” statement describes its task statuses, not complete resolution of the original report.

The findings and verification tables below describe the original reviewed head. Subsequent implementation status is recorded under each finding. IV-1 through IV-3 are resolved; IV-4 through IV-8 remain open.

## Findings and follow-up status

### IV-1 — P1: endpoint snapping can still produce a route through land

- Related review/steps: E1; 1.7 and 1.17.
- Code: [isochrone.ts](../../engine/src/routing/isochrone.ts), lines 101–120 and 241–245.
- `snap()` selects a sea grid node without checking the connection from the exact endpoint. After the graph search, the path replaces the snapped endpoints with the requested coordinates. Graph-edge validation and collinear-shortcut validation do not validate these replacement legs; a two-point path bypasses the thinning loop entirely.
- Reproduced with a synthetic 0.01° mask containing a continuous north–south wall at longitude −5.27°, a 0.1° routing grid, start `(49.3, -5.26)` and finish `(49.3, -5.4)`. Both requested endpoints are sea. The start snaps to the west of the wall. The result contains only the two requested waypoints and `segmentCrossesLand(mask, first, last) === true`.
- Existing eight-direction comb-mask and short graph-edge regressions pass. They do not cover this endpoint-to-grid connection.
- Required follow-up: validate endpoint connections during acquisition, preserve required connection nodes, and validate the final emitted legs after coordinate rounding. Add both start and finish regression cases. Do not describe the router as preventing all mask crossings while this remains open.

**Resolved in `0b823ec` — [CI 35278728323 passed](https://github.com/deepregatta/passage/actions/runs/35278728323):** endpoint acquisition now checks the exact endpoint-to-grid segment for every candidate, including an initially selected sea node. The reconstructed path retains its connection nodes before checked thinning, the search uses grid coordinates rounded to output precision, and every final emitted leg is checked again after rounding. A failed final check rejects the route. The original reproduction below now throws `No route found`.

Ten new regression cases cover both endpoint directions for closed/gapped walls, a shared connection node around an island, endpoints rounded onto land, and an enclosed endpoint with no accessible grid node. Eight cases were observed failing before the fix; the original wall-gap test now also checks every emitted leg. Local validation: 303 engine tests, 428 viewer tests, 430 Python tests, 50 desktop/mobile browser tests, lint, Ruff check/format, and the Pages build pass; demo regeneration leaves tracked artifacts unchanged. These checks retain the existing mask coverage and approximately 0.4 nm segment-sampling limits; they do not certify navigation safety. Other findings remain outside this change.

### IV-2 — P2: Météo-France explicit-month validity can jump to the wrong year

- Related review/step: P10, explicitly deferred in 1.2; no subsequent task closes it.
- Code: [warnings_mf.py](../../analysis/src/deepweather_analysis/warnings_mf.py), lines 192–209.
- `_resolve_day(31, 'AOUT', 18, 0, datetime(2026, 9, 1, tzinfo=UTC))` returns `2027-08-31T18:00:00Z`, instead of the nearby previous day. With an issue date of 2026-01-01 and `31 DECEMBRE`, it returns December 2026 instead of December 2025.
- The parser assumes every earlier explicit month belongs to the following year. It cannot distinguish a recently elapsed validity date from a future one. This can corrupt active/expired warning selection; the separate seven-day issue-age filter does not correct the date.
- Required follow-up: resolve candidate dates around the issue time using a bounded validity window, including previous-month and previous-year cases. Existing tests cover forward rollover only.

**Resolved in `f9a2d54` — [CI 35280904719 passed](https://github.com/deepregatta/passage/actions/runs/35280904719):** `_resolve_day()` now chooses the nearest valid candidate within an inclusive ±7-day window around issue time, as proposed by P10. Explicit months consider the previous, current, and next year; omitted months consider adjacent months across year boundaries. Impossible dates, unknown month names, and dates outside the window return no inferred date, preserving the existing low-confidence parse and 24-hour fallback in `fetch_live()`.

Twenty new regression cases cover previous-month/year expiry, forward month/year rollover, leap day, both window boundaries, invalid/distant dates, ranges spanning month/year boundaries, and mocked CSV expiry filtering while issue age is still below seven days. Thirteen failed before the fix. Local validation passes: 80 Météo-France tests and all 450 Python tests under `TZ=Europe/Paris` (12 existing upstream deprecation warnings), 303 engine tests, 428 viewer tests, lint, Ruff check/format, and the Pages build. Demo regeneration leaves tracked artifacts unchanged. Hosted JavaScript and Python CI jobs passed. The feed's existing one-day expiry retention grace is unchanged.

### IV-3 — P2: “Share this analysis” does not identify or reopen the analysis

- Related review: V17; absent from the tracker.
- Code: [FooterActions.jsx](../../viewer/src/components/FooterActions.jsx), lines 199–217; [routes.js](../../viewer/src/lib/routes.js).
- The action copies the title and current page URL. `#brief/story` identifies a view, with no snapshot identifier or artifact payload.
- Browser reproduction: open the served example through My briefings, click Share this analysis (the button reports Link copied), then open its `/#brief/story` URL in a new tab. The new tab displays **“No analysis open.”** This also fails for a served snapshot; local IndexedDB briefings additionally cannot be read by another browser.
- Required follow-up: give served snapshots a resolvable identity in shared URLs; disable or accurately relabel sharing for local-only briefings until a supported transfer mechanism exists.

**Resolved in `d32ae61` — [CI 35282042695 passed](https://github.com/deepregatta/passage/actions/runs/35282042695):** sharing now copies a URL containing the served snapshot ID (`#brief/story?snapshot=<id>`), preserving the English/French path. Opening it loads that frozen analysis from the served artifact directory, including in another browser, without substituting a browser-local copy. Snapshot IDs are validated before fetching. Missing or invalid shared snapshots show a translated error; failed clipboard writes no longer fail silently. The snapshot's own demo flag preserves the example treatment on a fresh load without a briefing-list manifest.

Local-only briefings have a disabled Share action and a visible explanation that they cannot be shared by link. Sharing is also disabled while loading, after a load error, or without an open analysis. This adds no upload or transfer mechanism; served links depend on continued availability of the named artifacts.

Ten new unit/integration regressions cover copied identity and reopening, local-only/absent analyses, conflicting local copies, unavailable/invalid IDs, French paths, navigation during loading, and clipboard failure. The initial eight cases failed before implementation. Eight desktop/mobile browser cases exercise real clipboard reads, independent browser contexts, EN/FR reopening, reload/Back navigation, local IndexedDB briefings, and unavailable links. Local checks pass: 303 engine tests, 438 viewer tests, all 58 desktop/mobile browser tests (unchanged screenshot baselines), lint, and the Pages build. The served demo index matches the committed fixture byte-for-byte. Hosted JavaScript and Python CI jobs passed. Other IV findings remain outside this change.

### IV-4 — P2: negative UTC offsets still fail in the engine

- Related review: §4.2 `eta.ts`; not covered by the Python-only UTC consolidation in 1.3.
- Code: [eta.ts](../../engine/src/eta.ts), lines 122–124.
- These inputs represent the same instant: `2026-09-17T10:00:00Z`, `2026-09-17T12:00:00+02:00`, and `2026-09-17T05:00:00-05:00`. `parseUtc()` accepts the first two and throws `Invalid UTC timestamp` for the third because it appends `Z` to a negative-offset timestamp.
- Required follow-up: recognize both offset signs and retain the explicit naive-as-UTC policy; cover the public scheduling/analysis path as well as the parser.

### IV-5 — P2: decoded forecast tiles still have no memory bound

- Related review: §4.2 decoded-tile retention; omitted from the scoped 2.8 acceptance criteria.
- Code: [tileStore.ts](../../engine/src/forecast/tileStore.ts), lines 138–164; the application keeps this store in [forecastStore.js](../../viewer/src/lib/forecastStore.js).
- Every decoded tile is retained in the layer's `decoded` map for the store lifetime. The new IndexedDB quota/metadata policy limits persisted compressed bytes, not these decoded arrays.
- A synthetic probe requested 12 distinct weather tiles consecutively from one store. All 12 remained in `layers.get('weather').decoded` after the final request. There is no eviction or release policy for decoded entries.
- Required follow-up: bound decoded storage by bytes or a documented tile budget while preserving in-flight sharing and current consumers. This verification did not force an out-of-memory crash or measure a real-device failure threshold.

### IV-6 — P2: UK validity parsing still depends on global timestamp order

- Related review: §4.1; not part of the four gale-form fixes in 1.1.
- Code: [warnings_uk.py](../../analysis/src/deepweather_analysis/warnings_uk.py), lines 72–76.
- In the committed shipping-forecast fixture, the parsed issue time is 2026-07-17 09:30Z and validity is July 17 11:00Z through July 18 11:00Z. Prepending an unrelated `Page updated 09:00 (UTC+1) on Fri 17 Jul 2026` paragraph changes these to an issue time of July 18 11:00Z and validity of July 17 08:00Z through July 17 11:00Z.
- Required follow-up: associate timestamps with their labeled sections and reject inconsistent intervals. This is a synthetic layout-change reproduction, not evidence that the live Met Office page currently has this extra timestamp.

### IV-7 — P3: the skip link overwrites the application's route

- Related review: V12; absent from the tracker. Normal navigation now uses `pushState`, so that part of V12 is implemented.
- Code: [Shell.jsx](../../viewer/src/components/Shell.jsx), line 31.
- Browser reproduction: activate Skip to briefing content while viewing `#brief/story`. The URL becomes `#main-content`; reloading then opens `#plan/planner`, because that fragment is not a recognized application route.
- Required follow-up: focus the main content without changing the routing fragment, with keyboard and reload coverage.

### IV-8 — P3: one-point synoptic tracks still crash when requested

- Related review: §4.1 `min_track_steps = 1`; not addressed by 5.6's fractional replay-offset work.
- Code: [synoptic/track.py](../../analysis/src/deepweather_analysis/synoptic/track.py), lines 149–156.
- `track_systems([[{'kind': 'low', 'lat': 50, 'lon': -5, 'center_hpa': 995, 'closed_contour': True}]], [0], min_track_steps=1)` raises `IndexError: list index out of range` at `points[-2]`.
- Required follow-up: reject unsupported minimums explicitly or emit a one-point track with unknown motion. Current repository callers use the default of two; this is a latent API defect.

## Verification results

| Check run on the reviewed head | Result |
|---|---|
| Tracker inventory and commit ancestry | 67 tasks; 66 done, one not reproducible; all 67 referenced commits present in HEAD history |
| `npm test` | Engine build and test typecheck pass; 293 engine tests in 29 files and 428 viewer tests in 27 files pass |
| `TZ=Europe/Paris uv run pytest -q` in `analysis/` | 430 pass; 12 upstream NumPy/xarray deprecation warnings |
| `npm run lint` | Pass, zero warnings |
| Python Ruff check / format check | Pass; 71 files formatted |
| Ruff check of `scripts/upload-prepared-run.py` | Pass |
| `npm run build:pages` | Pass; both EN/FR entry points preload React while charts/maps remain lazy |
| Emitted chart chunks | ECharts 371.77 kB raw; zrender 184.18 kB raw, separate lazy chunk |
| `npm audit --json` | Zero vulnerabilities |
| `node scripts/build-demo-snapshots.mjs` | Pass; tracked demo fixtures and engine goldens unchanged |
| `npm run test:e2e -w viewer -- --workers=1` | 50/50 pass, desktop and mobile, including EN/FR responsive checks; screenshot baselines unchanged |
| Independent browser probes | V17 sharing and V12 skip-link failures reproduced in the in-app browser |
| Hosted CI for reviewed head | [CI 35200532142](https://github.com/deepregatta/passage/actions/runs/35200532142) completed successfully on `5c9eb2e` |

The browser suite used the existing viewer-demo server on port 5174; its served data index was compared byte-for-byte with the committed demo index before the run. Provider and pipeline suites use recorded or synthetic inputs/mocks. These results do not certify current live provider availability, production deployment configuration, or R2 contents. Historical performance speedup ratios were not rebenchmarked.

## Tracker reconciliation

This table records the implementation groups checked through current source/configuration, commit history, and the fresh test/build runs. Passing tests support the scoped behavior; they do not establish that every original robustness concern was assigned a task. Outstanding counterexamples are listed above.

| Tracker tasks | Current implementation and verification |
|---|---|
| 0.1, 2.11 | Dependency remediation present; fresh audit reports zero vulnerabilities |
| 0.2–0.3 | Unused-symbol compiler flags and test typechecking enabled; both run in `npm test` |
| 0.4 | `jsonschema` is a runtime dependency in the Python manifest |
| 0.5 | Stale Open-Meteo provider entries removed; provider contract tests pass |
| 0.6, 0.10 | Node 24 alignment, viewer predev engine build, updated CI action versions present; current CI green |
| 0.7–0.9 | Recorded cleanup commits present; build/lint gates pass; required legacy fixture model identifiers intentionally retained |
| 0.11 | Updated example-flow browser expectations pass at both viewports |
| 1.1–1.3 | Four UK gale forms, MF row degradation/cancellation filtering, and shared Python UTC parsing present and tested; P10 and UK timestamp robustness remain as IV-2/IV-6 |
| 1.4–1.5 | All regional zone keys are flattened; tides resolve through the route index with no implicit Channel fallback; tests pass |
| 1.6 | Tile-store/IndexedDB initialization retry regressions pass |
| 1.7, 1.17 | Collinear thinning and all graph-edge land checks present; their tests pass, but endpoint substitution still fails IV-1 |
| 1.8 | Emulated warning badge, removed fake alternative-route overlay, and metadata-derived model panel present; honesty/browser tests pass |
| 1.9 | Departure instant comparison, insecure-context ID fallback, and drawn-speed validation regressions pass |
| 1.10–1.11 | Snapshot sequence guards, playback lifecycle, storage recovery, optional-fetch and request guards present; tests pass |
| 1.12 | Route-relative geography and shared metadata-derived next-run estimation present; prose/golden tests pass |
| 1.13 | CLI flag parsing, interrupted snapshot detection, scan failure reasons, minimum visibility ranking and singleton-grid sampling tests pass |
| 1.14, 1.18 | Verification persistence, finite synoptic means, committed ORC fixture and numeric/string angle-key compatibility tested |
| 1.15 | Demo regeneration is byte-identical on this head |
| 1.16 | Historical not-reproducible disposition retained; current shared basemap uses OpenStreetMap. No new provider availability claim |
| 2.1–2.2 | Chunk preload assertion passes for EN/FR; ECharts core registration and lazy ESM adapter present; charts render in browser checks |
| 2.3 | IndexedDB bytes and metadata stores are separate; quota and migration tests pass; distinct decoded-memory issue is IV-5 |
| 2.4–2.5 | Playback subscriptions moved into moving leaves; English localizer skips observation and French processes mutations; current regressions pass. Historical profiler numbers not rerun |
| 2.6–2.7 | Parallel reads, binary-search/scalar sampling and per-tile time indices present; forecast/routing/golden regressions pass |
| 2.8 | Timeout/retry/cache modes, gzip-byte hash validation, corrupt-key repair and in-flight deduplication present; transport/store tests pass |
| 2.9–2.10 | Native-node sampling, indexed snapshot listing and revision-keyed source caches present; compatibility tests pass |
| 3.1–3.4, 3.6 | Translation corpus/hygiene, leak fixes, French prerendered body and diagnostic cleanup present; tests pass |
| 3.5 | Design document exists; contract/runtime message-ID migration is explicitly still a proposal |
| 3.7–3.10 | Computed-result invalidation, responsive tables/charts and French fragment boundary fixes tested; 390px EN/FR browser checks pass |
| 4.1–4.4 | Shared formulas/thresholds and extracted findings/planner/briefing modules present; golden/compatibility suites pass |
| 4.5–4.6 | Zero-warning ESLint/React Hooks CI gate and shared viewer helpers/palette present |
| 4.7–4.8 | Shared Python helpers and reduced import-time side effects tested |
| 4.9 | Broader config/artifact contracts, store lifecycle, wording and non-vacuous browser assertions present; uncovered cases above show the sweep was not exhaustive |
| 5.1–5.2 | Locked atomic local pointer update and content-aware/per-family uploader retention present; failure/concurrency/mocked-S3 regressions pass |
| 5.3 | Explicit fixed-region disclosure implemented; regional window expansion and Genoa-box correction were intentionally not implemented |
| 5.4 | Persistent MF ETag/source caching, 48-snapshot retention, NWS Actual filtering and bounded BOM retries present and tested |
| 5.5 | Observation/tide partial tolerance, provider-aware degradation and QLD caching tested |
| 5.6 | Spatial/time coverage guards, unsorted axes, monthly ERA5 requests, fractional replay and route-derived scenario warnings tested; IV-8 remains separate |
| 5.7 | Content-versioned filenames and rewritten parent references present; uploader/viewer tests pass. Legacy saved references are intentionally not retroactively repaired |
| 5.8 | In Situ daily-file retention and current-day refetching tested |

Other original risks still visible in source/configuration should receive an explicit disposition instead of being inferred closed: UK area matching remains substring-based; routing still uses unvalidated `Date.parse`; the currents fetcher retains the configurable default two-second post-success delay; Playwright still reuses any server at port 5174; production forecast-base configuration remains environment-dependent; `runsBase()` still depends on prior prepared-run initialization. They were not all reproduced as current user-visible failures here. CI still does not run `npm audit` or lint the uploader outside `analysis/`, although both checks passed when run manually during this verification.

The deliberate boundaries are also unchanged: message IDs are design-only; fixed-region synoptic support is disclosed rather than expanded; live warnings still lack a production publisher in browser analysis. These are not failed implementations of their narrower tracker tasks.

## Reproduce the remaining land-crossing case

From the repository root, run `npm run build -w engine`, then:

```bash
node --input-type=module <<'JS'
import { computeRoute } from './engine/dist/routing/isochrone.js';
import { isLand, segmentCrossesLand } from './engine/dist/routing/landmask.js';
const polar = {
  schema_version: 1, polar_id: 'probe', label: 'Synthetic test polar',
  tws_kt: [6, 12, 20], twa_deg: [45, 90, 135, 180],
  speeds_kt: [[3.2, 4.5, 4.2, 3.5], [5, 6.5, 6.8, 5.5], [5.8, 7.2, 7.8, 6.9]],
  source: { kind: 'generic' },
};
const times = Array.from({ length: 49 }, (_, h) =>
  new Date(Date.parse('2026-07-20T00:00:00Z') + h * 3600000).toISOString());
const windGrid = {
  schema_version: 1, kind: 'wind10m', run_id: 'synthetic-verification',
  generated_at: times[0], lat0: 49, lon0: -6, dlat: .55, dlon: .75,
  nlat: 5, nlon: 9, time_axis: times,
  u_kt: Array(49 * 45).fill(0), v_kt: Array(49 * 45).fill(12),
  source: { mode: 'synthetic' },
};
const nlat = 61, nlon = 81, land = Array(nlat * nlon).fill(0);
for (let i = 0; i < nlat; i++) land[i * nlon + 23] = 1;
const mask = {
  schema_version: 1, kind: 'land_mask', lat0: 49.1, lon0: -5.5,
  dlat: .01, dlon: .01, nlat, nlon, land,
};
const start = { lat: 49.3, lon: -5.26 }, finish = { lat: 49.3, lon: -5.4 };
const { route } = computeRoute({
  start, finish, departureUtc: times[0], polar, windGrid,
  landMask: mask, resolutionDeg: .1,
});
console.log({
  startIsLand: isLand(mask, start.lat, start.lon),
  finishIsLand: isLand(mask, finish.lat, finish.lon),
  waypoints: route.waypoints,
  crossingLegs: route.waypoints.slice(1).flatMap((to, i) =>
    segmentCrossesLand(mask, route.waypoints[i], to) ? [i] : []),
});
JS
```

Observed on the reviewed head: both land checks are `false`, two waypoints are returned, and `crossingLegs` is `[0]`. A corrected implementation must reject this disconnected route or produce a fully checked sea path.
