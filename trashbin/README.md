# Trashbin

This directory is a recoverable archive for material removed from the active
project surface. Files here are retained for provenance, but they are not
maintained and must not be treated as current product, architecture, or test
documentation.

Archived on 2026-07-22:

- `documentation/2026-07-11-project-brief-v2.md` — pre-implementation brief;
  it says the product is unnamed and no code exists. Replaced by
  `docs/product-brief.md`.
- `documentation/2026-07-12-competitor-swot.md` — point-in-time market review;
  capabilities and competitor claims can drift.
- `documentation/2026-07-12-prototype-review.md` — point-in-time audit whose
  test counts, missing features, and screenshot links no longer describe the
  current application.
- `design-concepts/` — generated pre-implementation concepts referenced by the
  superseded brief.
- `scripts/local-refresh-watch.sh` — local stand-in for a scheduled refresh;
  production preparation is now handled by `.github/workflows/prepare-synoptic.yml`.

When restoring an item, move it back into the maintained tree, update it to the
current implementation, restore any references, and validate the relevant
tests.
