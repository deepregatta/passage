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
- Storage usage on My passages (2026-11-15): the page shows the origin's usage
  from `navigator.storage.estimate()`, which counts saved checks and the
  forecast tile cache together (so it is not the size of the saved checks) and
  is coarse in Safari; the size is always shown, the share of the quota is
  added from 50 % and a caution to delete checks from 80 %, it is read on
  mount and after a delete only (that page does not ask for persistent
  storage itself; the request is made after a saved check, see "Browser
  deletion of saved checks" below). Seen once on the live site the same day (deployed build `60a942d`,
  a Chromium-based browser, read-only): with eight saved checks the line read
  "Passage uses about 29 MB of this browser's storage, counting saved checks
  and downloaded forecasts." at level `ok` (the browser's estimate was
  29.2 MB of a 252 GB quota), last on the page, fitting a 375 px width, with
  no console error. The French text and the 50 % and 80 % states were not
  seen live.
- Browser deletion of saved checks (2026-11-15): a check is saved only in this
  browser (IndexedDB) and Passage keeps no other copy. A study (2026-11-15)
  found four ways saved checks are lost, from the sources below: (1) every
  browser may delete a whole site's stored data when the device is short of
  space, least recently used sites first; (2) Safari, and probably every
  browser on iPhone and iPad, also deletes it after a number of days of
  browser use without interaction with the site; (3) everything saved in a
  private window is deleted when private browsing ends; (4) the sailor
  clearing the site's data or the browser's history and website data. None
  of this was measured on a device.
  `navigator.storage.persist()` protects only against the first cause (low
  space), never against the second, and a user can always clear the data
  themselves. Chrome grants it silently when it judges the site
  important, Firefox shows its own question, and in a Safari tab the answer is
  always no by WebKit's code (a code reading, not verified on a device). So
  Passage now asks once, after a check has been saved in this browser
  (`requestPersistence` in `viewer/src/lib/storagePersistence.js`, called from
  `analyzeInBrowser` in `viewer/src/lib/browserAnalysis.js`), fire-and-forget:
  never at page load, never after a failed save, never for a check the dev
  middleware wrote to disk, never awaited by the save or by opening the
  briefing, and a failing or never-answering request breaks nothing. It does
  nothing when `persist()` is missing or `persisted()` is already true,
  otherwise asks at most once every 30 days per browser (the time is kept in
  `localStorage` under `deepweather.persist-asked-at`, written before the ask;
  with `localStorage` blocked it asks this time and remembers nothing). It
  shows no text of its own (Firefox shows its question) and sends no
  analytics event. My passages says plainly, in a note under the storage line,
  when this browser holds a saved check and `persisted()` is false or cannot
  be read: "This browser can delete saved checks on its own, for example when
  the device is short of space or after a while without using Passage.
  Passage keeps no other copy." It does not depend on the storage estimate.
  The privacy page no longer says the data stays on the device until the
  sailor deletes it: it says the browser may also remove it on its own.
  Whether Safari's idle limit is 7 days (Apple's texts) or 30 days (WebKit's
  public code since about Safari 18) is unconfirmed: which ships is not known.
  A web app added to the Home Screen on iPhone has storage separate from
  Safari's, so a check saved in Safari is not in it. Exporting and importing a
  check does not exist yet and is the only protection that works in every
  browser. Nothing was measured on an iPhone. Seen once on the live site the
  same day (deployed build `39622aa`, a Chromium-based browser, read-only):
  My passages showed the note under the storage line, in the same small-note
  colour, with eight saved checks and `persisted()` false; the privacy page
  carried the new sentence and "Last updated: 15 November 2026" in English
  and in French, without the old sentence; no console error. The request to
  the browser was not seen live: it is made only after a check is saved, and
  no Check was run for this look.
  Sources: <https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>
  (24 Mar 2020), <https://webkit.org/tracking-prevention/>,
  <https://webkit.org/blog/14403/updates-to-storage-policy/> (10 Aug 2023),
  <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>,
  <https://web.dev/articles/persistent-storage>,
  <https://bugs.webkit.org/show_bug.cgi?id=271401>.
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
- Damaged check content (2026-11-15): an error while rendering a check is
  contained to the page area (`viewer/src/components/PageErrorBoundary.jsx`:
  the header and navigation stay usable, and the tab forgets the check it
  remembers having open, so a reload does not reopen the check that failed;
  a page whose code could not be loaded keeps the remembered check and offers
  a reload, and an Evidence inspector that cannot be shown closes on its own
  with a short note, keeping the page and the remembered check,
  `InspectorErrorBoundary.jsx`), and check-provided strings are never used as
  object keys without an own-property test (`viewer/src/lib/own.js`), with
  nothing stored for a check changed.
