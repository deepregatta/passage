# September review closeout

Scope confirmed on 2026-09-19: the four closeout items following the
[implementation verification](2026-09-17-implementation-verification.md).
IV-1 through IV-8 were already resolved. Message-ID migration, broader regional
synoptics, and production warning publication remain separate product work,
as explicitly agreed for this closeout.

Implementation: `6093ddd00a23ea5d4457fc011f3e66feee2fe7d5`, CI server
binding fix `7f4988ee02b32ec4dc6df4ba3f6667daf569ee92`, and navigation/screenshot
follow-up `ca8ccc6faa55366836b93b4a8faf5cdfd2746d95`, on `main`.
**All four agreed closeout items are complete.** Production smoke verification
and all three hosted CI jobs passed.

## Changes

| Closeout item | Resolution |
|---|---|
| CI coverage | The browser job installs Chromium on Ubuntu 24.04, runs all desktop/mobile flows with one worker and an explicit Europe/Paris browser timezone, and uploads failure artifacts. JavaScript CI runs `npm audit`; Python CI checks and formats the uploader as well as `analysis/`. |
| Demo server identity | Playwright reads the existing `viewer-demo` launch configuration. Setup verifies the dev server's demo marker and the exact committed index before any browser tests. Local reuse is allowed only after these checks; CI starts its own server. |
| Routing departure | `computeRoute()` uses the shared `parseUtc()` before graph construction. Invalid timestamps fail explicitly; naive timestamps mean UTC, matching analysis and scheduling. |
| UK area matching | Matches complete name tokens, preserving directional qualifiers, case insensitivity, punctuation, and repeated whitespace. Empty names and embedded substrings such as Dover/Dovercourt no longer match. |
| Currents delay | Successful downloads return without sleeping. The existing configurable two-second backoff remains between failed attempts, including invalid downloads. |
| Forecast configuration | Tile and prepared readers share a checked-in production default, `https://forecast.deepregatta.com`. The existing optional environment override remains supported. README documents the override and CSP requirements. |
| Prepared chart ordering | Run URLs are determined synchronously from the build mode, independent of `preparedRun()` and latest-pointer availability. Production uses the forecast host's `prepared/` prefix; development stays on local `/data/` instead of switching hosts after a failed probe. Snapshot-local chart URLs remain unchanged. |
| Screenshot portability | Map leg markers use the app's bundled instrument font instead of a machine-dependent system font. The two briefing baselines were reviewed and updated only for marker glyphs; layout dimensions and screenshot tolerances are unchanged. Evidence chart baselines are unchanged. |
| Back during lazy page loading | The expanded browser run exposed a blank-page crash when returning to a briefing before the planner module loads. A regression defers that module and reproduced `Map container is already initialized` at both viewports. Keying the page Suspense boundary disposes the old Leaflet map when navigation starts, preventing ref reattachment to an initialized container. |
| Production smoke | The deployed implementation loaded live forecasts and rendered a new briefing and synoptic chart. Served English/French snapshot links opened and survived reload. Details below. |

## Local verification

The new routing, prepared-source, area-matching, and delay regressions reproduced
16 failures before the fixes. Additional tests cover transport defaults and
demo-server rejection. Tests use recorded/synthetic inputs or mocked providers;
they do not establish live forecast accuracy.

| Check | Result |
|---|---|
| Engine build, test typecheck, and unit suite under `TZ=Europe/Paris` | 349 tests pass in 30 files |
| Viewer unit suite under `TZ=Europe/Paris` | 459 tests pass in 31 files |
| Python under `TZ=Europe/Paris` | 495 tests pass; 12 existing upstream NumPy/xarray deprecation warnings |
| ESLint | Pass, zero warnings |
| Ruff check and format, including uploader | Pass; 72 files formatted |
| `npm audit` | Zero vulnerabilities |
| Production Pages build without a forecast-host override | Pass, including EN/FR preload checks |
| Demo regeneration | Tracked fixtures and goldens unchanged |
| Desktop/mobile browser suite | All 64 cases pass with `CI=true TZ=UTC`; only the two reviewed briefing marker-font baselines changed |
| Actual non-demo listener on port 5174 | Playwright rejects it during setup, before running any browser tests or reading its data index |

