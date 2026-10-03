# Verification evidence and its limits

The Python `verify` command compares a **filesystem** snapshot with the
configured observation feed. The viewer can display explicitly published cases.
Automatic verification is **unavailable for browser-local briefings**: those
snapshots stay in IndexedDB and no transport or browser observation matcher is
implemented. A missing case is not a pending or scheduled job.

## Case contract

`contracts/verification-case.schema.json` describes retained v1 published/demo
cases and newly produced v2 cases. The producer validates before writing; the
viewer checks supported versions, snapshot identity, source, lead fields and
finite matched values before rendering. Unreadable, unrelated or malformed
cases show an unavailable status; empty cases show that no observations matched.
No case establishes event timing or forecast skill simply by existing.
My passages labels an indexed case as a published case, never as unconditional
verification, and distinguishes browser-local checks.

V2 includes observation source name/mode, station identity, distance/time
offsets, matching parameters, coverage and a SHA-256 content revision. Synthetic
observations remain visibly emulated and contribute no calibration samples.
The writer updates one case per snapshot and its local case index atomically
per file. The command is a single local writer; it is not a publication service.

`check_lead_h` means valid time minus frozen check creation time. `lead_h` remains
an explicitly declared compatibility alias with the same meaning. Calibration
keeps the existing `[0,12)`, `[12,24)`, `[24,48)` buckets and labels them
`time_since_check`. `model_lead_h` instead uses an unambiguous primary frozen
weather cycle. It and `model_cycle` are null when that provenance is missing or
ambiguous, including legacy/prepared sources without a recorded model cycle.
Publication/retrieval times are never substituted for a model cycle.

## Retry and replacement rules

Calibration v2 persists the current case contribution for each snapshot together
with derived statistics in one atomically replaced file. Statistics are rebuilt
from canonically ordered cases/pairs; rounded historical aggregates are never
pooled into new evidence. Exact retries ignore verification clocks, preserve the
original clock and bytes, and do not increase sample size. Corrected observations
replace the previous contribution, including corrections to no matches or
emulated data. Conflicting revisions of one snapshot in one batch are rejected
without changing the aggregate; later explicit calls choose the replacement.
Out-of-band and emulated pairs are counted as skipped. This is evidence only;
it does not implement model weighting or calibration claims.

Legacy v1 aggregates cannot reveal which cases or retries produced their totals.
On an authorized subsequent verification write, the full original document is
preserved as `legacy_evidence` beside the new records. The viewer labels these
totals separately and excludes them from the deduplicated record. Invalid saved
JSON/schema fails the update without clearing it. This task changed no production
calibration data and fabricates no contribution history.

Migration is a separate, explicit operation: inventory and preserve original
aggregate/case files, establish which individual snapshots/observations are
recoverable, re-verify recoverable cases into a separate v2 record, and compare
coverage without adding legacy totals. Missing history stays unknown. Do not
reset an existing aggregate or claim that such rebuilding recovers lost history.

## Bounded browser follow-up (not implemented)

Prefer shared, route-independent observation files downloaded to the browser,
with bounded area/time selection and cache budget. Match locally against the
frozen private samples and retain source/coverage/revision alongside the local
snapshot. No route or personal limits leave the device. Alternatively, design
an explicit user-controlled export and import: disclose the exported coordinates,
times and limits, validate the returned case against the exact snapshot identity,
and allow replacement/withdrawal of the imported contribution. Both options need
contract, privacy, missing-coverage and retry tests before the UI can promise
verification. No backend, upload transport or new observation acquisition is
authorized or built here.
