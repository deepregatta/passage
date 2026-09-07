# Review 2026-09-07 — step tracker

Companion to [2026-09-07-code-review.md](2026-09-07-code-review.md) (item ids E*, V*, P*, F* and section numbers refer to that report).
Baseline: commit `08de648`. Rule: **one step per agent session, one commit per step.**
When every step is done or deliberately dropped, move both files to `trashbin/documentation/`.

## How to run the campaign

The human only ever sends one message per fresh session: **"Do the next review step."**
(Or "Do review step 1.7." to force a specific one.) Everything else — picking the step,
verifying the previous one, testing, committing, triaging — is the agent's job and is
specified below. **The agent commits and pushes to main itself** (a "start" commit in
pre-flight, the step commit at the end); the human never commits, reviews diffs, or runs
tests by hand. Never do more than one step per session.

## Session protocol (the agent follows this in order, every session)

### A. Pre-flight
1. Read this tracker and the report. Pick the step: the one named by the user, else the
   first row whose Status is `todo`, in file order, respecting the "Ordering rules".
   If the previous session left a row `in progress`, that row is the current step.
2. Verify the previous `done` step (the most recent row with a Commit):
   - `git show --stat <commit>`: every file belongs to that step or is this tracker.
     If not, note it in the row and continue (do not rewrite history).
   - Run the full guardrails (section C). If anything is red and the cause is that
     commit, `git revert` it, set the row to `todo` with a note, and make **that** row
     the current step instead of the one picked in A.1.
3. Triage "Noticed during steps": for each line not yet triaged, either add a new step
   at the end of the phase it belongs to (status `todo`, same format as the others) or
   mark the line `dropped: <reason>`. Prefix triaged lines with `[triaged]`.
4. Set the current step's Status to `in progress`, commit the tracker alone
   ("review-2026-09-07 <ID>: start"), push. This makes an interrupted session visible.
