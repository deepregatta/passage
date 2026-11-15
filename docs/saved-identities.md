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
- Engine semantics `passage-audit-4` (2026-11-14, owner-approved; previously
  `-3`): the audit reads the forecast along each leg instead of at one point
  per leg. Each leg is cut into stretches of at most 10 nm and read at the
  middle of each (`engine/src/auditSampling.ts`), every forecast layer
  (wind and gusts, waves, ensemble members, the second and regional models)
  interpolated between the grid points of its own grid around the exact
  point, each point judged for the hours the boat can be in its stretch; a
  leg's hour takes the worst of the points the boat can be at (a forecast
  scenario counts when it exceeds a limit at any of them; model disagreement
  is judged at each). Interpolated values are frozen and judged rounded,
  arithmetically, toward the hazardous side: wind speed, gust, ensemble members
  and wave heights up to 0.01, CAPE up and visibility down to their tile scale,
  the wave period that gives the steepness down to its tile scale, directions to
  0.1° and other values to their tile scale; in a comparison of one
  value with a limit a rounded value is never less hazardous than the value
  read, and it is within one step of it (the relative model-spread test and
  the fog screen combine values and can move either way within one step) (values on the lattice
  within a thousandth of a step stay there), and the archived inputs are exactly
  what was evaluated; each point keeps the whole read window (the plume and the
  model lines read it beyond the point's own hours). Before, the
  leg midpoint was rounded to a 0.25° lattice and the nearest grid point read
  (the 0.5° ensemble a second time, up to 0.375° away). The frozen decision
  inputs now hold one forecast per sample point (`pointForecasts`,
  `pointEnsembles`, `pointMarine`, `multiModel` per point) where they held one
  per leg (`legForecasts`, ...), so every new check has a new `decision_hash`
  and `snapshot_id`; the identity version stays 2 and `route_revision` is
  unchanged. Findings gain optional, additive fields in
  `contracts/findings.schema.json`: `legs[].sample_points` (where the forecast
  was read), `evidence[].sample_point_id` (the point a value came from) and
  `legs[].hours[].expected` (the reading at the boat's expected position, read
  by the route summary, the expected hours over a limit and the route
  timeline). `sample_point` stays the leg midpoint. Saved checks are never
  recomputed: they reopen from their files unchanged and read as before
  (no `expected`: their one value per leg is all there is). An exact retry of
  a check saved under `-3` (or earlier) is a new check, saved beside it; the
  old one is never rewritten (`engine/test/legacySnapshot.test.ts`).
  Departure comparisons are not persisted (the planner store leaves the scan
  out), so none computed before the change survives a reload. Engine golden
  findings/briefing/scan files and the pinned hash in `snapshotAtomic.test.ts`
  were regenerated; committed demo, compatibility and legacy fixtures were not.
- Committed demo (2026-11-14, explicit owner-authorized fixture update): the
  reference demo pair in `viewer/test/fixtures/demo/` was regenerated with
  `node scripts/build-demo-snapshots.mjs` under `passage-audit-4`. Its two
  snapshots now have identity-v2 IDs (`snapshot_v2_8ca29e5bd5a065f3`,
  `snapshot_v2_406ad333228b0a73`) in place of the schema-version-1 IDs, which
  stay byte-identical under `viewer/test/fixtures/compatibility/` as legacy
  evidence; the other compatibility and legacy fixtures were not touched.
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
- Router confined to the prepared current grid (2026-11-13, owner decision
  "clip the router"): a computed route that the grid's box held back carries
  `routing_request.search_bounds` (the extent of the graph nodes it could use),
  optional and additive inside the free-form `routing_request` object of
  `contracts/route.schema.json`, which needs no schema change and is not a
  shared contract. Like every route field it is route content, so it is part of
  `route_revision`, `inputs.route_hash`, the frozen decision inputs (the route)
  and so `decision_hash` and `snapshot_id` of a check on that route; the same
  request routed again gives the same route and the same identities. A route
  the box never held back (the search never had to skip expanding a node
  outside it, or joining one to an end) is byte-identical to the route computed
  before the change and records nothing new, so no identity moves; routes and passages
  saved before the change are read and verified unchanged
  (`legacySnapshot.test.ts`, `routed-current.json` reproduced byte for byte).
  Engine semantics and identity version are unchanged: evaluation of a given
  route is unchanged; only which route Compute produces can differ.
- Successful exact retries reopen the complete original snapshot. Partial,
  legacy or conflicting existing artifacts are never overwritten or accepted
  as a retry. The manifest remains the completion marker; frozen decision
  inputs are archived alongside the existing artifacts.
- All-or-nothing saves in the browser (2026-11-14): `writeSnapshot` builds
  every artifact first and, when the store offers the optional `writeAll`,
  hands them over in one call, manifest last. The browser store adds them in
  one IndexedDB transaction, so a save that fails (storage full, an abort, a
  closed tab) leaves no record for that snapshot id and the same Check can be
  saved again. Write-once still holds: `add` never replaces a record, and an
  existing partial, legacy or conflicting check is still refused, never
  repaired or deleted; the planner says so instead of offering a retry
  (`SnapshotExistsError`, also used for the dev middleware's 409). The CLI's
  filesystem store has no `writeAll` and writes one file at a time as before,
  manifest last. In dev warehouse mode the browser's `FallbackSnapshotStore`
  has `writeAll` but posts the files to the dev middleware one request per
  file, so a dev save failing part-way can still leave files on disk
  (unchanged behaviour, dev only). Records already left by an interrupted save
  from before this change stay as they are.
- The stored layout of `decision-inputs.json` is not part of any identity.
  `decision_hash` and `snapshot_id` hash the value, and an exact retry compares
  canonical JSON of the parsed file. Since 2026-11-14 the file is written
  without indentation (the other artifacts keep theirs); indented files saved
  earlier reopen on an exact retry unchanged.
- Compressed browser storage (2026-11-15): a check saved in this browser
  keeps every file except the manifest `snapshot.json` as gzip bytes, one
  IndexedDB record per file as before (`{ key, snapshot_id, filename,
  encoding: 'gzip', content: Uint8Array }`), when that is smaller than the
  text; otherwise, and always for the manifest, the record is the plain string
  with no `encoding` field, exactly as before. Only the bytes IndexedDB holds
  change: the files of a check, their text, `decision_hash`, `snapshot_id`,
  the contracts, the engine's `SnapshotStore` and the dev middleware are
  unchanged, and `read` returns the text the engine wrote for both forms.
  A record is stored compressed only after this browser has decoded its gzip
  bytes back to exactly the same text; otherwise it is stored plain.
  Every file is compressed before the one `writeAll` transaction opens, so a
  save stays all or nothing. Checks already saved are never rewritten: no
  migration, no background pass. Without `CompressionStream`, or when
  compression fails, the check is saved plain. A compressed record this
  browser cannot decode (no `DecompressionStream`, damaged bytes) reads as an
  unreadable record does: the check still exists and is never written again,
  opening it reports a load error, and an exact retry is a blocked save. A tab
  still running a build from before this change lists such a check but cannot
  open it (its read hands the bytes to `JSON.parse`, a load error; an exact
  retry there fails without writing); the record is not changed or removed,
  and the tab opens it after a reload. Measured on the Chromium sample of the
  design study (real prepared current grid, demo check): 4.83 MB on disk per
  check plain, 1.79 MB compressed; the Safari figure (11–21 MB plain) is an
  estimate from its serialization rules, not a measurement, and nothing has
  been measured on an iPhone. Nothing may ever compare or hash the compressed
  bytes: gzip output differs between browsers and versions. First live Check
  the same night (one owner-authorized Check, deployed build `3f36b14`, a
  Chromium-based browser, a drawn 67 nm route on the regional current grid):
  six of the check's seven files were stored as gzip and the manifest plain;
  9.93 M characters of text took 1.63 MB, of which `decision-inputs.json`
  (9.61 M characters, the grid 9.34 M) took 1.59 MB; the origin's storage
  estimate rose by 1.7 MB; compressing that file again in the page took about
  0.3 s and decoding it about 0.06 s. The check reopened from My passages
  after a reload, the seven earlier checks stayed plain, an earlier check
  still opened, and the console logged no error.
- Reopening after a reload (2026-11-15): a check saved in this browser that
  is open on the passage page (just made by Check, or opened from My
  passages) is reopened when the page is reloaded or the browser restores the
  tab, from the copy saved in this browser: the same check id and files,
  never a recompute, a newer check of the passage or latest data. The tab
  remembers only the check's opaque id, in `sessionStorage` under
  `deepweather.open-check` (`viewer/src/lib/openCheckMemory.js`), so each tab
  reopens its own check and the URL stays `#passage`: a browser-saved check is
  still not shareable by link, and `#passage?snapshot=<id>` still always names
  a served check read from `/data/snapshots/`. Opening a served check or the
  example in the tab, a failed open, or deleting the check forgets it. If the
  check is no longer saved here (deleted, storage cleared), the page shows
  "No briefing open. Choose a passage." without an error. Served deep links,
  `#example`, Back/Forward and the other pages are unchanged; Back to
  `#passage` after a reload elsewhere also reopens the remembered check.
  Rejected: the id in the hash, which would make a browser-saved check look
  like a link and give `snapshot=` two meanings. Checked once on the live
  site the same day (deployed build `6a59537`, a Chromium-based browser,
  read-only): a browser-saved check opened from My passages was open again
  after a full reload, with the same five sections, the URL still `#passage`
  and no console error. Since 2026-11-15 the decision band's "Closest to your
  limits" line (a `within` margin) is read from the limits the check itself
  recorded in its `decision-inputs.json`, verified against
  `findings.inputs.profile_hash`, and no longer from the sailor's limits
  draft: it is the same right after the Check, from My passages, after a
  reload, on a served deep link and in French, before or without the draft
  loading and after the limits are edited. Before, the line was computed from
  the draft and dropped whenever the draft was not loaded yet or no longer
  hashed to the check's limits. The file is read when the check opens and
  only when its verdict sentence needs the margin (within, or a warning or
  disagreement without a limit result); a check without that record, such as
  a legacy check, has no margin line and the draft never stands in. Nothing
  stored for a check changed. Cost: for a check on the regional current grid
  that file is about 10 M characters; decoding and parsing it took 0.1 to
  0.2 s in Node on a desktop, and was not measured on a phone. An earlier note
  here blamed this line for a 275-character difference seen on the live site
  after a reload of an "exceeds" check; that difference was chart axis labels
  counted in the page text, not a missing line, and the charts were drawn.
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
