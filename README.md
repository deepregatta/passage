# deepweather

Explainable passage-weather risk audit for sailors. Local prototype — see [PROJECT_BRIEF.md](PROJECT_BRIEF.md) for the product spec.

`deepweather` is both the project and product name for now (a real name comes later).

## Architecture (factory / showroom / warehouse — mirrors coachregatta)

| Part | Role | Future deployment |
|---|---|---|
| `analysis/` | Python factory: everything **route-independent, authenticated or gridded** — ECMWF open-data GRIBs, synoptic feature detection, CMEMS forecast currents, warnings, tides, verification. Publishes compact JSON artifacts per model run. | Scheduled shared-prep job (Cloud Run / GH Actions), once per model run for all users, publishing to R2 |
| `engine/` | TypeScript pure library: everything **per-user** — route geometry, ETA ranges, limits, ensemble exceedance, verdicts, briefing text, isochrone routing. Zero DOM deps; runs in Node CLI today. | Runs unchanged **in the user's browser** (no per-user server compute) |
| `viewer/` | React + Vite showroom. Dev middleware serves `/data/*` from `../data/processed`. | Cloudflare Pages; `/data/*` = R2 |
| `data/` | Git-ignored warehouse: caches, prepared runs, immutable snapshots. | R2 bucket, same layout |
| `contracts/` | JSON Schemas — the treaty between Python and TypeScript. | The API between the shared job and every browser |

## Data providers

Every external feed runs in one of three modes (see `config/providers.json`):
`live` (real API), `fixture` (recorded responses), `synthetic` (generated, scenario-controlled).
**Every emulated value carries `source_kind: "emulated"` in its evidence and a visible badge in the UI.**

## Vendoring policy

Code and data reused from the author's `coachregatta` project are **copied into this repo** with a
provenance header comment (`Vendored from coachregatta <path>, <date>`), never imported across repos.

## Quick start

```bash
# Python factory (uv-managed, Python 3.12 — 3.14 is too new for the geo stack)
cd analysis && uv sync --all-extras && uv run pytest

# Engine + viewer
npm install
npm test
npm run dev            # viewer at http://localhost:5174, /data/* served from data/processed
```

## Safety framing

This is a decision *aid*: it never says "GO", official warnings override the personal-limit summary,
unsupported hazards are disclosed in every report. Skippers remain solely responsible; official
marine forecasts remain the authority of record.
