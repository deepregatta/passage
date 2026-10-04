# Capability and verification map

Source checked 2026-10-04 for PASSAGE-06 and PASSAGE-07, after committed PASSAGE-01–05.
Dated proof establishes only the stated revision/workload. Provider `live`
configuration does not establish publication or coverage. The deployed revision
of PASSAGE-01–05 was not independently verified here. Read-only curl checks at
2026-10-04 06:00 UTC returned public root/regional/prepared metadata. Root
`updated_at` was `2026-10-04T05:28:39Z`; regional was `2026-10-04T05:49:26Z`;
prepared named `cmems-ibi-20261004T02Z`. This establishes readable pointers,
not complete valid-time coverage, artifact freshness or operational accuracy.

| Surface / status | Source and verification owner | Recorded evidence / limitation |
|---|---|---|
| **Production-enabled:** root PFT1, browser Compute → Check/Scan, local saved briefings, GRIB2 | [Tile store](../engine/src/forecast/tileStore.ts), [planner](../viewer/src/pages/planner/usePlannerController.jsx); npm suites and routing/action/identity browser scenarios | [September production smoke](maintenance/2026-09-19-review-closeout.md) and [October live export record](https://github.com/deepregatta/forecast-tiles/blob/main/docs/regional-delivery.md) prove dated paths. Source includes newer timing, frozen-input and identity fixes; those records do not prove today's availability or accuracy. |
| **Production-enabled canary; full cadence gated:** AROME, ICON-EU, UKV | [Viewer allowlist](../viewer/src/lib/forecastStore.js), [regional guidance](regional-forecast-tiles.md); regional/GRIB unit and Python binary-contract tests | Source defaults to empty `VITE_REGIONAL_MODELS`; dated producer activation confirms all three deployed flags at reduced cadence. Final individual/combined/boundary phone workloads passed. Seven-day acceptance is still open. |
| **Production-enabled shared prep; optional coverage:** synoptic charts/features, wind and credential-dependent currents | [Workflow](../.github/workflows/prepare-synoptic.yml), [loader](../viewer/src/lib/preparedRun.js); factory/uploader tests and action-input regressions | Pointer-last publication; current admission checks space/time/finite samples with whole-action fallback. Missing data stays unavailable. [Dated production proof](maintenance/2026-09-19-review-closeout.md) plus today's readable pointer does not establish freshness/coverage of every artifact. |
| **Gated:** prepared publication spending admission | [Paid-work guide](paid-work.md), [uploader](../scripts/upload-prepared-run.py); guard/uploader pytest tests | `PAID_WORK_ENFORCE=1` read back 2026-10-04. Admission depends on the reviewed shared ledger; none was exercised here. Prep runs before the gate; it does not bound all compute, public reads or account spend. |
| **Local-only adapter paths:** warnings, route tides/gates, observations and filesystem verification | [Optional browser inputs](../viewer/src/lib/browserAnalysis.js), [factory CLI](../analysis/src/deepweather_analysis/cli.py), [verification contract](verification.md); provider/contract/retry tests | Production warning loading is disabled; the workflow publishes neither warnings nor tides/verification. Static demo artifacts are emulated. `live` adapter mode creates no production service. |
| **Production-enabled reference demo; local-only generation:** demo, synthetic scenarios, reader for published cases | [Fixture policy](testing.md), [ScenarioBundleStore](../engine/src/forecast/scenarioStore.ts), [outcome reader](../viewer/src/pages/briefing/OutcomeSection.jsx); compatibility/i18n/outcome/fixture-persistence tests | Pages packages the emulated reference demo. Dev fixture writes are refused; new checks use IndexedDB. Other published cases need an explicit producer/publication path; emulated cases contribute no calibration samples. |
| **Deferred:** automatic verification of browser-local checks | [Bounded follow-up](verification.md); outcome/browser tests assert unavailable | No private route transport or browser observation matcher. A missing case is not a scheduled job. |
| **Implemented in source:** bounded decision message IDs | [Message-ID contract](maintenance/briefing-message-ids.md), engine/viewer `decisionMessages` and browser `decision-messages.spec.js` | Optional version-1 metadata; typed EN/FR verdict/driver rendering, literal names, visible whole-field fallback. Gated registers and other families remain legacy. Current deployed revision unverified. |
| **Deferred:** wider message-ID migration, wider synoptic/authority publication, night-risk evaluation, routing Worker | [Message-ID design](maintenance/briefing-message-ids.md), [product scope](product-brief.md), remaining work below | Full version-2 IDs remain deferred; legacy prose/regex translation stays active for unmigrated and archived fields. Saved `night_ok` changes no verdict, scan or timing. The bounded decision slice changes none of these deferred capabilities. |

## Preserved contracts

- Pure TS engine, private browser per-user computation, route-independent Python
  factory, immutable PFT1 and deliberate producer/consumer schema parity. No
  runtime cross-repo imports or new provider.
- [Timing basis](testing.md#route-timing-compatibility): STW/SOG are distinct;
  routed durations belong to their departure. Current hazards remain sampled;
  nominal arrival obeys `maxHours`. Slow/fast are uncalibrated approximations.
- [Saved identity](saved-identities.md): intent, route revision and full frozen
  inputs are distinct. Exact retries reopen complete originals; conflicting/
  partial artifacts and ambiguous legacy history are preserved. Check/Scan use
  visible validated limits and one pinned input bundle.
- [Verification](verification.md): replaceable contributions, explicit check/model
  lead, separate legacy aggregates, truthful outcomes and emulation exclusion.
  Scenario fractions are not calibrated probabilities.
- Prepared wind has a real [RouteMap caller](../viewer/src/components/RouteMap.jsx).
  Keep it, saved compatibility/i18n cases, PFT1/GRIB goldens and synthetic coverage
  fixtures. The [API audit](maintenance/engine-api-retirement.md) covers the only
  removals; schemas, saved bytes and actual sampling behavior stay unchanged.

## Existing verification commands

Run heavy checks sequentially on this host. Use Node 24 and uv-managed Python
3.12 with existing extras. [CI](../.github/workflows/ci.yml) owns these commands;
no additional runner is needed. [Testing](testing.md) details fixture guarantees.

| Evidence level | Existing command / responsibility |
|---|---|
| Affected units | `npm run test -w engine -- <test file>` / `npm run test -w viewer -- <test file>` |
| Full JS/TS | `npm run lint`; `npm test` (engine build/test typecheck, engine tests, checked viewer action boundaries, viewer tests); `npm run build:pages` (includes root build and deployment packaging) |
| Dependency gate | `npm audit`; October prerequisite runs failed on five high transitive Tailwind-chain advisories. Refresh for each delivery; local tests do not turn failed hosted gates green. |
| Factory/contracts | From `analysis/`: `uv run pytest -q`; `uv run ruff check . ../scripts/upload-prepared-run.py`; `uv run ruff format --check . ../scripts/upload-prepared-run.py`. ecCodes independently decodes retained GRIB goldens. |
| Connected browser | `npm run test:e2e -w viewer -- --workers=1`; select existing spec names for affected flows. Use `.claude/launch.json`'s `viewer-demo`, fresh browser storage and scratch/intercepted writes. Verify server identity before reuse. |
| Hosted delivery | Read back remote main; inspect the exact pushed SHA's JavaScript/browser/Python jobs separately. Failed/skipped/unavailable is not green. Push/build alone does not prove deployed behavior. |
| Live/device/scientific | Dated pointer/deployment proof, identified physical-device workloads and independent observations are separate evidence. This cleanup performs no manual deployment, provider mutation, data promotion or acquisition. |

## Remaining measured work

1. Finish regional seven-day acceptance under the original AROME/UKV windows,
   original ICON-EU miss and approved separate ICON-EU recheck before changing
   cadence. Phone admission measurements cover specified workloads, not network
   latency, absolute process peak or accuracy. The explicit ICON-EU boundary
   mosaic still evicts/redownloads warm; smaller one-tile requests reuse warm.
   Tactician requires its own consumer/model/export audit.
2. Measure low-end Compute/Scan responsiveness before choosing a cancelable
   Worker. Routing is synchronous and scans repeat it; decoder timings alone do
   not prove a routing bottleneck. No speculative performance rewrite.
3. Resolve prepared background-wind coherence separately: `RouteMap` still
   selects current prepared wind for non-example saved briefings while leg arrows
   use frozen findings. Keep its display responsibility; never substitute latest
   values into frozen evidence.
4. Implement only separately assigned message families, retaining legacy EN/FR
   and saved-prose compatibility. Browser-local verification, wider publication
   and scientific calibration need their own contracts and acceptance. Park
   adjacent findings without implementing them in PASSAGE-06.
