# Shared contract ownership and pins

Runtime code stays within its repository. Shared schema/fixture reuse is vendored;
verification reads only committed local files and never fetches mutable `main` or
needs a sibling checkout.

| Contract | Canonical owner | Producer | Consumers |
|---|---|---|---|
| Four `forecast-*.schema.json` schemas: tile, manifest, latest, latest-regional | `passage/contracts/` | forecast-tiles | Passage; Tactician models the fields it uses |
| PFT1 weather/ensemble codec golden objects and expectations | `forecast-tiles/tests/fixtures/golden-*` | forecast-tiles | Passage; Tactician retains the weather golden |
| Three `land-index-*.schema.json` schemas and the Raz de Sein golden bundle | `forecast-tiles/contracts/` and `tests/fixtures/land-index-raz/` | forecast-tiles | Tactician `core/land` |

The lock records each canonical repository/path, `PFT1/schema-1` or
`TLI1/schema-1` version, canonical Git blob revision (`git-blob:`), and SHA-256.
Blob revisions identify the already shared artifact bytes, without embedding
private implementation commits or review evidence. Both revision and digest
must agree for exact copies. Scoped Git attributes retain LF for pinned JSON
and binary bytes for tiles, including `autocrlf=true` checkouts. The scripts also reject missing/duplicate inventory
entries. The format version is for the pin record, not a new wire schema.

These are pins to a declared canonical revision, not a claim to track the latest
upstream revision. An intentional canonical change requires explicit review:
copy the versioned artifact, update its revision/digests and any documented
representation in affected repositories, then run both producer and consumer
tests. Do not refresh pins just to silence a failure. Byte changes (including
formatting) require review even if old outputs still validate.

The negative suite copies the checker, lock and real artifacts into an isolated
temporary checkout, then weakens each schema, changes JSON fixture versions or
corrupts binary fixtures. It also rejects missing artifacts, removed/duplicate
pins, unknown pin formats, and a digest-only refresh with a stale revision. No
producer implementation or private product evidence is copied into the public
repository.

`contracts/shared-contracts.lock.json` pins all four canonical schemas and the
four producer golden files consumed by `engine/test/tileCodec.test.ts`.
All are exact copies; no intentional artifact divergence exists.

Run `npm run check:contracts` (also first in `npm test`). The dedicated
`shared-contracts` CI job runs the same stdlib Python checks independently of
JavaScript dependency audits. Existing tile codec/store/regional tests exercise
the TypeScript decoder and forecast action path; Python/producer schema tests
remain separate semantic validation.
