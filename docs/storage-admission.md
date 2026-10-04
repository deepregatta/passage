# Prepared publication capacity and retention

P01, implemented 2026-10-04. The canonical v1 helper, policy schema, paused
synthetic example and acceptance vectors are vendored from **forecast-tiles
commit `036dc0bd406844fea4ca0c02ef34de1f64370e79` (F01)**. The provenance header
and `contracts/storage-admission-v1.lock.json` record the exact revision, source
paths, SHA-256 and Git blob identities. `python3 scripts/check_storage_admission.py`
checks all four copies offline. No runtime import of another checkout occurs.

**Production capacity enforcement remains gated.** The prepare-synoptic workflow
reads `CAPACITY_ENFORCE`, default `0`. Its existing `PAID_WORK_ENFORCE=1` is a
separate reviewed start/runtime/spending gate. Neither code delivery nor a green
paused job establishes an admitted publication, fresh data or a monthly spend cap.
The budget remains EUR 20/month TTC/conversion: Google/Firebase OSCAR 12, R2 4,
reserve 4; domains excluded. Preserve free plans. Forecast's observed 14 GB
`MAX_BUCKET_BYTES` is a retained-forecast setting, not a universal physical-byte
or monetary ceiling. P01 chooses no new production byte allocation.

## Physical admission

When enabled, the uploader uses `ops/capacity-v1.json` and owner `prepared` in
the same ledger used by forecast writers. It stages the versioned dependency
graph in memory before any write: chart bytes, rewritten feature captions,
rewritten manifest, then the pointer. Original local files remain unchanged.

A reservation covers the full staged artifact bytes, even immutable objects
that will be skipped; unique old/new pointer archives; and F01's 1 MiB bounded
current/previous pointer attempt allowance. The actual pointer lengths must fit
that allowance before admission. Current occupancy and this upload are charged
together; expected pruning never creates headroom. Each attempted write consumes
the scoped adapter's allowance before transport, with one SDK write attempt.

The canonical equation includes all managed baselines plus permanent upload
debits, all unconverted owner ceilings in full, headroom and 262,144 control
bytes. Equality admits; one byte over denies. Strict paginated physical inventory
counts all prefixes, content revisions, legacy/direct artifacts, incomplete or
orphaned uploads, pointer/control objects and multipart parts. Unknown inventory,
unclassified keys, excess unmanaged occupancy, unexpected managed growth or
unknown ledger state stops publication. Before either mutable pointer write,
the adapter rechecks inventory and reservation epoch/pause/expiry.

Reservations use conditional ledger writes. Definite 412 conflicts may reread;
a lost reservation response stops without uploading. Every reservation stays
charged after completion, expiry, interruption and unknown responses. Finish is
diagnostic and idempotent; it never releases physical bytes or resets paid-work
counters. Reconciliation belongs to F01's operator protocol: pause, stop/drain and
fence **all** writers, archive exact state, obtain fresh inventory and CAS a new
epoch with external stop evidence. Lease expiry alone is insufficient.

## Immutable graph and pointer ordering

Artifacts and `prepared/pointers/<sha256>.json` archives use conditional creates.
Identical existing bytes are reused; a mismatch is refused rather than replaced.
Legacy objects are retained. Every complete graph's new pointer and the prior
current pointer are archived before mutable promotion. Archives may also record
a graph whose promotion later failed; they are not publication receipts.

For a changed publication, `prepared/previous.json` receives the original current
pointer using CAS; `prepared/latest.json` is written last, conditional on that
same original base. A concurrent pointer change aborts without rebasing. Previous
and current are separate objects, so this is not a multi-object transaction:
a failed latest write may leave previous equal to current. Both remain readable,
and immutable archives retain older identities. An authenticated read of the
exact intended bytes can settle a lost pointer response; an unavailable/different
read leaves the outcome unresolved and the full charge retained. No error or
pointer outcome triggers cleanup. Already-open and saved briefings keep their
original artifact paths/digests; no migration or latest-data substitution occurs.

## Protected reference policy and cleanup preview

| Owner/reference class | Policy |
| --- | --- |
| Current/previous prepared pointers and their artifact references | Retain exact pointer bytes and all referenced artifacts |
| Archived prepared pointers, including uncertain promotions | Retain archive and complete referenced graph |
| Served/shared snapshot `synoptic.json` captions, frozen decision inputs and artifact references | Retain exact referenced revisions; operator declarations can add protection |
| Browser IndexedDB, offline/local briefings, saved/bookmarked links | Cannot be enumerated centrally; absence from server inventory proves nothing |
| Legacy/unversioned files, direct historical masks, other revisions and incomplete uploads | Retain; ownership or recoverability has not authorized deletion |
| Unknown owners or unreadable reference documents | Retain; pause optional production when capacity is reached |