## Hosted verification

- [Initial CI 35446435712](https://github.com/deepregatta/passage/actions/runs/35446435712): JavaScript and Python passed; the new browser job timed out waiting for its server before running tests. The launch configuration now pins `127.0.0.1`, matching Playwright's readiness URL, and exposes server startup output. All 62 browser cases also passed locally with `CI=true` after this adjustment.
- [CI 35447408467](https://github.com/deepregatta/passage/actions/runs/35447408467): JavaScript and Python passed; the browser server started and 58 cases passed. Four screenshot checks differed only in chart time labels and map-marker system-font glyphs. This prompted the explicit browser timezone, bundled marker font, and two reviewed briefing baselines above.
- [Final implementation CI 35448194541](https://github.com/deepregatta/passage/actions/runs/35448194541): **all three jobs passed** on `ca8ccc6`, including all 64 browser tests, audit, lint, typechecking, builds, Python tests, and uploader Ruff checks.
- Cloudflare Pages successfully deployed implementation `6093ddd` (deployment `353c780a-a132-412f-b518-07acb3b8d780`). The production HTML's complete JavaScript asset list matched the local production build, including `index-C6tXADrX.js` and `appStore-CXs46hJ_.js`.
- Cloudflare Pages also successfully deployed final implementation `ca8ccc6` (deployment `65cfd9d2-4fc4-42a4-92bc-a6b15ec3dce0`). Its production asset list matched the final local build, including `index-sc_qheNT.js` and the unchanged analysis/store bundle `appStore-CXs46hJ_.js`.

## Production browser smoke

Checked `https://passage.deepregatta.com` on 2026-09-19 around 13:56–13:59 UTC,
after verifying the deployed asset list. This is an availability and UI-flow
check, not a forecast-accuracy or navigation-safety assessment.

- Imported a synthetic two-waypoint GPX from `(50.2, -4.2)` to `(50.0, -4.4)` (14.3 nm) and ran the normal passage analysis. The browser generated a local briefing, displayed model guidance from the September 19 00Z runs, and rendered the prepared synoptic image. No route or snapshot upload was introduced.
- Browser network inspection recorded HTTP 200 for `latest.json`, weather/ensemble/wave/ECMWF/current manifests, GFS/GEFS/wave/ECMWF tile bytes, prepared synoptic features, wind/current grids, and the prepared PNG. The browser reported no console errors during the analysis.
- The prepared inputs referenced `ecmwf-ifs025-20260918T18Z` and `cmems-ibi-20260919T01Z`; current tile manifests referenced September 18 runs. These are the observed run identities, not claims that every layer updates simultaneously.
- The newly computed briefing correctly disabled link sharing and explained that it was browser-local.
- Served snapshot `20260720T060000Z_44d2cd5f_64ea971e` opened at both `/#brief/story?snapshot=<id>` and `/fr/#brief/story?snapshot=<id>` in a fresh tab. Both links survived reload with the same identity and retained their visible emulated-warning labels. English and French Share actions reported success. Actual clipboard contents and independent browser-context reopening are covered by the Playwright suite; the in-app production clipboard readback did not provide that additional evidence.
- Repeated shared-link checks on final deployment `ca8ccc6`. With the production planner script deliberately held pending in the test tab, pressing Back restored both the briefing and Leaflet map without console errors. The French link also survived reload with its emulated label. Temporary request interception/cache overrides were cleared and the test tabs were closed.

Live warning publication, wider synoptic coverage, and message-ID migration
remain outside this agreed scope. No scheduled monitor was created.
