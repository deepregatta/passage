# Prepared forecast publication spending control

`scripts/upload-prepared-run.py` supports `PAID_WORK_ENFORCE=1` using the
existing R2 credentials and `ops/paid-work.json` in the forecast bucket.
The prepare-synoptic workflow reads the repository variable of that name;
absent/default `0` disables this admission guard. No plan upgrade is needed.

Read-only configuration check on 2026-10-04: Passage's repository variable is
`1` (updated 2026-10-03T08:51:01Z). This confirms enforcement configuration,
not current ledger admission or publication. No job was dispatched here.
The public prepared pointer was readable with curl; that metadata alone does
not establish artifact freshness/coverage or the outcome of a guarded job.

The uploader checks reviewed provider gates before constructing the data
uploader, reserves 2,700 seconds (the existing 45-minute job limit) in the
shared ledger's `prepared` channel, then publishes under a local deadline.
Its stable identity is the SHA-256 of the prepared `latest.json` contents.
Repeated delivery of the same run cannot publish again without explicit
ledger recovery. A pause prints its reason, returns exit 0, and leaves
published objects and pointers readable. A green paused job is not evidence
of publication. Preparation steps before the uploader can still run;
GitHub's zero paid-usage budgets remain the protection against paid compute.

The guard is vendored from `oscar/cloud/recompute/paid_work.py`, 2026-10-03,
as is forecast-tiles' copy. The two forecast producers share the same object
and cumulative counters; different layers can run concurrently, but the
prepared channel cannot overlap itself. Admission uses conditional PUT,
and reserves the full allowance before work. Failure, timeout, crash or
unknown write outcome never refunds it. Lease expiry permits another job
but does not clear usage or duplicate identities.

Missing, invalid, stale (72-hour review), expired, operator-paused or reached
provider state stops admission. These manually reviewed billing gates are
not live telemetry, and alerts do not automatically update them. The public
forecast ledger contains only `allow_paid_work` decisions, hashed identities
and runtime counters; actual billing amounts remain in the private review file.
Provider
delay, public R2 reads, storage and other writers remain outside this ledger.

To pause, CAS-update `paused=true`, preserving usage. To recover, verify
account-wide costs, period, tax/conversion and outstanding work; refresh
review/gates and CAS-clear the pause. A monthly limit requires a reviewed
new period or approved increase, not counter deletion. Archive the old
document before rollover. For a reviewed retry, remove only the relevant
hashed `seen` entry while retaining its charged counters. Run one bounded
job, then verify its pointer. In-flight work is not cancelled by a pause.

Rollback removes/sets the repository variable to `0` or reverts this
integration; that reopens optional work. Keep the ledger and published data.
Prefer leaving enforcement active with `paused=true` during an incident.

The full shared protocol and R2 exposure are documented in
[forecast-tiles](https://github.com/deepregatta/forecast-tiles/blob/main/docs/paid-work.md).
