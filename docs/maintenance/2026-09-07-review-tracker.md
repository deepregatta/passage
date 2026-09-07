# Review 2026-09-07 — step tracker

Companion to [2026-09-07-code-review.md](2026-09-07-code-review.md) (item ids E*, V*, P*, F* and section numbers refer to that report).
Baseline: commit `08de648`. Rule: **one step per agent session, one commit per step.**
When every step is done or deliberately dropped, move both files to `trashbin/documentation/`.

## Session protocol (paste as the first message of every fresh session)

```
Read docs/maintenance/2026-09-07-code-review.md and docs/maintenance/2026-09-07-review-tracker.md.
Work ONLY on step <ID> "<title>" from the tracker. Do not start other steps; if you notice
adjacent problems, add a line under "Noticed during steps" in the tracker instead of fixing them.

1. Re-verify first: confirm the finding still reproduces at HEAD (the codebase has moved since
   commit 08de648). If it does not, set the step status to "not reproducible" with the evidence,
   commit the tracker, and stop.
2. For bug steps write the failing regression test first, then the fix. For refactor steps the
   engine goldens and the demo fixture must stay byte-identical.
3. Guardrails before committing:
   - npm test                          (engine build + engine and viewer unit suites)
   - cd analysis && uv run pytest -q && uv run ruff check . && uv run ruff format --check .
   - node scripts/build-demo-snapshots.mjs, then `git status viewer/test/fixtures/demo` must be
     clean — unless the step says "prose changes expected"; then: UPDATE_GOLDEN=1 npm -w engine
     test, regenerate the demo, update viewer/src/i18n.js FR patterns for every changed English
     sentence, and show me the before/after of each changed sentence.
   - viewer changes: verify in the browser with the viewer-demo launch config and paste a screenshot.
4. Update the tracker row for this step (Status, Commit, Notes). Commit ONLY the files this step
   touched plus the tracker, message "review-2026-09-07 <ID>: <title>", push to main.
5. Final report: what changed, how you verified it, what you noticed but did not do.
```

Status values: `todo` · `in progress` · `done` · `not reproducible` · `dropped` (say why).

## Human checklist per step (before starting the next session)

- Read the commit diff; confirm only the step's files changed (plus the tracker).
- Run `npm test` and `cd analysis && uv run pytest -q` yourself once per phase boundary, plus `npm run test:e2e` and `npm run build:pages` (neither runs in CI).
- Check the tracker row is filled and "Noticed during steps" was updated, then re-triage those notes into new steps or drop them.
- If a step went wrong: `git revert <commit>` and mark the row `todo` again with a note.

## Ordering rules

- Phase 0 before anything else (0.2 and 0.3 give the type gates every later step relies on).
- 1.7 (router) before 4.x refactors of routing; 1.12 (prose) before 3.x i18n work; 2.1 (chunking) before 2.2 (measure the win).
- Steps that change engine wording (1.8, 1.12, 3.2) are the only ones allowed to update goldens and the demo fixture.
- Uncommitted work from other sessions must be committed or stashed before an agent session starts (agents commit to main).

---

## Phase 0 — zero-risk hygiene

### 0.1 Dependency advisories
- Items: §1 npm audit (postcss, browserslist, nanoid, fast-uri, undici)
- Do: `npm audit fix`; confirm the lockfile diff touches dev deps only; `npm test`.
- Done when: `npm audit` reports 0 high; all suites green.
- Status: todo · Commit: — · Notes:

### 0.2 Engine unused-symbol gate + engine dead code
- Items: §7.1 tsconfig flags; §7.2 engine list (E10 `worstDet`, diff.ts unused `previous`, tileStore unused imports, `SQUALL_LABEL`, legacy `VIS_MODELS` names, briefing `generated_at ??` fallback, tides.ts self-lookup)
- Files: engine/tsconfig.json, engine/src/{briefing,diff,findings}.ts, engine/src/forecast/tileStore.ts, engine/src/hazards/{convective,tides}.ts
- Done when: `noUnusedLocals`/`noUnusedParameters` on and `npm run build -w engine` clean; goldens byte-identical.
- Status: todo · Commit: — · Notes:

