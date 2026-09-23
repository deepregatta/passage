# Passage documentation

This directory contains the maintained documentation for Passage.

| Document | Purpose |
|---|---|
| [Product brief](product-brief.md) | Current audience, value proposition, scope, safety principles, and product status |
| [Testing and maintenance](testing.md) | Test suites, fixtures, scripts, generated files, and routine validation |
| [2026-09-17 implementation verification](maintenance/2026-09-17-implementation-verification.md) | Historical verification of the archived September review and the resolution of IV-1 through IV-8 |
| [2026-09-19 review closeout](maintenance/2026-09-19-review-closeout.md) | Remaining robustness/configuration fixes, CI coverage, and production smoke evidence |
| [PFT1 forecast tile format](forecast-tile-format.md) | Binary forecast-tile and publication contract shared with `forecast-tiles` |
| [GRIB2 export](grib-export.md) | Canonical specification of the route-area GRIB2 files: encoding, lattice, datasets, CLI and contract tests |
| [GRIB export plan](grib-export-plan.md) | In-progress phased plan for downloading route-area GRIB2 files from the planner |

Repository-level entry points remain at the root:

- [`README.md`](../README.md) — architecture, quick start, product flow, and key commands.
- [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md) — agent-specific working instructions; keep their shared project facts aligned.
- [`branding/README.md`](../branding/README.md) — brand asset inventory and usage.

Historical material is in [`trashbin/`](../trashbin/README.md). It is retained
for provenance only and should not be used to describe the current product.
