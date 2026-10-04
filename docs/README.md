# Passage documentation

This directory contains the maintained documentation for Passage.

| Document | Purpose |
|---|---|
| [Product brief](product-brief.md) | Current audience, value proposition, scope, safety principles, and product status |
| [Capability and verification map](capabilities.md) | Source owners, dated production evidence, gated/local/deferred surfaces and existing checks |
| [Saved identities](saved-identities.md) | Versioned passage, route revision and snapshot rules, retry semantics and legacy preservation |
| [Verification evidence](verification.md) | Replaceable case contributions, explicit lead semantics, legacy preservation and unavailable browser-local verification |
| [Testing and maintenance](testing.md) | Test suites, fixtures, scripts, generated files, and routine validation |
| [2026-09-17 implementation verification](maintenance/2026-09-17-implementation-verification.md) | Historical verification of the archived September review and the resolution of IV-1 through IV-8 |
| [2026-09-19 review closeout](maintenance/2026-09-19-review-closeout.md) | Remaining robustness/configuration fixes, CI coverage, and production smoke evidence |
| [Shared contracts](shared-contracts.md) | Canonical owners, committed revision/digest pins, deliberate representations and offline drift gates |
| [PFT1 forecast tile format](forecast-tile-format.md) | Binary forecast-tile and publication contract shared with `forecast-tiles` |
| [Regional forecast tiles](regional-forecast-tiles.md) | AROME/ICON-EU/UKV admission, recorded canary activation, device evidence and release gates |
| [Prepared publication spending control](paid-work.md) | Paid-work admission, its limits, pause and recovery rules |
| [Briefing message-ID design](maintenance/briefing-message-ids.md) | Implemented decision slice, deferred wider migration and saved prose compatibility |
| [Engine API retirement](maintenance/engine-api-retirement.md) | PASSAGE-06 reference/export audit and deliberate 0.2.0 package boundary |
| [GRIB2 export](grib-export.md) | Canonical specification of the route-area GRIB2 files: encoding, lattice, datasets, CLI and contract tests |
| [GRIB export plan](grib-export-plan.md) | In-progress phased plan for downloading route-area GRIB2 files from the planner |

Repository-level entry points remain at the root:

- [`README.md`](../README.md) — architecture, quick start, product flow, and key commands.
- [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md) — agent-specific working instructions; keep their shared project facts aligned.
- [`branding/README.md`](../branding/README.md) — brand asset inventory and usage.

Historical material is in [`trashbin/`](../trashbin/README.md). It is retained
for provenance only and should not be used to describe the current product.