### 0.3 Type-check the engine tests
- Items: §7.1 (tsconfig.test.json), §8 engine row; fixes for routing.test.ts `stepMinutes`, landmaskPack.test.ts, tileStore.test.ts `Ajv2020.default`
- Files: engine/tsconfig.test.json (new), engine/package.json (`typecheck` script), package.json root `test`, .github/workflows/ci.yml, the three test files
- Done when: `npm run typecheck -w engine` passes and runs in CI.
- Status: todo · Commit: — · Notes:

### 0.4 `jsonschema` as a runtime dependency
- Items: P4
- Files: analysis/pyproject.toml, analysis/uv.lock
- Done when: `uv sync --no-dev` then `uv run --no-sync python -c "import deepweather_analysis.tides"` succeeds; pytest green.
- Status: todo · Commit: — · Notes:

### 0.5 Remove stale Open-Meteo providers
- Items: V16; analysis/tests/test_contracts_and_providers.py assertions
- Files: config/providers.json, analysis/tests/test_contracts_and_providers.py
- Done when: Settings page lists no `openmeteo_*`; pytest green; consider adding a `forecast_tiles` entry so the page still explains the wind source.
- Status: todo · Commit: — · Notes:

### 0.6 Node version + dev workflow
- Items: §7.1 (engines/.nvmrc, CI node-version, stale engine/dist)
- Files: package.json (`engines`), .nvmrc, .github/workflows/ci.yml, viewer/package.json (`predev`) or viewer/vite.config.js alias to engine/src
- Done when: fresh clone → `npm install && npm run dev -w viewer` works without a manual engine build.
- Status: todo · Commit: — · Notes:

### 0.7 Viewer dead code
- Items: §7.2 viewer list (VerdictBanner.jsx, V15 `VITE_DW_MODE` branch, `.section-rule`, unused `buildOption` export)
- Files: viewer/src/components/VerdictBanner.jsx (delete), viewer/src/pages/Briefing.jsx, viewer/src/index.css, viewer/src/components/EnsemblePlume.jsx
- Done when: grep proves each symbol unused before deletion; viewer tests + e2e screenshots unchanged.
- Status: todo · Commit: — · Notes:

### 0.8 Analysis dead code and unused noqa
- Items: §7.2 analysis list (environment_grid dead methods, `write_observations`, `CACHE_MAX_AGE_HOURS`, `STEPS` alias, numpy ImportError guards, `ruff --select RUF100`, stale `tests/__pycache__`)
- Done when: each deletion justified by grep; pytest + ruff green. Leave `write_verification` for 1.14.
- Status: todo · Commit: — · Notes:

### 0.9 Stale comments and internal names
- Items: §7.4 (milestone tags, "brief §N", Supabase, Open-Meteo mirrors, `openmeteo-*` fixture header, FooterActions `race_*` identifiers)
- Rule: comments and internal identifiers only; **no user-facing copy** (that is Phase 3).
- Done when: `grep -rnE "\bM[0-9]{1,2}\b|Supabase" engine/src viewer/src` is empty or each remaining hit is justified.
- Status: todo · Commit: — · Notes:

## Phase 1 — bugs (regression test first)

### 1.1 UK gale warning forms
- Items: P1
- Files: analysis/src/deepweather_analysis/warnings_uk.py, analysis/tests/test_warnings_uk.py (+ fixtures for: list form, "all areas", "all areas except X", "no warnings of gales")
- Done when: the four forms parse correctly and "all areas except Trafalgar" yields a bulletin for every route zone not named.
- Status: todo · Commit: — · Notes:

