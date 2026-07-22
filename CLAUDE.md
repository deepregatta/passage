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
cd analysis && uv run pytest                    # Python factory
```

Dev servers — use `.claude/launch.json` configs, not ad-hoc commands:

- `viewer-demo` — viewer on port 5174 with `VITE_DW_FIXTURE=demo`
- `static-dist` — static pages server on port 8788

## Conventions

- Commit and push to main after edits — don't wait to be asked.
- Every external feed runs `live` / `fixture` / `synthetic` (`config/providers.json`); every emulated value must carry `source_kind: "emulated"` and a visible UI badge.
- Reuse from coachregatta (oscar) is by vendoring with a `Vendored from coachregatta <path>, <date>` header — never cross-repo imports.
