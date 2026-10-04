# Engine API retirement — PASSAGE-06

Audited 2026-10-04 at starting Passage SHA
`6dada5dfcec79e498db0c4a55458bab7966cbf9c`. PASSAGE-01–05 end commits are
ancestors, with timing, pinned-input, identity, verification and fixture contracts
present. This retires unused workspace APIs; no sampling strategy changes.

## Reference and obligation audit

Tracked `git grep` across Passage, forecast-tiles, OSCAR, Tactician, Retrace and
landing found references only in Passage:

| Retired API | References before removal | Retained active owner |
|---|---|---|
| `planGrid`, `GridPlan` | `engine/src/fetch/liveGrids.ts`, barrel `index.ts`, two assertions in `liveGrids.test.ts` | `TileForecastStore.mosaicGrid` builds real tile-backed lattices; no runtime caller used this planner |
| `deriveSamplePoints` | `engine/src/route.ts`, barrel, one `route.test.ts` case | `runAnalysis` uses `legMidpoints`; `SamplePoint`, midpoint and leg APIs remain |
| `CurrentPointForecast` | Type declaration and barrel only; no implementation/caller | Existing `ForecastStore.getCurrentGrid` / `RegionGrid` contract |

The planner's private `assertBbox` and `TIDY_STEPS` served only that planner;
the separate land-mask validator remains. `routeBbox`/`passageMaxHours` have
real `currentInput.ts` and viewer `routingInputs.js` callers; `coarsenedGridNote`
serves the actual mosaic. Keep those helpers, antimeridian/bounds/duration
assertions and the remaining route suite. Only the planner-specific assertions
and densification case leave with the unused implementation.

Reproduce the tracked search in each named checkout:

```sh
git grep -n -E '\b(planGrid|GridPlan|deriveSamplePoints|CurrentPointForecast)\b' -- engine viewer scripts contracts
```

Package manifests, barrel, maintained docs and scripts were also checked for
promises/dynamic consumers. No runtime consumer or supported package API
commitment was found. Root is private; viewer's `*` workspace dependency is the
only tracked package consumer. Engine itself is **not** marked private and its
barrel was exported, so that exposure must be acknowledged.

Read-only external checks on 2026-10-04: npm registry
`https://registry.npmjs.org/%40deepweather%2Fengine` returned HTTP 404; GitHub
`repos/deepregatta/passage/releases` returned `[]`; the repo is public. No
registry release was observed. This cannot prove absence of untracked source users.

## Deliberate package boundary and compatibility

Workspace `@deepweather/engine` advances **0.1.0 → 0.2.0**, including its lockfile
entry, marking export retirement. Source users of the four names must stay
pinned to their older revision until migrating. `planGrid`/`GridPlan` have no
drop-in replacement: routing uses ForecastStore tile-backed grid methods.
`deriveSamplePoints` was never production sampling; consumers needing
densification must own that strategy deliberately, not equate it to midpoints.
`CurrentPointForecast` had no producer; grid consumers use the retained contract.

All other exports remain. Runtime `ENGINE_VERSION=0.2.0` and identity semantics
were already present and do not change; package alignment creates no new saved
identities. Shared schemas, actual sampling/lattices, prepared wind and saved
artifacts are unchanged. Keep compatibility/i18n fixtures, synthetic scenarios,
PFT1 fixtures and GRIB goldens. Existing full JS/TS, factory-contract and connected
browser gates verify preservation; no implementation-mirroring test is added.

## Local acceptance, 2026-10-04

`npm test` passed 489 engine / 572 viewer tests and both boundary typechecks;
`npm run lint` and `npm run build:pages` passed. Factory `uv run pytest -q`
passed 525 tests (12 existing upstream warnings); CI's Ruff check and format
commands passed, with 76 files formatted. Existing routing/action/identity/
outcome/fixture-persistence Playwright specs passed 26 desktop/mobile scenarios
on scratch port 5186. All 132 tracked fixture/golden/screenshot/schema files
remained byte-identical; all four shared forecast schemas match the producer.
The barrel audit retained the other 146 entries and 64 local doc links resolved.
`npm audit` still failed on the five existing high Tailwind-chain advisories;
this is separate from local test/build success. Exact delivery/hosted CI results
belong to PASSAGE-06's status/result record, not an inference from these tests.