- Check file, version 1 (2026-11-15; the export, with the import described
  further down):
  "Save a copy to a file" on the passage page of a check saved in this
  browser with identity version 2 writes one gzip file,
  `passage-check-<departure date, UTC, from the check's decision inputs>-<the
  16 hex of the snapshot id>.json.gz`; the name carries no passage or route
  name. Inside is one JSON document, keys in this order: `format`
  (`"passage-checks"`), `format_version` (`1`), `exported_at` (ISO UTC),
  `exported_by` (`"Passage engine <ENGINE_VERSION>"`) and `checks`, a list
  holding exactly one `{ snapshot_id, files }`. `files` maps each file the
  check's manifest names, and the manifest itself, to its original text as
  `localSnapshots.read` returns it (decoded where it is stored as gzip), in
  the order `snapshot.json`, `decision-inputs.json`, `findings.json`,
  `briefing.json`, `route.json`, `plume.json`, `warnings.json`,
  `synoptic.json`, `tides.json`; the first five are required. Nothing is
  derived or re-serialised, so `contentHash(JSON.parse(files
  ["decision-inputs.json"]))` gives the check's `decision_hash` and its
  `snapshot_id` again from the file alone. The export checks exactly that
  before it makes the file: the manifest is identity 2 with this
  `snapshot_id` and `decision_hash`, the parsed decision inputs hash to that
  `decision_hash`, and `findings.json` names the same `snapshot_id` (and
  `decision_hash` when it has one); any mismatch, a stored file that is not
  JSON or not text, or a manifest naming no files or leaving out a required
  one is reported as a damaged check and no file is made. Only those file
  names are written: any other record a store holds for the check (such as a
  marker an import may add) never is, and a manifest that names a file
  outside the list is refused rather than copied without it (the committed
  latest demo check names the served-only `changes.json` and
  `verification.json`, so it could not be copied; it is never offered, being
  served). The format and its file name live in
  `engine/src/checkFile.ts` (`buildCheckFile`, `checkFileText`,
  `checkFileName`, `CHECK_FILE_NAMES`, `CHECK_FILE_REQUIRED`), the reading,
  safety net and gzip in `viewer/src/lib/checkFile.js`. The file therefore
  holds the route, the departure, the limits the check recorded, the boat
  reference of a computed route (its boat id, the percent of its polar and
  the per-leg speeds, which the owner chose to keep) and the forecast data
  the check used; no polar table is in a check. As a safety net the export
  runs the content rules of `scripts/check-no-polar-data.mjs` (shared in
  `scripts/polar-content-rules.mjs`) over each file's own text and the whole
  document, and refuses the file on any match with a plain message. A served
  check, the example, a legacy identity-1 check and a browser without
  `CompressionStream` are not offered a copy (never an uncompressed file).
  Since round 2 of the import work, the export also reads the document it is
  about to hand over with the very `parseCheckFile`, contracts and bounds the
  import uses (the validators load on the first save, not with the passage
  page), applies the import's caps (16 MB compressed, 64 MB of text; "the
  check is too large for a check file"), and reports a damaged check instead
  of making a file the import would refuse: the round trip is a guarantee,
  with one exception. The export applies no time bound, so a genuine check is
  always exportable whatever the device's clock said; the import refuses a
  check saved more than 24 hours after the import time, and accepts that file
  once its time is no longer more than 24 hours ahead.
  Since stage 2's first part (2026-11-15; no change in what either control
  does) a check is proven once: `parseCheckEntry` proves one
  `{ snapshot_id, files }` entry and `parseCheckFile` reads the version-1
  document around it with the same results; the decision inputs' canonical
  JSON, the costliest step, is built once per check and serves both the hash
  and the polar safety net; and the export's hash proof is that re-read (a
  mismatch is still reported as damaged before polar data, as before).
  Nothing is sent anywhere and no analytics event is sent; the saved check is
  only read. "Copy made" means the browser accepted the download; the sailor
  can still cancel it (iOS Safari, or a browser that asks where to save).
