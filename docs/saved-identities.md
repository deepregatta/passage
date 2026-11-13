# Saved passage identities

PASSAGE-03 rules recorded before implementation, 2026-10-03.

- A new planner intent receives a random `passage_id`, persisted with the draft.
  New passage/reset starts another intent. Editing geometry, departure, polar,
  limits, or recomputing keeps the intent. Continuing a saved modern passage
  explicitly carries its ID; continuing a legacy check starts a new intent.
- CLI callers can persist `passage_id` in a route file or supply `--passage-id`
  explicitly. Unidentified CLI/config routes produce individually accessible
  checks; their labels do not imply a shared planning intent.
- `route_revision` fingerprints route content and departure, excluding the
  passage ID. Route labels and waypoint counts are display/configuration keys,
  never history grouping keys.
- Identity version 2 snapshots fingerprint the full frozen decision bundle:
  passage, route/timing/departure, limits, actual forecast samples and run
  metadata, currents, warnings and zone mapping, tides, gates, synoptic and
  prepared content revisions, and engine semantics. The evaluation clock and
  transient tile retrieval timestamps/cache counts and mosaic construction clocks do not distinguish an exact retry.
  Full 64-bit content fingerprints replace truncated identifiers; archival
  equality is also checked before reopening an existing result.
- Engine semantics `passage-audit-3` (previously `-2`): grid-hour event windows
  are clamped to the leg occupancy interval, divergence evidence carries
  per-model `run`/`model_runs`, and duplicate forecast_tiles inputs are
  collapsed. Snapshots computed earlier keep their IDs and are not reopened by
  an exact retry; the committed demo snapshots are unchanged.
- Current grid time step (2026-11-13, owner-approved change to what a check
  saves): a check's `currents` input record in `findings.inputs.forecast_tiles`
  gains `time_step_h`, the largest interval of the whole time axis of the frozen
  grid it sampled (null when undeterminable), optional and additive in
  `contracts/findings.schema.json`. It is derived from a decision input already
  fingerprinted in full (the frozen grid with its time axis), and the findings
  record itself is not hashed, so `decision_hash`, `snapshot_id`,
  `route_revision`, the archived decision inputs and their content digests are
  unchanged; only `findings.json` bytes gain the field. Engine semantics stay
  `passage-audit-3` and the identity version stays 2: evaluation is unchanged,
  and a bump would move every saved identity, which was not approved. As a
  consequence an exact retry of a check saved before the change reopens that
  original snapshot, without the field (write-once), and such passages show no
  hours with and against the current. Bumping the semantics would instead give
  every new check a new identity and the field on retry.
  `engine/test/legacySnapshot.test.ts` proves this on a committed check saved by
  the earlier engine.
- Successful exact retries reopen the complete original snapshot. Partial,
  legacy or conflicting existing artifacts are never overwritten or accepted
  as a retry. The manifest remains the completion marker; frozen decision
  inputs are archived alongside the existing artifacts.
- Modern histories group only by explicit passage ID and persistence source.
  Legacy checks without explicit identity remain individually accessible and
  deletable. No inferred grouping from route names/counts/departure is permitted.
  The committed reference demo's explicit previous/latest IDs may be linked
  in the derived catalog, without rewriting its snapshot files.
- Checks sort by creation time, then persisted `check_sequence` for equal
  timestamps. Complete manifests allocate the next sequence within the intent;
  exact retries retain their original sequence. A hash never establishes
  chronological order. Concurrent or unidentified ties remain ambiguous and
  receive no comparison. Stable IDs only settle presentation order.
  Explicit reference-demo ordering resolves its fixed-clock pair. The previous
  check is the immediately preceding entry in that same order; the first has
  none. Missing/invalid timestamps do not invent chronological comparisons.
- Existing schema-version-1 routes, findings and snapshots remain readable.
  Identity fields are additive and conditional on identity version 2. IndexedDB
  artifacts require no rewrite; planner draft migration assigns an identity
  without associating it with old snapshots.

These identities do not introduce warning publication, verification lifecycle,
forecast-schema changes, or any rewrite/deletion of historical records.

Prepared publication preserves the exact content-versioned chart/manifest
graph used by historical briefings, plus legacy/direct revisions. The publisher
archives old/new pointer bytes and updates previous before latest using CAS.
The server cannot enumerate users' browser-local or offline saved references;
six older unreferenced cycles never establishes permission to prune. P01's
[protected-reference policy and read-only preview](storage-admission.md) retain
unknown ownership and stop optional production at admitted capacity instead.
No snapshot or saved reference is migrated; this cannot recover an artifact
already deleted before the policy changed.