### 1.2 Météo-France degrade path and cancellations
- Items: P2, P3 (optionally P10)
- Files: analysis/src/deepweather_analysis/warnings_mf.py, analysis/tests/test_warnings_mf.py
- Done when: a malformed row degrades to `parse-degraded`/`unavailable` instead of raising; "FIN D'AVIS…" never publishes as an active gale.
- Status: todo · Commit: — · Notes:

### 1.3 One UTC parser for the package
- Items: P5 (tides.py, scenarios.py, warnings_us.py, warnings_meteoalarm.py, plus the other ISO parsers listed)
- Files: new analysis/src/deepweather_analysis/timeutil.py, callers
- Done when: naive input is treated as UTC everywhere; test runs with `TZ=Europe/Paris`.
- Status: todo · Commit: — · Notes:

### 1.4 Route zones for every region
- Items: E6
- Files: engine/src/cli.ts, viewer/src/lib/browserAnalysis.js, test over every route in config/route-zones.json
- Done when: US/Med/AU routes produce their own zone ids; the "all bulletin zones" fallback applies only to user-drawn routes.
- Status: todo · Commit: — · Notes:

### 1.5 Per-route tides
- Items: E7
- Design first (2 lines in Notes): a `tides/index.json` route→artifact map published by the factory, or `artifact_name` carried in the route doc.
- Files: engine/src/cli.ts, viewer/src/lib/browserAnalysis.js, analysis tides publisher, viewer/public/data/tides
- Done when: a non-Channel route never loads channel.json and coverage reports `tidal_gates: not_assessed` when no tide artifact exists.
- Status: todo · Commit: — · Notes:

### 1.6 Init poisoning (store + local snapshots)
- Items: E2, V11
- Files: engine/src/forecast/tileStore.ts, viewer/src/lib/localSnapshots.js, engine/test/tileStore.test.ts
- Done when: a transport that fails once then succeeds yields a working store on the second `init()`; `localSnapshots.exists()` returns false on IndexedDB failure.
- Status: todo · Commit: — · Notes:

### 1.7 Router: emitted legs must not cross land
- Items: E1
- Files: engine/src/routing/isochrone.ts, engine/test/routing.test.ts (comb mask from report §1)
- Done when: new test asserts no emitted leg crosses the mask and passes; existing routing tests and demo fixture unchanged.
- Status: todo · Commit: — · Notes:

### 1.8 Honesty: emulated badge, fake overlay, models panel
- Items: V5, V4, V6 — **prose changes expected** (UI copy → i18n patterns, e2e screenshots)
- Files: viewer/src/components/BulletinPanel.jsx, SynopticHero.jsx, viewer/src/pages/{Briefing,Planner}.jsx, viewer/src/i18n.js
- Done when: demo bulletin shows an emulated badge; "Compare safer departure" removed; Models panel derived from `findings.coverage` + `inputs.forecast_tiles`.
- Status: todo · Commit: — · Notes:

### 1.9 Planner input bugs
- Items: V2, V3, V13
- Files: viewer/src/pages/Planner.jsx, viewer/src/lib/format.js, new viewer/test/departureComparison.test.jsx
- Done when: selected-departure outline renders; "Check this passage" works over plain http; empty/zero speed is rejected.
- Status: todo · Commit: — · Notes:

### 1.10 Snapshot open lifecycle and playback
- Items: V7, V8
- Files: viewer/src/stores/{appStore,playbackStore}.js, viewer/src/components/TimeRuler.jsx, viewer/src/pages/{Snapshots,Briefing}.jsx, new store tests
- Done when: two rapid opens show the last one; `loadError` is visible on the briefing/snapshots pages; playback resets on open and stops on unmount.
- Status: todo · Commit: — · Notes:

### 1.11 Storage and fetch guards
- Items: V9, V10, V14, V18
- Files: viewer/src/pages/{Settings,Changes,Verification}.jsx, viewer/src/components/{RouteMap,SynopticCompare,SynopticHero,EnsemblePlume}.jsx, viewer/vite.config.js, scripts/serve-pages.mjs
- Done when: corrupt localStorage draft, offline fetch, empty track/legs, malformed URL all fail soft.
- Status: todo · Commit: — · Notes:

### 1.12 Briefing prose: geography and next run
- Items: E3, E4 — **prose changes expected** (goldens, demo fixture, FR patterns)
- Files: engine/src/{briefing,diff,analyze}.ts, engine/test goldens, viewer/src/i18n.js, viewer/test/fixtures/demo
- Done when: position phrase is route-relative; one next-run helper fed by `store.describe()`; briefing and change story agree.
- Status: todo · Commit: — · Notes:

### 1.13 Small engine fixes
- Items: E5, E8, E9, E11, E12
- Files: engine/src/{cli,io/node,window,findings,grids}.ts + tests (new engine/test/window.test.ts)
- Done when: each item has a unit test; `scanDepartures` returns skipped-candidate reasons and the Planner shows them.
- Status: todo · Commit: — · Notes:

### 1.14 Small analysis fixes
- Items: P6, P7, P9
- Files: analysis/src/deepweather_analysis/{cli.py,synoptic/regimes.py}, analysis/tests/test_polars.py + a committed 20-record ORC sample fixture
- Done when: `verify` writes the verification document; NaN box returns None; polar tests run in CI without the full ORC db.
- Status: todo · Commit: — · Notes:

## Phase 2 — performance (behaviour-preserving)

### 2.1 Chunk graph
- Items: F1
- Files: viewer/vite.config.js, new scripts/check-dist.mjs (asserts dist/index.html preloads neither vendor-echarts nor vendor-leaflet), root package.json `build:pages`
- Done when: assertion passes; `npm run build -w viewer` output shows React in vendor-react.
- Status: todo · Commit: — · Notes:

### 2.2 ECharts core
- Items: F2
- Files: viewer/src/components/lazy/EChartsLazy.jsx, chart components, viewer/vite.config.js (`chunkSizeWarningLimit` removed)
- Done when: vendor-echarts chunk well under 500 KB raw; all charts render (screenshots at both viewports).
- Status: todo · Commit: — · Notes:

### 2.3 Tile cache metadata store
- Items: V1, F3
- Files: viewer/src/lib/tileCache.js, new viewer/test/tileCache.test.js (fake-indexeddb)
- Done when: no `getAll()` of tile bytes; `get()` does not rewrite bytes; budget from `navigator.storage.estimate()`; DB version bump migrates or clears old entries.
- Status: todo · Commit: — · Notes:

### 2.4 Playback subscriptions
- Items: F4
- Files: viewer/src/components/{RouteMap,RouteTimeline}.jsx, viewer/src/pages/Briefing.jsx
- Done when: React DevTools profiler shows only the cursor marker / NOW line re-rendering per frame.
- Status: todo · Commit: — · Notes:

### 2.5 Localiser scope
- Items: F5
- Files: viewer/src/i18n.js, viewer/test/i18n.test.js
- Done when: no DOM walk in EN; FR localises only mutated subtrees; existing i18n tests green.
- Status: todo · Commit: — · Notes:

### 2.6 Parallel layer and manifest reads
- Items: F6
- Files: engine/src/analyze.ts, engine/src/forecast/tileStore.ts
- Done when: goldens byte-identical; progress messages preserved.
- Status: todo · Commit: — · Notes:

### 2.7 Sampler and mosaic hot paths
- Items: F7, F8
- Files: engine/src/grids.ts, engine/src/forecast/tileStore.ts
- Done when: grids/tileStore tests green; routing test timing not worse.
- Status: todo · Commit: — · Notes:

### 2.8 Transport resilience
- Items: §4.2 (timeout/retry, cache modes, fnv64 self-heal, in-flight de-dupe)
- Files: engine/src/forecast/{httpTransport,tileStore}.ts + tests
- Done when: a hung fetch times out with a clear error; a corrupt cached tile is evicted and refetched once; concurrent requests share one fetch.
- Status: todo · Commit: — · Notes:

### 2.9 grids_prep direct sampling
- Items: F9
- Files: analysis/src/deepweather_analysis/grids_prep.py, tests
- Done when: output identical (or within 0.01 kt) to the current method on the test fixture; runtime measured before/after in Notes.
- Status: todo · Commit: — · Notes:

### 2.10 Remaining caches
- Items: F10, F11
- Files: viewer/src/lib/localSnapshots.js, analysis warnings_mf.py, polars.py
- Status: todo · Commit: — · Notes:

## Phase 3 — localisation

### 3.1 Coverage test (with allowlist)
- Items: §6, §8 viewer i18n row
- Do: test walks src/**/*.jsx string literals + every golden/demo briefing sentence through `translateText`; identity results fail unless listed in an explicit allowlist file. Land with the allowlist full.
- Status: todo · Commit: — · Notes:

### 3.2 Fix the leaks
- Items: §6 untranslated list — **prose changes expected**
- Done when: allowlist from 3.1 is empty.
- Status: todo · Commit: — · Notes:

### 3.3 French no-JS body
- Items: §6 `/fr/index.html`
- Files: viewer/scripts/prerender-fr.mjs, viewer/src/metadata.js, viewer/test/prerender-fr.test.js
- Status: todo · Commit: — · Notes:

### 3.4 Catalogue hygiene
- Items: §6 stale/duplicate keys; single mechanism for Verification/CaseStudy
- Status: todo · Commit: — · Notes:

### 3.5 Design: message ids for engine prose
- Items: §6 structural risk
- Do: write docs/maintenance/briefing-message-ids.md (schema change to contracts/briefing.schema.json, migration for old snapshots). Implementation becomes new steps after review.
- Status: todo · Commit: — · Notes:

## Phase 4 — structure (goldens byte-identical unless stated)

### 4.1 Shared engine formulas and thresholds — §7.3 engine list
- Status: todo · Commit: — · Notes:
### 4.2 Split findings.ts — §7.4
- Status: todo · Commit: — · Notes:
### 4.3 Split Planner.jsx — §7.4
- Status: todo · Commit: — · Notes:
### 4.4 Split Briefing.jsx — §7.4
- Status: todo · Commit: — · Notes:
### 4.5 ESLint + react-hooks (fix what it finds; split if large) — §7.1
- Status: todo · Commit: — · Notes:
### 4.6 Viewer palette module, profile-draft helpers, duplicate helpers — §7.3 viewer list
- Status: todo · Commit: — · Notes:
### 4.7 Analysis consolidation (geo, constants, checksum, nc helpers, merges, slugify, User-Agent) — §7.3 analysis list
- Status: todo · Commit: — · Notes:
### 4.8 Analysis import-time side effects — §7.4
- Status: todo · Commit: — · Notes:
### 4.9 Test-gap sweep (engine window/contracts loop; viewer store tests; vacuous e2e assertions) — §8
- Status: todo · Commit: — · Notes:

## Phase 5 — pipeline

### 5.1 Atomic `latest.json` helper — P15
- Status: todo · Commit: — · Notes:
### 5.2 Uploader content hash + per-family pruning — P8
- Status: todo · Commit: — · Notes:
### 5.3 Route-aware synoptic windows or explicit "Channel-only prepared run" coverage disclosure — §4.1
- Status: todo · Commit: — · Notes:
### 5.4 Warnings feed robustness (ETag, output pruning, NWS status filter, FTP retry) — §4.1
- Status: todo · Commit: — · Notes:
### 5.5 Observations and tides tolerance — P11, §4.1 tides bullets
- Status: todo · Commit: — · Notes:
### 5.6 Verification and grid edge cases — P12, P13, P14, P16
- Status: todo · Commit: — · Notes:

---

## Noticed during steps
(agents append here: `- <step> — <file:line> — <one line>`)

## Decisions
(record design choices made in steps 1.5, 3.5, 5.3 here)