- Importing a check file (2026-11-15, stage 1: one check per file): "Import
  a check" on My passages reads one `.json.gz` file in this browser; nothing
  is uploaded, no analytics event is sent, and it is not offered without
  `DecompressionStream`. The file is content Passage did not write, so it is
  refused at the first failure, with nothing written: over 16 MB compressed;
  not gzip; inflating past 64 MB (read as a stream and stopped at the cap);
  corrupt gzip or bytes that are not strict UTF-8; then
  `parseCheckFile` (`engine/src/checkFile.ts`): an object key repeated within
  one object or named `__proto__`, `constructor` or `prototype`, in the
  document or any file; nesting deeper than 64 levels (real checks nest at
  most 8); a string longer than 64 KiB in any file but the decision inputs
  (the longest in the committed fixtures, goldens and scenarios is 558
  characters, in real warnings 956); not JSON; `format` other than `"passage-checks"`; a
  `format_version` above 1 ("made by a newer Passage") or not 1; an unknown
  document field; other than exactly one check; an id that is not
  `snapshot_v2_<16 hex>`; a file name outside the list, a required file
  missing, a file that is not text, not JSON or not a JSON object; a manifest
  with a key `writeSnapshot` never writes (`SNAPSHOT_MANIFEST_KEYS`, shared
  with the writer: a served check's `demo` is refused), whose `artifacts` do
  not name exactly the files present under the keys `writeSnapshot` uses
  (`SNAPSHOT_ARTIFACT_FILES`), with `input_hashes` other than route and
  profile, or a `check_sequence` that is not a whole number from 1 to 999,999
  (the bound the export shares); a manifest without a save time; on import
  only, a check saved (`created_at`) more than 24 hours after the import time,
  with its own message ("its time is in the future. Check this device's date
  and time."). No other time is compared: findings' `generated_at` and the
  file's `exported_at` are not tied to the hash, so orders between them would
  prove nothing against a forger and would refuse honest files after a clock
  correction; any file failing
  its contract (precompiled validators,
  `viewer/src/lib/generated/checkFileValidators.js`, generated from
  `contracts/` by `scripts/generate-check-file-validators.mjs`:
  `snapshot.schema.json`, `findings.schema.json`,
  `briefing-reader.schema.json`, `route.schema.json`, `plume.schema.json`,
  `warnings.schema.json`, `synoptic-features.schema.json` (with one
  documented tolerance in the generator: `route_transitions` may be absent;
  the contract has required it since the first scaffold, aa5e9a7 on
  2026-07-11, and the Python preparation has written it since 824e888 on
  2026-07-12, but the engine scenario synoptics and every committed v2 check
  lack it, no renderer reads it, and the file is tied to the hash),
  `tides.schema.json`; `decision-inputs.json` has no contract, its hash is its
  proof); the identity (below); then, in the viewer, the polar safety net;
  the id of a check Passage serves (from the served catalogue this page
  already read, the example and hidden ones included; no request is made, so
  a page that loaded online imports offline, and a page that never read the
  catalogue refuses the import for now); and a check already stored under
  the id. The polar safety net (`viewer/src/lib/polarSafetyNet.js`, shared
  with the export) runs the content rules of `scripts/check-no-polar-data.mjs`
  over the raw texts, over each parsed file's canonical JSON (which decodes
  escaped keys) and over every string of at least 16 characters inside the
  parsed files (polar text inside a JSON string). It is a safety net, not a
  guarantee: a table in a shape the rules do not describe passes. Reasons
  logged in the console never quote a key or other file content.
  - Tied to the decision hash (the id's 16 hex is `contentHash` of the parsed
    decision inputs, so these cannot change alone): `decision-inputs.json`
    entirely; `route.json` (canonically the inputs' `route`); `synoptic.json`
    when present (canonically the inputs' `synoptic`; a synoptic file without
    one in the inputs is refused); and, in the manifest and in findings:
    `snapshot_id`, `decision_hash`, `identity_version` 2, `route_revision`
    (`routeRevision` of the inputs' route and departure), `passage_id`, the
    route and limits hashes (`input_hashes`, `inputs.route_hash` and
    `inputs.profile_hash`), `departure_utc`, `profile_id`, `route_id` and the
    engine version; and the number and ids of the findings' legs (one per
    route leg, `L1`…`Ln`).
  - Checked only for agreement, not covered by the hash: the verdict state in
    the manifest, findings and the briefing's decision message (when it names
    one; a check with tidal gates does not) and the `snapshot_id` of the
    briefing and plume. Everything else in `findings.json`, `briefing.json`,
    `plume.json`, `warnings.json` and `tides.json`, and the manifest's
    `created_at` and `check_sequence`, is only held to its contract: the
    findings and briefing are not re-derived (no engine re-run), so a file
    altered consistently in those places is imported as it is. The page's
    rendering hardening (above) is what keeps such content from breaking it.
  Writing: the file texts are stored exactly as given (so an export of an
  imported check gives the same file texts), through `writeAll` with the same
  gzip-at-rest path as a browser save. The same id already here with
  canonically identical decision inputs is "already here": nothing is written
  or marked. The same id with other content (or unreadable inputs) is a
  conflict and the stored check is untouched (write-once). A storage failure
  leaves nothing. An imported check carries an `imported.json` record
  (`imported_at`, and the file's `exported_at` and `exported_by`), never named
  in the manifest's `artifacts` and never exported; `localSnapshots.list()`
  marks it `imported: true`. The marker is one of the records of the same
  `writeAll` transaction as the check's files and manifest, so a check is
  stored with its marker or not at all; the passage page knows a check is
  imported from that record existing, as `list()` does, without reading it.
  Persistence is requested after an import as after a save. An imported check
  joins its passage's history by its `passage_id` (the main use is restoring
  one's own copy), ordered like any other by its `created_at` first. At the
  same `created_at` as a check made in this browser, the imported check comes
  first and the order is not ambiguous (two checks made here, or two
  imported, keep the earlier rules), so a file cannot make the sailor's own
  order unknown or place itself after their check. Its `check_sequence` is
  left out of the next-sequence count: `writeSnapshot` skips listed items
  with `imported: true` (part of the `SnapshotStore.list` contract;
  `localSnapshots.list()` sets it) and counts only whole numbers below the
  largest safe integer, so a file cannot push the sailor's numbers past the
  shared bound, and a restored copy does not continue the numbering. It says
  where it came from wherever it takes part: "Imported from a
  file, not recomputed here · check made {time}" (its manifest's
  `created_at`, not the import time) on its passage page and on the My
  passages card when it is the latest check; "Check {n} · imported" on its
  station of the passage's progress, whose button is named "…, imported from
  a file"; "+{n} more checks ({m} imported)" when imported checks are folded
  away; and "This comparison uses a check imported from a file, which was not
  recomputed here." under the card's "since last check" line and its "route
  changed" line whenever an imported check is compared, and in the passage
  page's change story whenever either compared check is imported.
  Known limit: when the sailor later computes a check with exactly the same
  decision inputs (the same id), the exact-retry path reopens the stored,
  imported check instead of saving a new one, so the page shows the imported
  result, labelled as imported; nothing is recomputed or replaced.
- Live test of the check file (2026-11-15, passage.deepregatta.com, the
  desktop app's built-in Chromium, the owner's own data, counts only): "Save a
  copy to a file" on a browser-saved check made a 1.63 MB gzip file in 1.8 s
  (9.97 M characters of text: format `passage-checks`, version 1, one check,
  seven files, no marker); the button showed its busy label, kept focus, and
  the live region read "Copy made…". That browser pane did not write the
  download to disk, so the file on disk is not verified; this is the case the
  wording "Copy made", not "saved", allows for. The same bytes given to
  "Import a check" answered "This check is already in My passages" with the
  "Open the check" button; the store was unchanged (8 checks, 56 records, no
  marker) and the only request was the importer's own script chunk. Both
  controls read correctly in French and fit a 375 px viewport with no
  horizontal overflow and no console error. Not tested live: an import that
  stores a check (it needs a browser without the check), a refusal, Safari,
  Firefox, a phone.
- Check file, version 2 (2026-11-15; offered in the app since 2026-11-16):
  one file holding all of a sailor's checks, read and stored one check at a
  time. On My passages, "Save all checks to a file" writes it and "Import
  from a file" (named "Import a check" until 2026-11-16) reads it as well as
  version 1; "Save a copy to a file" on the passage page still writes
  version 1, one check. The format and its
  pure functions live in `engine/src/checkFile.ts`, the stream reader in
  `viewer/src/lib/checkFileLines.js` (below). The file,
  `passage-all-checks-<UTC date YYYY-MM-DD>-<HHMM>Z.json.gz`
  (`allChecksFileName`, the UTC minute it is made), is JSON lines inside one
  gzip member, each line compact JSON (`JSON.stringify` never writes a raw
  newline) ended by `\n`: first the header
  `{"format":"passage-checks","format_version":2,"exported_at":<ISO UTC>,"exported_by":<1 to 200 printable ASCII characters>}`
  (`checkFileHeaderLine`); then one line per check,
  `{"snapshot_id":…,"files":{…},"files_digest":<16 hex>}`
  (`checkFileEntryLine`), whose `snapshot_id` and `files` are exactly a
  version-1 entry; last the trailer `{"end":"passage-checks","checks":<N>}`
  (`checkFileTrailerLine`), followed by nothing but its own newline. Each
  line has exactly those keys in that order; the readers
  (`parseCheckFileHeader`, `parseCheckFileEntryLine`,
  `parseCheckFileTrailer`) also refuse anything around the object (a space,
  a carriage return) and, for the header and trailer, any text other than
  what the writer writes. The format is fixed: any change to the shape of
  any line (a key added, removed, renamed or reordered, another value type,
  another digest encoding or framing) is a new `format_version`, never a
  change to version 2; `engine/test/checkFile.test.ts` pins the exact header,
  check line and trailer of a small check and a digest vector. `exported_by`
  is 1 to 200 printable ASCII characters (0x20 to 0x7e, not all spaces), in
  the writer and the reader, since a page may show it; the app will write
  `Passage engine <version>`. `files_digest` (`checkFilesDigest`) is FNV-1a
  64, the engine's hash primitive, defined so a reader in another language
  can compute it: its input is a sequence of UTF-16 code units (a character
  outside the Basic Multilingual Plane counts as two, its surrogate pair),
  for each file present in `CHECK_FILE_NAMES` order its name, U+000A, its
  length in UTF-16 code units in decimal ASCII digits without leading
  zeros, U+000A and its text; each unit is one FNV step (offset basis
  0xcbf29ce484222325, prime 0x100000001b3, `h = (h XOR unit) × prime` modulo
  2^64), written as 16 lowercase hex digits. Names come from a fixed list
  without newlines and texts are length-prefixed, so no two file sets give
  the same input. It catches
  accidental damage to one check before anything is stored and is not a
  security measure: anyone can recompute it, and a check is proven, as in
  version 1, by `parseCheckEntry` (the same options: contracts, the time
  bound). Caps: at most 1 GiB compressed, 64 MiB per line, 4 KiB for the
  header and for the trailer, 1,000 checks and 8 GiB inflated in all
  (`CHECK_FILE_V2_MAX_*`); version 1 keeps its own (16 MB, 64 MB). The line
  cap mirrors version 1's text cap, so any check stage 1 can export fits one
  line. For large checks the compressed cap binds first: a large check is
  about 10 M characters and 1.7 MB compressed, so 1 GiB holds roughly 600 of
  them, well under 1,000 checks or 8 GiB inflated; the writer must stop
  before any cap and say how many checks it left out. Problems
  are told apart for later reporting and never quote content or key names:
  not a check file; newer (a header of format version 3 or above); a damaged
  line, with its reason (not a check line, a bad digest, or the version-1
  proof's own "damaged" or "future-time"); a wrong trailer (another count,
  other keys); more than 1,000 checks.
  The import of many checks (`importChecksFile` in
  `viewer/src/lib/checkImportMany.js`, 2026-11-15; called by "Import from a
  file" since 2026-11-16, which hands a version-1 file on to the stage 1
  `importCheckFile`)
  reads a file through the stream reader. A version-1 file goes to the stage
  1 import and resolves `{ kind: 'v1', …its own result }` unchanged, except
  that a file that is not gzip is "not a check file" whatever its size (stage
  1 says "too large" past 16 MB). A version-2 file is refused before any
  check line is read when the page never read the served ids (the stage 1
  offline outcome) or its header is newer; no request is made at any point.
  Each line is then settled in order, as stage 1 settles its one check: an id
  already settled in the file (imported, already here, a conflict or served)
  is counted as repeated, while a later copy of an id whose earlier copy was
  refused is proven on its own (a line naming its id with escapes is not
  recognised as a repeat and is settled in full, as already here: nothing is
  stored either way); a check whose
  stored `decision-inputs.json` text equals the line's exactly is already
  here (nothing is proven, since nothing is written); otherwise
  `parseCheckFileEntryLine` with the contracts and the time bound (damaged or
  future time), the polar safety net, a served id, stage 1's canonical
  already-here or conflict rule, then stage 1's one all-or-nothing `writeAll`
  of the files, the `imported.json` marker (carrying the header's
  `exported_at` and `exported_by`) and the manifest. A refused line never
  stops the others, and nothing of a line's parse outlives its check (a large
  check's canonical decision inputs are 10 MB); the ids it keeps for the rest
  of the import are copied into strings of their own, since in V8 a short
  string cut from a line can keep the whole line alive (measured: about 22 MB
  per large check kept until the end without the copy, none with it). A storage failure stops the
  import with every stored check whole and says how many lines were not
  settled (from the trailer, read on without parsing; unknown when it cannot
  be reached). A file that breaks after some lines (truncated, corrupt,
  trailing data, a second member, a line over its cap, too many checks,
  invalid UTF-8, a trailer that does not count the lines) keeps what was
  stored and ends `incomplete`, with the reader's code as a hint. An abort
  stops between two checks, never inside one's storing. It resolves `{ kind:
  'v2', outcomes: { imported, already, repeated, damaged, futureTime, polar,
  served, conflict, tooLarge }, importedIds, end: complete | incomplete |
  storage | stopped | refused, hint, notReached, refusal, linesRead,
  joinedOwn }`: `notReached` is 0 when every line was settled, a number after
  a storage failure whose trailer could be read, and null whenever it is
  unknown (a file that broke, a line over its cap, a stop); `linesRead` is the
  number of check lines the reader handed over; `joinedOwn` counts the stored
  checks whose passage already held a check made in this browser (not
  imported) before the import began, from one listing before the first line.
  It asks for
  persistent storage once at the end when it stored anything, and gives the
  event loop a turn between checks. `removeImportedChecks(ids)` removes
  exactly those ids that carry an import marker (files and marker, through
  `localSnapshots.remove`) and refuses any other; "Import from a file" offers
  it after an import of many that stored checks.
  The controls (2026-11-16, My passages, in the storage block after the
  storage line and the note that this browser can delete checks): "Save all
  checks to a file" (`components/SaveAllChecks.jsx`) loads the export and its
  validators on the first tap, shows "check i of n" with a progress bar and
  Stop (stopping keeps nothing), then "File ready" with the number of checks
  and the size, one line per reason checks were left out, and "Save the
  file": a second tap, a fresh gesture for the download, keeps the object
  URL until the next file replaces it (revoked at once) or, after
  `pagehide` or leaving the page, for another 60 seconds (some browsers read
  a blob URL lazily, after the click), and writes
  `deepweather.last-checks-file` (`{ made_at, ids }`, local storage, wrapped:
  the page works without it; `made_at` is the file's own `exported_at`, the
  instant in its name), from which the page says when the last file was made
  and how many checks saved here are not in it (by id, never by clock). It is not shown without `CompressionStream` or a check that can be
  put in a file. "Import from a file" (`components/ImportCheck.jsx`) calls
  `importChecksFile`: a file of one check (version 1, or version 2 with one
  line) reads exactly as stage 1 says it, with "Open the check"; otherwise
  the start is announced, a count with an indeterminate progress bar and Stop
  runs, and one summary follows: how many were imported, already here, sit
  in a passage alongside checks made here, and appear more than once in the
  file (each read once: information, not damage), then one line per kind of
  refusal, then a line when the file ends early, holds more than 1,000
  checks, stopped at a check line over the line cap (that line replaces both
  the ends-early line and a too-large count), meets a full storage (said only
  when the quota was the cause) or another storage failure, or was stopped;
  problems are one alert. A button then removes exactly what this import
  added, through the confirmation dialog and the same store delete the
  page's own "Delete" uses (it forgets the remembered open check and closes
  it if open; a passage the removal empties loses its saved name), refusing
  any id without an import marker, and says how many were removed; a line
  under it says it stays only until the page is left. When a flow ends and
  its Stop or undo button goes while focused, focus moves to the line that
  says how it ended, never to the page; each progress bar is named by the
  text beside it.
  Both speak through the page's one live region, never per check; busy
  buttons stay focusable (`aria-disabled`); no analytics event; the importer
  still loads when the page is idle.
  The export of all checks (`prepareAllChecksFile` in
  `viewer/src/lib/allChecksFile.js`, 2026-11-15; called by "Save all checks
  to a file" since 2026-11-16) lists this browser's checks (`localSnapshots.list()`): every
  check saved or imported here with a v2 id is a candidate, an imported one
  without its `imported.json` marker (only the files its manifest names are
  read); a legacy identity-1 check is counted as legacy and left out. It
  writes them newest first (the check's own `created_at` descending, then
  the id), so a file cut short by a cap or a failure holds the checks most
  likely needed, one at a time: read its files, prove them as the import will
  (`parseCheckEntry` with the contracts and no time bound, as the single-check
  export after its re-read), the polar safety net over the texts, the line and
  the parsed values, then `checkFileEntryLine` into one
  `CompressionStream('gzip')`, whose output is folded into a Blob after each
  check; no two checks' texts are in memory together. A check that is
  damaged, unreadable, polar-shaped or too large for a line is left out and
  counted, and never stops the others. Before each check it stops if that
  check would pass a cap (1,000 checks, 8 GiB inflated, 1 GiB compressed:
  for the last, what the compressor has handed over (read first), a 1 MiB
  margin for what it may still hold and the line's own deflate bound must
  fit), counting it and every older one as over the cap. The finished size is
  checked again: a file past the compressed cap (a compressor that hands its
  output over late) is made again without its oldest checks, counted as over
  the cap, and only when not even one check fits is the backup refused as too
  large. Included checks saved more than 24 hours after the export time (a
  device clock ahead) are written and counted as `futureDated`: an import
  refuses them until that time.
  After the trailer it reads the finished Blob back through the stream
  reader and compares the header, the number of lines and each line's FNV-1a
  64 with what it wrote (not a second proof); any difference fails the whole
  backup. It resolves `made` with `{ blob, name, included, counts: {
  included, legacy, damaged, unreadable, polar, tooLarge, overCap,
  futureDated } }`,
  `empty` when no check could be written, `stopped` on an abort (nothing
  kept) or `failed` with a reason, reports `onProgress({ index, total })` after
  each check and gives the event loop a turn between checks. Its core
  (`makeAllChecksFile`) takes the store, the validators' loader, the
  compressor, `Blob` and the pause as dependencies, so it could run in a
  Worker; it runs on the main thread for now.
  The stream reader (`readCheckFileLines`, 2026-11-15; used by both controls
  since 2026-11-16)
  reads a `File` through `file.stream()` and `DecompressionStream('gzip')`,
  never holding more than one line: it splits on byte 0x0A before decoding
  and decodes each line piece by piece with a fatal UTF-8 decoder that keeps
  a byte order mark, dropping each piece once decoded, so it holds a line's
  text and the chunk in hand, never the line's bytes too (an earlier draft
  held about seven times the line at its peak). It refuses a file over 1 GiB from its size and one that is not
  gzip from its first two bytes, then holds each line to its cap while its
  bytes still buffer (a check line past 64 MiB, a trailer past 4 KiB, all
  lines past 8 GiB inflated, a 1,001st check line: the read stops there). It
  yields the parsed header, each check line's text and, once the trailer
  holds and the file has ended cleanly after it, `{ trailer: { ok: true,
  checks } }`; a trailer that does not hold (another count, other text, more
  than 1,000) is thrown, never yielded. Lines are provisional: each is
  yielded as soon as it is whole, before the rest of the file and its gzip
  footer are read, so a damaged or cut-short file gives the lines before
  the damage and then a refusal. That is the design (a backup cut short must
  still restore the checks before the break): the caller proves each line
  alone (`parseCheckFileEntryLine`), and the file is whole only when the
  trailer arrives. When the first line is not a version-2
  header (longer than 4 KiB, not UTF-8, cut short, or any other text) it
  yields only "version 1" and stops: the caller hands the same file to the
  stage 1 import, which reads it afresh with its own caps (16 MB compressed,
  64 MB inflated) and gives its own outcomes, so a version-1 document with or
  without one final newline reads exactly as before. A header of format
  version 3 or above is "newer". The other problems are told apart: the
  stream failing or ending before the trailer (truncated; a last line
  without its newline is never yielded, except the trailer's); bytes after
  the trailer's line or after the gzip member; a second gzip member (found
  from the first member's size before gzip's magic in the compressed bytes,
  or, where the decompressor ends cleanly, from the file's last four bytes
  not being the size of all it inflated); a member failing its own check
  after the trailer; invalid UTF-8; the file's bytes failing to read
  (unreadable); an abort through an `AbortSignal`, also during the
  second-member scan. Truncated, corrupt, trailing data and second member
  are hints about how a file is broken, while the refusal itself is
  certain: a file missing only its gzip footer reads as trailing data, a
  hostile file can make a corrupt member read as a second member, and a
  decompressor that read on into a second member whose first member
  inflates to a multiple of 4 GiB (gzip records sizes modulo 2^32) would
  pass the end check, with each line still proven alone. The stream is
  released on every end, error, abort and early stop. Decided: a
  carriage return before a newline is part of the line, and the engine
  refuses it (Passage never writes one and gzip keeps text tools from adding
  one, so it means the text was rewritten by something else); the trailer
  may end with or without its newline. How much a decompressor hands over
  before it fails differs (Node's drops the output of a write that fails), so
  damage early in a file can make its first line unreadable and the file
  version 1's to judge (stage 1 refuses it as damaged), and a member failing
  its check may read as truncated: every such file is refused either way.
- Live test of the all-checks file (2026-11-16, passage.deepregatta.com, the
  desktop app's built-in Chromium, the owner's own data, counts only): "Save
  all checks to a file" made one file from 8 checks in 7.5 s (9.18 MB of gzip,
  73.1 MB of text: a version-2 header, 8 check lines, the trailer; nothing left
  out). Progress and Stop showed; the longest main-thread task was 0.95 s.
  "Save the file" gave the "Your browser saves it…" line and wrote the
  last-file record (two keys, 8 ids, `made_at` equal to the header's
  `exported_at`); that browser pane again wrote no download to disk, so the
  file on disk is not verified. The same bytes given to "Import from a file"
  answered "0 checks imported from the file." and "8 checks were already in My
  passages." in 1.1 s, with no undo button; the store was unchanged (8 checks,
  56 records, no marker). The only requests were the importer's own script and
  the served list the page reloads afterwards. Both controls and the last-file
  line read correctly in French and fit a 375 px viewport with no horizontal
  overflow and no console error. Seen and not yet fixed: the import's progress
  text counted to "check 9" for 8 checks (the trailer line is counted), and the
  summary opens with a "0 checks imported" line when every check was already
  here. Not tested live: an import that stores checks, a refusal, the undo,
  Stop, Safari, Firefox, a phone.
  Both flaws seen there were fixed the same day: the progress text now counts
  check lines read (never the trailer), and the "0 checks imported" line is
  left out when other information lines are shown.
- Check file, version 3 (format; not yet written by the app; 2026-11-16):
  version 2 with the names the sailor gave their passages, so restoring all
  checks brings each renamed passage back under its name. The header says
  `"format_version":3` (`checkFileHeaderLine` takes the version, 2 or 3;
  `parseCheckFileHeader` reads both and says which, and calls 4 and above
  newer); then exactly one names line, always present; then the check lines
  and the trailer exactly as in version 2 (the trailer counts checks only).
  The names line (`checkFileNamesLine`, `parseCheckFileNames`) is
  `{"names":[{"passage_id":"…","name":"…"},…],"names_digest":"<16 hex>"}`:
  keys exactly `names` then `names_digest`, each entry exactly `passage_id`
  then `name`, entries strictly ascending by `passage_id` in UTF-16 code-unit
  order (so no passage twice), a `passage_id` of 1 to 128 characters of
  0x21–0x7e, a non-empty `name` that the one cleaning rule leaves as it is
  (`cleanPassageName(name) === name`), at most 1,000 entries
  (`CHECK_FILE_V3_MAX_NAMES`) and at most 512 KiB of UTF-8
  (`CHECK_FILE_V3_MAX_NAMES_LINE_BYTES`); the line must be exactly the text
  the writer writes for its entries. `names_digest` (`checkNamesDigest`) is
  FNV-1a 64 over, for each entry in order, its `passage_id`, U+000A, its
  name's length in UTF-16 code units in decimal, U+000A and its name (the
  construction of `files_digest`); it catches accidental damage and is not a
  security measure. No names: `{"names":[],"names_digest":"cbf29ce484222325"}`.
  Refusals of a names line never quote a name or an id. Version 2 and its
  exact-text pins are unchanged; nothing writes version 3 yet.
  The stream reader (since stage 2's names part) reads a version-3 file: it
  yields `{ kind: 'v3', header }`, then reads exactly one line as the names
  line, held to its own cap while its bytes buffer (512 KiB; over it, the
  read stops before any check, as for a trailer over its cap), and yields
  `{ names }` when it parses or `{ namesUnreadable: true }` when it is
  refused, including a names line that is not UTF-8; the checks still follow
  and are read. A missing names line (the line after the header is a check
  line or the trailer, told from its first nine bytes) is
  `{ namesUnreadable: true }` too, and that line is then read as what it is.
  A names line cut short is a truncation; a line starting `{"names` later
  in the file is a check line, which the caller refuses as damaged. Version
  2 and version 1 read as before. The import of many checks reads a
  version-3 file's checks and does not apply its names yet.
- Passage names (2026-11-16): a name typed with "Rename" on My passages is a
  display label in local storage (`deepweather.passage-labels`, keyed by the
  passage's grouping key, `local|passage|<passage_id>` for a check saved
  here), never part of a check. One cleaning rule applies to every name, in
  the engine (`cleanPassageName`, `engine/src/passageName.ts`): white space
  runs become one space; lone surrogates are removed first (so no later
  removal can join two halves into a new pair); then C0 and C1 controls, the
  bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and
  U+2066–U+2069, and the characters that render blank or hide text (U+00AD,
  U+034F, U+115F, U+1160, U+17B4, U+17B5, U+180B–U+180F, U+200B,
  U+2060–U+2064, U+206A–U+206F, U+3164, U+FE00–U+FE0D, U+FFA0,
  U+FFF0–U+FFFB, and the astral U+1BCA0–U+1BCA3, U+1D173–U+1D17A and
  U+E0000–U+E0FFF: all tag characters, so a subdivision flag loses its tags,
  and the variation-selector supplement); the name is trimmed and cut at 80
  UTF-16 code units without splitting a surrogate pair; a name left with
  nothing visible (only spaces, U+200C, U+200D, U+FE0E, U+FE0F) is empty, so
  the default name shows. Zero width joiners and non-joiners and the text and
  emoji presentation selectors U+FE0E and U+FE0F stay. Explicit ranges only,
  no Unicode property classes and no normalisation, so it cleans the same in
  every engine version; it is idempotent. The rule was tightened on
  2026-11-16 before any version-3 file existed: a version-3 reader requires
  every name to be one the rule leaves as it is, so the rule is now fixed. It
  applies to a typed rename (and to a stored one read back); to a route name
  shown as a passage's name or title (the card's default name and the
  aria-labels built from it, the passage page's heading and its fallback
  title from the legs, the leg progress bar, the tab title) and sent as
  `race_name` by the feedback form; to the leg place names shown in
  sentences and labels (`legLabel`, `legPlace`) and the tidal gate names on
  the route map and in the weather story; and to the name the planner takes
  when a check is revised ("Revise this passage": it becomes a new check's
  route name, so no saved hash changes). Whole sentences from a briefing are
  not cut by it. No saved file, route or hash input is changed.
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