5. `git status --short`: if files outside this step are dirty (another session's work),
   record them in the row's Notes and never stage them. If `viewer/test/fixtures/demo`
   is already dirty, record its `git diff --stat` so the byte-identical check in C can
   compare against that state rather than HEAD.

### B. Work
1. Re-verify first: confirm the finding still reproduces at HEAD (the codebase moved since
   `08de648`). If it does not, set Status `not reproducible` with the evidence, commit the
   tracker, push, and end the session.
2. Bug steps: write the failing regression test first, then the fix. Refactor steps: the
   engine goldens and the demo fixture must stay byte-identical.
3. Stay inside the step. Anything else you notice goes under "Noticed during steps" as
   `- <step> — <file:line> — <one line>`; never fix it now.

### C. Guardrails (all must pass before the commit in D)
- `npm test` (engine build + engine and viewer unit suites)
- `cd analysis && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
- `node scripts/build-demo-snapshots.mjs` then `git status --short viewer/test/fixtures/demo`
  is clean — unless the step says **prose changes expected**; then run
  `UPDATE_GOLDEN=1 npm -w engine test`, regenerate the demo, update `viewer/src/i18n.js`
  FR patterns for every changed English sentence, and list each before/after sentence
  in the row's Notes.
- Viewer steps: open the `viewer-demo` launch config, exercise the changed screen, take a
  screenshot, and describe what it shows in the final report.
- Phase gate — if this step is the last `todo` of its phase: also run `npm run test:e2e`
  (run `npx playwright install chromium` first if browsers are missing) and
  `npm run build:pages`. Screenshot baselines may be updated only when the diff is the
  intended visual change; say which and why under "Phase gates".

### D. Self-review and commit
1. `git diff --stat` (unstaged + staged): every listed file is either this tracker or
   inside the step's "Files". Remove anything else from the change set.
2. Re-read the diff once as a reviewer: no debugging leftovers, no unrelated formatting,
   comments updated, new user-facing English strings added to the FR catalogue.
3. Fill the row: Status `done`, Commit (short sha, fill after committing), Notes (what was
   verified, anything unusual, dirty files from A.5).
4. Stage only those files by explicit path, commit
   "review-2026-09-07 <ID>: <title>", push to main.
   Then amend nothing; if the sha is needed in the row, make a second tiny tracker commit.
5. Final message to the human: step id and title, what changed, how it was verified
   (commands + screenshot description), what was added to "Noticed", and which step is
   next.

Status values: `todo` · `in progress` · `done` · `not reproducible` · `dropped` (say why).

## Ordering rules

- Phase 0 before anything else (0.2 and 0.3 give the type gates every later step relies on).
- 1.7 (router) before 4.x refactors of routing; 1.12 (prose) before 3.x i18n work; 2.1 (chunking) before 2.2 (measure the win).
- Steps that change engine wording (1.8, 1.12, 3.2) are the only ones allowed to update goldens and the demo fixture.
- Never `git add -A`; other sessions may have uncommitted work in the tree.

---

## Phase 0 — zero-risk hygiene

### 0.1 Dependency advisories
- Items: §1 npm audit (postcss, browserslist, nanoid, fast-uri, undici)
- Do: `npm audit fix`; confirm the lockfile diff touches dev deps only; `npm test`.
- Done when: `npm audit` reports 0 high; all suites green.
- Status: done · Commit: `5001d47` · Notes: Clean pre-flight at `8971b65`; no previous done step. `npm audit fix` updated only dev lock entries: postcss 8.5.28, browserslist 4.28.9, nanoid 3.3.18, fast-uri 3.1.7, undici 7.29.1 and Browserslist data dependencies; npm also refreshed dev-only peer/license metadata. All 37 changed entries verified dev-only; production/workspace entries and manifests identical. Fresh full and `--omit=dev` audits: 0 vulnerabilities. `npm test`: 112 engine + 43 viewer tests passed; Python 3.12 `uv run pytest -q`: 157 passed (10 NumPy deprecation warnings); Ruff check/format passed (51 files); `npm run build:pages` passed. Demo guardrail has pre-existing drift (six files): isolated `8971b65` with its original lockfile installed via `npm ci` regenerates byte-identical output to the updated dependencies (`diff -r` clean). Restored tracked fixtures unchanged and recorded the drift below; regeneration itself is not clean against HEAD. Engine goldens unchanged. No viewer screen changed; screenshot/e2e phase gate not applicable. Used temporary npm/uv caches because home caches are read-only.

### 0.2 Engine unused-symbol gate + engine dead code
- Items: §7.1 tsconfig flags; §7.2 engine list (E10 `worstDet`, diff.ts unused `previous`, tileStore unused imports, `SQUALL_LABEL`, legacy `VIS_MODELS` names, briefing `generated_at ??` fallback, tides.ts self-lookup)
- Files: engine/tsconfig.json, engine/src/{briefing,diff,findings}.ts, engine/src/forecast/tileStore.ts, engine/src/hazards/{convective,tides}.ts
- Done when: `noUnusedLocals`/`noUnusedParameters` on and `npm run build -w engine` clean; goldens byte-identical.
- Status: done · Commit: `0aa2826` · Notes: Clean pre-flight at `af4bc83`; verified previous step `5001d47` scope and full guardrails (known demo drift only). Enabled both unused-symbol flags after reproducing four TS6133 errors. Removed unused deterministic ranking (ensemble ranking unchanged), buildStory parameter, tile imports, SQUALL_LABEL, required generated_at fallback, and redundant gate self-lookup. Retained VIS_MODELS fallbacks: removing icon_eu/gfs_global fails both findings/briefing goldens and changes visibility from exceeded/approaching to unknown; ScenarioBundleStore still emits those keys, so they are not dead. Added explanatory comment. Final `npm test` builds with both flags and passes 112 engine + 43 viewer tests; Python 3.12 pytest 157 passed (10 existing NumPy warnings), Ruff check/format passed (51 files). Goldens byte-identical. Generated demo output byte-identical before/after (`diff -r` clean); the known six-file drift against HEAD persists, and tracked fixtures were restored unchanged. Triaged demo drift into 1.15 after 1.12. No viewer screen change or phase gate; screenshot/e2e not applicable.

### 0.3 Type-check the engine tests
- Items: §7.1 (tsconfig.test.json), §8 engine row; fixes for routing.test.ts `stepMinutes`, landmaskPack.test.ts, tileStore.test.ts `Ajv2020.default`
- Files: engine/tsconfig.test.json (new), engine/package.json (`typecheck` script), package.json root `test`, .github/workflows/ci.yml, the three test files
- Done when: `npm run typecheck -w engine` passes and runs in CI.
- Status: done · Commit: `4c39ac0` · Notes: Clean pre-flight at `7d4edb7`; verified previous step `0aa2826` scope and full guardrails (known demo drift only). Added no-emit test config inheriting strict, unchecked-index and unused-symbol checks; resolved config covers all 18 test files and the fixture helper. Reproduced four compiler errors before fixes. Removed all three obsolete stepMinutes options (including the spread-object occurrence), made the allocated byte access explicit, and used AJV/addFormats default imports consistently with other tests. Added engine typecheck script to root `npm test`; CI calls that same command with an explicit step name. Final `npm test` includes the passing typecheck and passes 112 engine + 43 viewer tests; Python 3.12 pytest 157 passed (10 existing NumPy warnings), Ruff check/format passed (51 files). Goldens unchanged; regenerated demo output byte-identical before/after; known six-file drift against HEAD remains assigned to 1.15 and tracked fixtures were restored unchanged. GitHub CI run `34162993074` passed on `4c39ac0` (JavaScript including the new typecheck and build:pages, plus Python). Recorded the non-failing action-runtime deprecation warning below. No UI changes or phase gate, so screenshot/e2e not applicable.

### 0.4 `jsonschema` as a runtime dependency
- Items: P4
- Files: analysis/pyproject.toml, analysis/uv.lock
- Done when: `uv sync --no-dev` then `uv run --no-sync python -c "import deepweather_analysis.tides"` succeeds; pytest green.
- Status: done · Commit: `6dcda5b` · Notes: Clean pre-flight at `7c4f07a`; previous step `4c39ac0` scope and full guardrails verified (known demo drift only). Moved jsonschema>=4.21 from dev to runtime dependencies and regenerated uv.lock; all 99 third-party package entries unchanged. In an isolated Python 3.12 environment, `uv sync --no-dev` reproduced ModuleNotFoundError from prepare_tides before the fix; importing the tides module alone already passed because jsonschema is imported lazily. After the fix, the prescribed `uv sync --no-dev` and `uv run --no-sync python -c "import deepweather_analysis.tides"` pass, plus the same synthetic tide publishing/schema-validation smoke check, with pytest/ruff absent and output confined to /tmp. Final `npm test`: typecheck plus 112 engine + 43 viewer tests passed; `uv run pytest -q`: 157 passed (10 existing NumPy warnings); Ruff check/format passed (51 files). Engine goldens unchanged; generated demo byte-identical before/after, with known six-file drift against HEAD assigned to 1.15; tracked fixtures restored unchanged. Triaged prior action-runtime warning into 0.10; stale prepare-synoptic jsonschema comment assigned to 0.9. Temporary uv cache/runtime used; no unrelated dirty files, UI change, screenshot, or phase gate.

### 0.5 Remove stale Open-Meteo providers
- Items: V16; analysis/tests/test_contracts_and_providers.py assertions
- Files: config/providers.json, analysis/tests/test_contracts_and_providers.py
- Done when: Settings page lists no `openmeteo_*`; pytest green; consider adding a `forecast_tiles` entry so the page still explains the wind source.
- Status: done · Commit: `d21ed21` · Notes: Clean pre-flight at `7458eab`; previous step `6dcda5b` scope and full guardrails verified (known demo drift only). Reproduced all three stale Open-Meteo rows as live in Settings; changed provider regression assertions first and observed failure, then replaced those registry entries with forecast_tiles: live, matching the browser's existing TileForecastStore. Assertions require forecast_tiles live and reject all openmeteo_ keys. Final `npm test`: typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 `uv run pytest -q`: 157 passed (10 existing NumPy warnings); Ruff check/format passed (51 files). Engine goldens unchanged; `node scripts/build-demo-snapshots.mjs` output byte-identical before/after; known six-file drift against HEAD remains assigned to 1.15, tracked fixtures restored unchanged. Launched viewer-demo from .claude/launch.json and verified Settings in Playwright: English desktop 1440x1100 shows forecast_tiles live in the two-column provider list; French mobile 390x844 shows forecast_tiles direct in a readable single column; neither lists openmeteo_ providers. Screenshots: output/playwright/review-0.5/settings-en-desktop.png and settings-fr-mobile-providers.png. Provider keys remain identifiers; no new prose. No new notices, unrelated dirty files, or phase gate.

### 0.6 Node version + dev workflow
- Items: §7.1 (engines/.nvmrc, CI node-version, stale engine/dist)
- Files: package.json (`engines`), package-lock.json (matching root metadata only), .nvmrc, .github/workflows/ci.yml, viewer/package.json (`predev`) or viewer/vite.config.js alias to engine/src
- Done when: fresh clone → `npm install && npm run dev -w viewer` works without a manual engine build.
- Status: done · Commit: `fb9e096` · Notes: Clean pre-flight at `9b57280`; previous step `d21ed21` scope and full guardrails verified (known demo drift only). Set engines.node=24.x and .nvmrc=24; CI reads .nvmrc. Added viewer predev build using the full @deepweather/engine workspace name: npm's path selector `-w engine` fails from the viewer lifecycle cwd. Lockfile changes only matching root engines metadata; no dependency changes. Isolated local clone with no engine/dist: npm install succeeds, then viewer-demo previously returned HTTP 500 for browserAnalysis.js with unresolved engine imports; after the fix the same install/start sequence builds the engine automatically and returns HTTP 200. Stale dist sentinel also replaced with byte-identical current build by predev. Node v24.20.0/npm 11.9.0. Final npm test: typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 pytest 157 passed (10 existing NumPy warnings); Ruff check/format passed (51 files). Engine goldens unchanged; regenerated demo byte-identical before/after; known six-file drift against HEAD remains assigned to 1.15 and tracked fixtures restored unchanged. Playwright verified fresh planner and example navigation at 1440x1000, no browser errors; screenshots output/playwright/review-0.6/fresh-planner.png (chart and route form) and fresh-example.png (emulated warning, synoptic chart and weather story). Used viewer-demo launch config on 127.0.0.2:5174 to preserve the existing localhost listener. Recorded CARTO tile watermark below. No unrelated dirty files, prose changes or phase gate. GitHub CI run `34166434456` passed on `fb9e096`, including Node selection from .nvmrc, npm ci, tests/typecheck, build:pages, and Python checks; existing action-runtime warning remains assigned to 0.10.

### 0.7 Viewer dead code
- Items: §7.2 viewer list (VerdictBanner.jsx, V15 `VITE_DW_MODE` branch, `.section-rule`, unused `buildOption` export)
- Files: viewer/src/components/VerdictBanner.jsx (delete), viewer/src/pages/Briefing.jsx, viewer/src/index.css, viewer/src/components/EnsemblePlume.jsx
- Done when: grep proves each symbol unused before deletion; viewer tests + e2e screenshots unchanged.
- Status: done · Commit: `2dcb98f` · Notes: Clean pre-flight at `b747d57`; previous step `fb9e096` scope and full guardrails verified (known demo drift only). Repository-wide git grep confirmed VerdictBanner and section-rule have no callers, VITE_DW_MODE has no configuration, and EnsemblePlume.buildOption has only its local call. Deleted the unused component/CSS rule and unconfigured productionRefusal branch; retained the active emulated-warning disclosure and styling; removed only buildOption's export. Final npm test: engine build/typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 pytest 157 passed (10 existing NumPy warnings); Ruff check/format passed (51 files). Engine goldens and tracked demo unchanged; generated demo byte-identical before/after, with existing six-file drift still assigned to 1.15 and restored. viewer-demo launched from .claude/launch.json; npm run test:e2e before and after: 26 passed, same six pre-existing failures (briefing/plan baselines and obsolete example departure-button assertion, both viewports), recorded below. No screenshot baselines updated. Current mobile briefing and both planner screenshots byte-identical before/after; desktop briefing differs at one pixel (963,964), dimensions/layout unchanged; evidence and changes screenshot checks pass at both viewports. Inspected screenshots show neutral emulated-warning band, synoptic chart, story, route map and conditions strip in desktop/tall mobile layouts. Evidence: output/playwright/review-0.7/briefing-{desktop,mobile}-{before,after}.png and before/after-e2e.log. Triaged 0.6 CARTO notice into 1.16. No unrelated dirty files, new user-facing copy or phase gate. GitHub CI run `34166826474` passed on `2dcb98f` (JavaScript tests/typecheck, build:pages, Python tests/lint/format); CI does not run e2e, whose six pre-existing failures are disclosed above.

### 0.8 Analysis dead code and unused noqa
- Items: §7.2 analysis list (environment_grid dead methods, `write_observations`, `CACHE_MAX_AGE_HOURS`, `STEPS` alias, numpy ImportError guards, `ruff --select RUF100`, stale `tests/__pycache__`)
- Files: analysis/src/deepweather_analysis/{environment_grid,environment_fetcher,observations,ecmwf_open_data,warnings_au,warnings_mf,tides}.py; ignored analysis/tests/__pycache__/test_scaffold*.pyc (local cleanup).
- Done when: each deletion justified by grep; pytest + ruff green. Leave `write_verification` for 1.14.
- Status: done · Commit: `6b3396b` · Notes: Clean pre-flight at `3e2efe1`; previous step `2dcb98f` scope and full guardrails verified (known demo drift only). Repository-wide git grep confirmed the three scalar environment-grid methods only call one another and appear in their own docstring; removed them, their exclusive math/datetime imports and conversion constant, and updated the example to the active batch API. Removed uncalled write_observations and its processed_dir import/export, unused ECMWF CACHE_MAX_AGE_HOURS and STEPS alias/export. Retained the independent test STEPS constant, active batch interpolation, window_label (tested), and write_verification for 1.14. Replaced two NumPy ImportError guards with a normal import: numpy is a required runtime dependency. Removed nine unused BLE001/S310 noqa directives while preserving rationale comments. Used ruff check --extend-select RUF100 to retain the normal lint selection; kept three E731 suppressions, confirmed necessary by --select E731 --ignore-noqa. Removed both ignored stale test_scaffold pyc files locally (no tracked cache files). Final npm test: engine build/typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 uv run pytest -q: 157 passed (10 existing NumPy warnings); Ruff check, extended RUF100 and format --check passed (51 files). Engine goldens and tracked demo unchanged; regenerated demo byte-identical before/after (diff -r clean), with known six-file drift against HEAD still assigned to 1.15 and tracked fixtures restored. No unrelated dirty files or new findings; triaged the existing 0.7 e2e failures into 0.11. No viewer changes or phase gate, so screenshots/e2e not applicable.

### 0.9 Stale comments and internal names
- Items: §7.4 (milestone tags, "brief §N", Supabase, Open-Meteo mirrors, `openmeteo-*` fixture header, FooterActions `race_*` identifiers)
- Files: comments/docstrings in engine/src, engine/test/{findings.golden,scenarios}.test.ts, viewer/src/{components/{FooterActions,ModelFooter}.jsx,pages/Briefing.jsx,lib/{glossary.jsx,format.js}}, viewer/vite.config.js, analysis/src/deepweather_analysis; .github/workflows/prepare-synoptic.yml sync comment.
- Rule: comments and internal identifiers only; **no user-facing copy** (that is Phase 3).
- Done when: `grep -rnE "\bM[0-9]{1,2}\b|Supabase" engine/src viewer/src` is empty or each remaining hit is justified.
- Status: done · Commit: `f4cbd5f` · Notes: Clean pre-flight at `bd27e6d`; previous step `6b3396b` scope and full guardrails verified (known demo drift only). Removed obsolete milestone/numbered-brief references from source comments, Python docstrings and test documentation/title; described current ETA correction, browser execution and filesystem/dev-HTTP/IndexedDB snapshot storage. Updated Open-Meteo archive cache/backoff documentation without the deleted TypeScript mirror, clarified the legacy fixture format, and corrected the prepare-synoptic jsonschema comment. Preserved openmeteo-* fixture filenames/data (actual legacy hourly JSON format). Footer race_request/race_id/race_name remain wire-contract identifiers: the local OSCAR feedback handler validates that category and reads those keys; added explanatory comments, no API or visible label changes. Remaining engine/src + viewer/src milestone-search matches are individually justified: findings.ts:119 is an existing user-facing error, preserved by the no-copy rule; RouteMap.jsx:49/68/83 and SynopticHero.jsx:97/141 are SVG move commands. No Supabase hits remain there. Output-only section references in briefing.ts, Verification.jsx, i18n.js and verification/corpus.py are retained for Phase 3; tides.py M2 is a harmonic constituent, not a milestone. Syntax-tree comparison: all 25 changed JS/TS files unchanged except comments and one test title; all 18 Python files unchanged except docstrings/comments; workflow commands unchanged. Final npm test: engine build/typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 pytest: 157 passed (10 existing NumPy warnings); Ruff lint/format passed (51 files). Engine goldens and fixture inputs unchanged; regenerated demo byte-identical before/after, with known six-file drift still assigned to 1.15 and tracked fixtures restored. viewer-demo launched from .claude/launch.json; Playwright opened the feedback dialog, switched category, and closed with Escape without submitting. Screenshots output/playwright/review-0.9/feedback-{desktop,mobile}.png show the centred dialog, category selection, empty message and disabled Send at 1440x1000 and 390x844; zero browser errors. Existing CARTO watermark remains assigned to 1.16. Recorded the retained M11 diagnostic below for prose triage. No unrelated dirty files, user-facing changes, or phase gate.

### 0.10 CI action runtime versions
- Items: noticed during 0.3, triaged during 0.4.
- Files: .github/workflows/ci.yml
- Do: review checkout/setup-python/setup-uv versions against their supported action runtimes and update deprecated actions.
- Done when: CI passes without the Node 20 action-runtime deprecation warning.
- Status: done · Commit: `6dc1e09` · Notes: Clean pre-flight at `1512064`; previous step `f4cbd5f` scope and full guardrails verified (known six-file demo drift only, restored tracked fixtures). Reproduced both Node 20 deprecation annotations on CI run `34168129357`. Upgraded checkout v4→v5 (both jobs), setup-node v4→v5, setup-python v5→v6 and setup-uv v6→v7: upstream tagged action.yml files declare node24. Chose the first Node 24 majors to keep the migration narrow; reviewed release notes (runner >=2.327.1 supported by ubuntu-latest; explicit npm cache retained; removed setup-uv server-url input is unused). Workflow comparison confirms only action refs changed; commands, inputs, permissions and triggers identical. Final npm test: engine build/typecheck, 112 engine + 43 viewer tests passed; Python 3.12 pytest: 157 passed (10 existing NumPy warnings); Ruff lint/format passed (51 files); build:pages passed. Engine goldens and tracked demo unchanged; regeneration byte-identical before/after (diff -r clean), with known six-file drift still assigned to 1.15 and tracked fixtures restored. No unrelated dirty files; triaged existing 0.9 diagnostic into 3.6. Recorded separate upstream setup-node API deprecations below. No viewer screen change or phase gate (0.11 remains todo), so screenshots/e2e not applicable. Hosted [CI run 34168375871](https://github.com/deepregatta/passage/actions/runs/34168375871) passed both jobs on commit 6dc1e09, runner 2.337.0; both check annotation lists empty and no Node 20 action-runtime deprecation in logs. CI passed 112 engine + 43 viewer tests and 151 Python tests (6 existing ORC-data skips), lint/format and Pages build. Separate setup-node punycode/url.parse API warnings remain in raw logs; these are not the Node 20 action-runtime warning.

### 0.11 Existing example-flow e2e expectations
- Items: noticed during 0.7, triaged during 0.8.
- Files: viewer/e2e/{briefing,navigation}.spec.js and their screenshot baselines.
- Do: reconcile the obsolete example departure-button assertion and briefing/planner baselines with the existing example flow; inspect every intended baseline change without changing product behavior.
- Done when: full e2e passes at desktop/mobile; updated screenshots are reviewed and each baseline change is explained.
- Status: done · Commit: `01310d5` · Notes: Clean pre-flight at `58a7177`; previous step `6dc1e09` scope and full guardrails verified (known six-file demo drift only). Before e2e: 26 pass, same six existing failures on desktop/mobile; no regression from 0.10. Replaced obsolete example departure-scan expectation with emulated disclosure, absent scan action, visible Inspect example bulletin, and dialog open/close assertions; retained decision-band-before-chart check. Added planner → #example → reload → planner coverage at both viewports. Fixed screenshot timezone to Europe/Paris, corrected current-local-time default comment, and excluded only CARTO/OpenSeaMap raster requests in the two screenshot tests; route overlays, chart controls and attribution remain tested. Removed the old 1000-pixel allowance instead of loosening comparisons. Reviewed all four updated briefing/planner PNGs; exact changes documented under Phase gates. Verify, Evidence and Changes baselines unchanged. Final npm test: engine build/typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 pytest: 157 passed (10 existing NumPy warnings); Ruff lint/format passed (51 files); npm run test:e2e without snapshot updates: 34 passed (17 per viewport); npm run build:pages passed. Engine goldens, product source and tracked demo unchanged; regenerated demo byte-identical before/after, known six-file drift still assigned to 1.15, fixtures restored. viewer-demo launched from .claude/launch.json; reviewed desktop 1568x1003 and mobile 390x844 full-page screenshots. Evidence: output/playwright/review-0.11/{before-e2e,update-e2e,after-e2e}.log and before-results/. No unrelated dirty files or new findings; prior 0.10 upstream API warnings dropped from this campaign with rationale.

## Phase 1 — bugs (regression test first)

### 1.1 UK gale warning forms
- Items: P1
- Files: analysis/src/deepweather_analysis/warnings_uk.py, analysis/tests/test_warnings_uk.py (+ fixtures for: list form, "all areas", "all areas except X", "no warnings of gales")
- Done when: the four forms parse correctly and "all areas except Trafalgar" yields a bulletin for every route zone not named.
- Status: done · Commit: — · Notes: Clean pre-flight at `98e0993`; previous step `01310d5` scope and full guardrails verified (known six-file demo drift only). Regression-first: 8 failures reproduced, including all-except emitting a bulletin for excluded Trafalgar and no-warnings parsing force as an area. Parse list, all areas, all areas except named exclusions, and explicit no-warnings; preserve all-area scope independently of optional per-area forecast text. Added sentence fixtures based on the recorded HTML, including multiple case-insensitive exclusions and qualified list names; mocked fetch verifies exact route bulletins, identity, severity and validity. UK suite: 15 passed. Final `npm test`: engine build/typecheck plus 112 engine + 43 viewer tests passed; Python 3.12 `uv run pytest -q`: 168 passed (10 existing NumPy warnings); `uv run ruff check .` and `uv run ruff format --check .` passed (51 files). `node scripts/build-demo-snapshots.mjs` output byte-identical before/after; known six-file drift against HEAD remains assigned to 1.15, tracked fixtures restored unchanged and engine goldens unchanged. No UI changes or phase gate, so screenshot/e2e not applicable. No unrelated dirty files or new findings under Noticed. Temporary uv cache used because home cache is read-only.

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

### 1.15 Demo generator and fixture consistency
- Items: noticed during 0.1, triaged during 0.2; run after the prose reconciliation in 1.12.
- Files: scripts/build-demo-snapshots.mjs; fixture/prose changes, if still required, belong to the explicitly authorized 1.12 scope.
- Do: preserve required demo routes during generation and reconcile remaining generator/fixture differences without introducing new engine wording.
- Done when: `node scripts/build-demo-snapshots.mjs` leaves `viewer/test/fixtures/demo` byte-identical to HEAD; npm tests pass.
- Status: todo · Commit: — · Notes:

### 1.16 Basemap provider watermark
- Items: noticed during 0.6, triaged during 0.7.
- Files: viewer/src/pages/Planner.jsx, viewer/src/components/RouteMap.jsx; shared basemap configuration if required.
- Do: verify current CARTO endpoint requirements and production impact, then configure a supported basemap source with correct attribution.
- Done when: planner and briefing maps render without API-key watermarks in desktop/mobile browser checks; document provider requirements and any remaining coverage limitations.
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

### 3.6 Stale missing-speed diagnostic
- Items: noticed during 0.9, triaged during 0.10.
- Files: engine/src/findings.ts, viewer/src/i18n.js; targeted diagnostic/translation tests.
- Do: replace the obsolete "polar-based ETA lands at M11" diagnostic with current guidance and cover its French translation.
- Done when: missing-speed input produces accurate guidance in English and French; existing goldens and demo fixtures unchanged.
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

## Phase gates
(agent appends one line per closed phase: `- Phase N — <date> — e2e: pass/fail — build:pages: pass/fail — notes`)
- Phase 0 — 2026-09-08 — e2e: pass (34/34, desktop/mobile) — build:pages: pass — Reviewed briefing-desktop-linux.png: obsolete departure action removed and bulletin action relabelled Inspect example bulletin; dimensions remain 1568×1783. briefing-mobile-linux.png: same action change removes one wrapped button row (390×2647 → 390×2617). Both briefing baselines intentionally omit external raster tiles while preserving route markers, map controls, attribution, synoptic chart, story and conditions strip; this is test isolation, not proof of provider availability (1.16 remains open). Reviewed plan-desktop-linux.png (1568×1035 → 1568×1175) and plan-mobile-linux.png (390×1739 → 390×1879): existing example invitation/disclosure replaces the inline link and adds 140 px; departure changes from old July 21 06:00 default to current July 20 08:00 Europe/Paris at frozen 06:00Z. Planner map tiles are deliberately omitted too; controls/attribution remain. Mobile bottom navigation stays fixed at the viewport edge. All changes reflect existing product behavior; no product source, Verify/Evidence/Changes baseline, engine golden or tracked demo fixture changed. Known demo regeneration drift remains assigned to 1.15.

## Noticed during steps
(agents append here: `- <step> — <file:line> — <one line>`)
- [triaged] 0.1 — scripts/build-demo-snapshots.mjs:99 — Pre-existing demo regeneration drift: deletes routes/solent-hop-3wp.json and rewrites five snapshot JSON files (briefing next-run text, change descriptions, warning prose); reproduced with original commit `8971b65` and original dependencies, identical to updated-dependency output. Assigned to 1.15 after prose reconciliation in 1.12; 0.1 preserves the tracked fixtures.
- [triaged] 0.2 — engine/src/findings.ts:156 — dropped: proposed removal of legacy VIS_MODELS names is not dead-code cleanup; ScenarioBundleStore emits those fixture model keys, and a removal probe fails two golden tests and loses visibility assessments. Preserve compatibility and the byte-identical requirement.

- [triaged] 0.3 — .github/workflows/ci.yml:14 — Successful CI run 34162993074 warns that checkout@v4, setup-python@v5 and setup-uv@v6 target deprecated Node 20 action runtimes and are being forced onto Node 24; assigned to 0.10 during 0.4.
- [triaged] 0.4 — .github/workflows/prepare-synoptic.yml:44 — The sync comment says jsonschema is in dev; after 0.4 it is stale. Assigned to comment-only step 0.9; workflow behavior unchanged.

- [triaged] 0.6 — viewer/src/pages/Planner.jsx:328 — Fresh-checkout browser screenshot shows CARTO basemap tiles watermarked "API KEY REQUIRED" (also inspect RouteMap.jsx tile endpoints); UI renders with no console errors. Provider/configuration cause and production impact remain unverified; assigned to 1.16 during 0.7.

- [triaged] 0.7 — viewer/e2e/briefing.spec.js:48 — Full e2e suite already fails six checks before removal: obsolete example departure-button expectation (hidden by !example at Briefing.jsx:180 before this step), briefing screenshots and planner screenshots (navigation.spec.js:29), each on desktop/mobile. Same six after removal; current screenshots unchanged except one desktop pixel. Assigned to 0.11 during 0.8; do not restore the hidden example action to satisfy a stale test.

- [triaged] 0.9 — engine/src/findings.ts:119 — The missing-speed diagnostic still says "polar-based ETA lands at M11" although polar routing exists; retained because 0.9 forbids user-facing copy changes. Assigned to 3.6 during 0.10 for prose cleanup with translation coverage.

- [triaged] 0.10 — .github/workflows/ci.yml:15 — dropped: DEP0040 (punycode) and DEP0169 (url.parse) are informational warnings inside upstream setup-node@v5; no repository call site to repair, no failed CI step or check annotation, and supported Node 24 runtime verified. Reconsider during routine dependency updates rather than adding a product-maintenance step.

## Decisions
(record design choices made in steps 1.5, 3.5, 5.3 here)
