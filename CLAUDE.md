# Passage by DeepRegatta

Explainable passage-weather risk audit for sailors. Publicly deployed prototype; its safety and calibration claims remain conservative. Product spec: [docs/product-brief.md](docs/product-brief.md); architecture detail: [README.md](README.md).

Dev codename `deepweather` survives in internal identifiers (package names, CLI commands, localStorage keys) — don't rename them, and don't introduce the codename in new user-facing text.

## Layout (factory / showroom / warehouse)

- `engine/` — TypeScript pure library: all per-user compute (routes, ForecastStore tile reads, ETA ranges, verdicts, briefing text, routing). Zero DOM deps, no weather APIs — it must keep running unchanged in the browser.
- `viewer/` — React + Vite showroom. Dev middleware serves `/data/*` from `../data/processed`.
- `analysis/` — Python factory (uv, Python 3.12 — 3.14 breaks the geo stack): route-independent prep publishing JSON artifacts per model run.
- `contracts/` — JSON Schemas: the treaty between Python and TypeScript. Change these deliberately and keep both sides in sync.
- `data/` — git-ignored warehouse.
- Forecast tiles come from the separate [forecast-tiles](https://github.com/deepregatta/forecast-tiles) repo (PFT1 on Cloudflare R2).

## Commands

```bash
npm test                                        # engine (+ viewer if present)
npm run lint                                    # zero JS/TS/React Hook warnings
npm run build:pages                             # engine/viewer build + deployment packaging
cd analysis && uv run pytest                    # Python factory
```

The [maintained docs index](docs/README.md) and
[capability/verification map](docs/capabilities.md) are the current entry points.
Use the map's existing npm/uv/browser checks and supported environments
(Node 24; Python 3.12 for factory/CI).

Dev servers — use `.claude/launch.json` configs, not ad-hoc commands:

- `viewer-demo` — viewer on port 5174 with `VITE_DW_FIXTURE=demo`
- `static-dist` — static pages server on port 8788

## Conventions

- Commit and push to main after edits — don't wait to be asked.
- Every external feed runs `live` / `fixture` / `synthetic` (`config/providers.json`); every emulated value must carry `source_kind: "emulated"` and a visible UI badge.
- Reuse from coachregatta (oscar) is by vendoring with a `Vendored from coachregatta <path>, <date>` header — never cross-repo imports.

## Scoped maintenance

- Read the selected task prompt and its prerequisite source/contracts before
  editing. Execute that task only, record adjacent findings, then stop. Dated
  reviews and `trashbin/` are provenance; verify claims against current code.
- Preserve unrelated changes; stage explicit paths. Behavior defects need a
  meaningful failing regression first. Dead-code/docs work reuses substantive
  tests; do not add tests that merely mirror the edit.
- Keep the engine DOM-free, per-user computation in the browser and Python prep
  route-independent. Preserve the separate timing, passage/revision and frozen
  input contracts in [saved identities](docs/saved-identities.md) and
  [testing](docs/testing.md). Saved evidence must not substitute latest data.
- Retain prepared wind overlays (a real map caller), legacy snapshots,
  compatibility/i18n fixtures, synthetic coverage scenarios and PFT1/GRIB goldens.
  Audit exports/consumers before retiring another API; the
  [0.2.0 retirement record](docs/maintenance/engine-api-retirement.md) covers this
  task's only removals. Shared schemas require producer/consumer checks.
- Test with scratch persistence. Demo `/data/` is read-only; do not regenerate
  committed fixtures without an explicit fixture-update task. Use the launch
  configurations above and preserve unrelated running servers.
- Report local tests, hosted CI, deployment/input freshness, device measurements
  and scientific acceptance separately. Provider `live` mode, a build or a green
  paused publication job proves none of the other states. Unknown live state
  stays unknown; activation/acquisition/publication beyond the selected prompt
  requires its own authorization.