The browser freezes prepared paths/digests in `browserAnalysis.js`; snapshots
retain decision inputs and synoptic captions in `engine/src/snapshot.ts`, with
browser-local artifacts in `localSnapshots.js`. Served links resolve stored
snapshots; local-only briefings cannot be shared by URL. These consumers do not
supply a central reference registry. Previously deleted artifacts cannot be
reconstructed from a retention change. Prepared background-wind selection in
`RouteMap` remains a separate documented display gate.

`preview_prepared_retention.py` has no write/delete API. Its summary reports
physical prepared bytes, reasons and unreadable reference counts. Every object
is retained, deletable keys are empty, reclaimable bytes are zero. An age-review
annotation beyond six runs per family is informational: **six runs is neither a
byte ceiling nor proof of unreferenced ownership**. All revisions remain intact.
Optional declared saved paths use private JSON with exactly `version: 1` and
`prepared_artifact_paths: ["runs/..."]`; it is an additive protection list, never
an assertion of completeness. Detailed previews include object paths: keep them
outside public repositories; output files are created exclusively with mode 0600.

```sh
analysis/.venv/bin/python scripts/preview_prepared_retention.py --dir /tmp/scratch-objects --output /tmp/prepared-preview.json
# For authenticated read-only R2 inventory, omit --dir and use existing R2 env.
# Add --references /private/prepared-references.json when declarations are available.
```

## Staged provider rollout, read-back and rollback

1. Deliver F01/P01 code with capacity flags off. Do not activate O01 or any next
   work package here. Inventory all bucket writers and inherited settings. This
   repository's prepared cron and manual workflow use the same uploader boundary.
   `publish-polars.mjs` copies files into Pages build assets; it does not write R2.
   External/manual R2 uploaders, polars mirrors or repair tools are unconverted
   until mapped. Reserve their entire independently proven peak ceiling as
   unmanaged owners, or fence them. Unbounded writers keep rollout incomplete.
   Old prepared publishers that can prune history must be stopped/upgraded;
   a byte allocation alone does not make their deletion behavior safe.
2. Finish account-wide inventory/cost/allocation review and writer coverage. The
   synthetic example's zero baselines are not production initialization. Prepare
   an exact private policy with current physical baseline bytes, prepared owner
   prefix `prepared/`, pointer archives/previous included, explicit other owners,
   multipart/control allocations and account headroom. Validate against schema,
   vectors and preview. The F01 allocation proposal is not activation approval.
3. After separate approval of that exact policy/rollout, pause and drain all
   participating producers while keeping reads available. Preserve paid-work
   usage. Create a missing capacity ledger using `If-None-Match: *`, initially
   `paused=true`, `rollout_complete=false`; if one exists, archive and CAS-update
   it using its ETag. Never overwrite/reseed uncertain reservations as zero.
4. Set Passage's repository `CAPACITY_ENFORCE=1` while the ledger stays paused;
   read back the variable and exact workflow/source revision. Confirm every
   managed adapter and every bounded unconverted allocation before CAS-setting
   `rollout_complete=true` and clearing pause. No IAM change, revocation, deletion,
   migration, plan upgrade or paid test is part of this proposed flag change.
5. Observe an ordinary scheduled publication. Read the uncached authenticated
   ledger token/debit, immutable object bytes/hashes, archive, previous and latest
   pointers. Confirm all latest references resolve and historical graph bytes
   are identical. Public cached GETs and CI are separate evidence. At denial,
   leave data and reads available and verify the pause reason; do not delete to
   make a scheduled job green.

Risk: conservative permanent charges and pointer archives grow until reviewed
reconciliation. Inventory/control reads also consume operations; storage-only
admission cannot guarantee EUR 4 R2 or the full EUR 20 TTC. Rollout can pause new
prep while preserving ordinary reads. Local credentials/inherited settings may
not permit complete provider verification; those gaps must close before activation.

Rollback keeps capacity and paid-work admissions paused, drains/fences writers,
and retains both ledgers, charges, data, archives and readable pointers. Restore
known code only under that coordinated pause: an old publisher bypasses capacity
and may prune saved data. Do not disable just one writer's flag while other
writers assume its reservation contract. Restoring a pointer needs its exact
archived bytes and an approved CAS after verifying its whole graph. Never infer
approval to migrate/delete saved data or reset usage from a rollback instruction.

Official provider documentation rechecked 2026-10-04:
[R2 conditional PUTs and paginated APIs](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 consistency and cached-domain limits](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).
The [canonical protocol](https://github.com/deepregatta/forecast-tiles/blob/036dc0bd406844fea4ca0c02ef34de1f64370e79/docs/storage-admission.md)
owns policy validation and paused reconciliation.
