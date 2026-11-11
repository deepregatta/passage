# Shared contract ownership and pins

Runtime code stays within its repository. Shared schema/fixture reuse is vendored;
verification reads only committed local files and never fetches mutable `main` or
needs a sibling checkout.

| Contract | Canonical owner | Producer | Consumers |
|---|---|---|---|
| Four `forecast-*.schema.json` schemas: tile, manifest, latest, latest-regional | `passage/contracts/` | forecast-tiles | Passage; Tactician models the fields it uses |
| PFT1 weather/ensemble codec golden objects and expectations | `forecast-tiles/tests/fixtures/golden-*` | forecast-tiles | Passage; Tactician retains the weather golden |
| Three `land-index-*.schema.json` schemas and the Raz de Sein golden bundle | `forecast-tiles/contracts/` and `tests/fixtures/land-index-raz/` | forecast-tiles | Tactician `core/land` |
| `data-sources.schema.json` and forecast-tiles' register `data-sources.json` (`data-sources/schema-1`, 2026-11-11): licence, attribution, redistribution status and verified date per upstream source | `forecast-tiles/contracts/` | forecast-tiles | Passage (About page); vendored as `contracts/data-sources.schema.json` and `contracts/forecast-tiles-data-sources.json` |

The lock records each canonical repository/path, `PFT1/schema-1` or
`data-sources/schema-1` version (this lock holds no `TLI1` or `TCP1` rows), canonical Git blob revision (`git-blob:`), and SHA-256.
Blob revisions identify the already shared artifact bytes, without embedding
private implementation commits or review evidence. Both revision and digest
must agree for exact copies. Scoped Git attributes retain LF for pinned JSON
and binary bytes for tiles, including `autocrlf=true` checkouts. The scripts also reject missing/duplicate inventory
entries and any contract family whose consumer list the checker does not name
(`PFT1`: Passage and Tactician; `TLI1`, `TCP1`: Tactician; `data-sources`:
Passage). The format version is for the pin record, not a new wire schema.

These are pins to a declared canonical revision, not a claim to track the latest
upstream revision. An intentional canonical change requires explicit review:
copy the versioned artifact, update its revision/digests and any documented
representation in affected repositories, then run both producer and consumer
tests. Do not refresh pins just to silence a failure. Byte changes (including
formatting) require review even if old outputs still validate.

The negative suite copies the checker, lock and real artifacts into an isolated
temporary checkout, then weakens each schema, changes JSON fixture versions or
corrupts binary fixtures. It also rejects missing artifacts, removed/duplicate
pins, unknown pin formats, and a digest-only refresh with a stale revision. It
also rejects a consumer list that differs from the family's, a register row
borrowing another family's identity, and a family the checker does not list. No
producer implementation or private product evidence is copied into the public
repository.

`contracts/shared-contracts.lock.json` pins all four canonical schemas and the
four producer golden files consumed by `engine/test/tileCodec.test.ts`, and the
vendored data-source schema and forecast-tiles register (added 2026-11-11).
All are exact copies; no intentional artifact divergence exists.

Passage's own register, `config/data-sources.json`, is not vendored: it uses the
pinned schema and records Passage's feeds (`engine/test/dataSources.test.ts`).
The About page shows both registers ([capability map](capabilities.md)).

## Pinned release read at request time

The lock's `releases` entry pins deep-polars release **2026.2**: canonical
repository `deepregatta/deep-polars`, commit `1d1e72e`, and the SHA-256 of its
`index.json`. Nothing of it is vendored: polar data never enters this
repository, so the Pages Function reads the pinned files at request time and
checks them against that digest ([boat polars](boat-polars.md)).
`server/deepPolarsPin.mjs` must equal the entry (`npm run test:functions`).
The artifact checker below ignores this section.

Run `npm run check:contracts` (also first in `npm test`). The dedicated
`shared-contracts` CI job runs the same stdlib Python checks independently of
JavaScript dependency audits. Existing tile codec/store/regional tests exercise
the TypeScript decoder and forecast action path; Python/producer schema tests
remain separate semantic validation.
