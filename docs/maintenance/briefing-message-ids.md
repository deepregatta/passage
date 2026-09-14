# Engine prose: message IDs and saved-briefing compatibility

Design for review step 3.5, based on repository HEAD `86b8640` (2026-09-14).
This document specifies a future change; it does not change the live contract,
engine output or viewer. Implementation slices below require their own tracker
rows after design review.

## Problem and current boundaries

`engine/src/briefing.ts` emits `schema_version: 1`. Its sections contain English
`title`, `register_plain` and `register_pro`; `route_impact.per_leg` contains both
registers again. Paragraphs are assembled from optional sentences. Synoptic
`availability.reason` is also English. `contracts/briefing.schema.json` has no
message metadata, accepts any integer version, and barely constrains `per_leg`.

`viewer/src/i18n.js` matches English with `FR`/`FR_PATTERNS` and then applies
fragments and date substitutions. Thus a wording edit changes the translation
lookup key. Existing corpus tests catch known strings, but cannot make every
future branch or arbitrary input translatable.

Consumers need separate attention: `StorySection` in `viewer/src/pages/Briefing.jsx`
renders both registers and leg prose; `WeatherStoryCard` extracts a first sentence.
The unsupported section currently derives replacement prose from findings.
`engine/src/cli.ts` prints the saved English decision. `engine/src/snapshot.ts`
writes immutable artifacts, while `viewer/src/stores/appStore.js` loads briefings
from local or served snapshots without a message normalisation layer.

Findings consequences, coverage details, gate rule text and change stories also
contain prose (`engine/src/{findings,diff}.ts`, `engine/src/types.ts`). A briefing-only
migration must not be advertised as eliminating all engine-prose regexes.

## Decision

Add ordered message references beside the existing English fields. The engine
selects meaning, facts and sentence order; locale catalogues render those facts.
Keep canonical English rendering in a pure, browser-safe engine module to produce
saved fallback strings and CLI output. The viewer owns French and locale selection,
uses that same English catalogue, and never duplicates English templates.
No DOM, weather API, translation service or viewer dependency enters the engine.

Use complete sentence or complete paragraph IDs, not word fragments. One reference
may render several inseparable sentences, such as a warning plus its caveat. An
array expresses optional sentences without embedding English inside parameters.
Render a register by joining its non-empty messages with exactly one space.
Plain and professional registers have distinct IDs because they make different
claims; evidence remains attached to the existing section or leg.

IDs use semantic names and an explicit meaning revision, for example
`briefing.decision.within.plain.v1`. Punctuation/wording changes keep an ID when the
meaning and parameter contract are unchanged. A changed claim, units, required
parameter or interpretation gets a new ID revision. Never reuse or delete a
published ID while its snapshots are supported. `section.id`, evidence IDs and
snapshot IDs retain their existing purposes.

## Proposed wire contract

Introduce briefing version 2 independently of findings/snapshot/plume versions.
Retain every existing English field and its meaning. Add these fields:

| Owner | New field | Shape and requirement for version 2 |
|---|---|---|
| Section | `messages` | Required object: `title`, `plain`, `pro` |
| Section `messages.title` | — | One message reference |
| Section `messages.plain`, `.pro` | — | Non-empty ordered arrays of references |
| Each `per_leg` entry | `messages` | Required object: `plain`, `pro` non-empty arrays |
| `availability` with a `reason` | `reason_message` | Required reference paired with the retained English reason |

A reference has exactly `message_id` (non-empty string) and `params` (object,
including `{}` for no parameters). There is no executable template, HTML, locale
or translated text in a reference. The containing legacy field is the fallback
for the entire title/register/reason; avoid duplicating a fallback per sentence.

Illustrative version-2 section (proposed IDs, not currently emitted):

```json
{
  "id": "decision",
  "title": "Against your declared limits",
  "register_plain": "Forecast conditions stay inside the limits you declared for this departure.",
  "register_pro": "All evaluated condition-hours remain below declared thresholds.",
  "evidence_ids": [],
  "messages": {
    "title": { "message_id": "briefing.decision.title.v1", "params": {} },
    "plain": [
      { "message_id": "briefing.decision.within.plain.v1", "params": {} }
    ],
    "pro": [
      { "message_id": "briefing.decision.within.pro.v1", "params": {} }
    ]
  }
}
```

The future `contracts/briefing.schema.json` should dispatch `oneOf` to a frozen
version-1 shape (`schema_version: {"const": 1}`) and a version-2 shape (`const: 2`).
Preserve version-1 optional fields and permissiveness; do not impose new per-leg
requirements on historical documents. Version 2 explicitly defines per-leg
`leg_id`, both English registers, `evidence_ids` and `messages`, and retains the
current section IDs, availability states and next-run fields. Require `title`
for version 2 (already emitted today), with its message counterpart. Define new
message containers with `additionalProperties: false` so misspellings fail.

Two validation layers serve different purposes:

- Writer validation: a closed registry generates the known-ID `oneOf` branches,
  required per-ID parameters, types and constraints; reject unknown IDs, missing
  or extra parameters and mismatched English fallbacks. Derive TypeScript's
  discriminated `MessageRef` union and JSON Schema from that same registry, and
  check generated files for drift in CI. Do not maintain three independent lists.
- Reader validation: validate the version and structural envelope first, then
  check each ID against the reader's registry. A future ID must be recoverable
  through the saved fallback, not make an otherwise usable briefing disappear.
  The closed producer schema therefore must not be the viewer's sole load gate.

Keep the envelope schema separate from the closed ID schema, with explicit
exports for producer validation and tolerant read validation. Unknown whole
briefing versions are not presumed compatible: display an unsupported-version
state and preserve access to the original artifact; do not interpret its claims.

## Parameters and catalogue ownership

The registry permits bounded JSON data, never arbitrary nested message trees.
Every ID specifies names, units, precision and allowed enums/structured lists.
Registry examples must cover:

| Message family | Facts carried as parameters |
|---|---|
| Synoptic | Strengthening flag, position band and compass enum; system IDs, pressure, coordinates, motion, run/regime IDs for professional prose |
| Missing attribution | Reason enum: `no_prepared_run` or `no_tracked_systems` |
| Leg conditions | Literal leg name/ID, wind-strength enum, finite wind/gust/sea values, UTC occupancy endpoints; separate no-data ID |
| Ensemble | Integer `exceed`/`total`, limit value/unit, rule/model ID, UTC time, literal leg name where used |
| Decision | Verdict-specific ID; distinct numeric-driver and ensemble-driver messages |
| Gates | Status-specific ID; gate/port name, UTC transit interval, structured timing rule and verification flag |
| Coverage | Capability enums, status and typed detail/reason codes; ordered lists for unassessed and partial coverage |
| Update | Model ID and frozen `expected_at`; separate unavailable ID |
| Emulation | Evidence IDs and fixed disclosure message |

Reject non-finite numbers; scenario counts require `0 <= exceed <= total` and
`total > 0`. Use unit enums (not English phrases), full UTC timestamps and explicit
formatting rules. Keep the existing numeric rounding, UTC timezone and English
`fmtTime` output initially; French may translate month/day names but must not
change instants or measurement values. No implicit unit conversion. Test plural
forms for zero, one and many; a catalogue formats its own lists and grammar.

Do not pass `phraseExceedance(...)`, `positionPhrase(...)`, coverage `detail` or
`gate.rule_text` as a supposedly translatable string parameter. Introduce typed
facts at the source of those phrases, or retain the whole register on the legacy
path until those inputs are available. Do not reverse-parse English to recover
facts. This dependency is particularly relevant to findings/gate contracts and
needs a separate reviewed slice before claiming full briefing coverage.

Route/leg names, bulletin references and model IDs are opaque text: preserve and
escape them through React text nodes, even if they look like English vocabulary.
Official bulletin bodies remain verbatim source material with provenance; they
are not catalogue templates. No `innerHTML`, evaluation or remote catalogue fetch.

Each ID must have matching EN/FR parameter signatures and reviewed safety
semantics. The engine decides thresholds, warning precedence, coverage and
availability; the translator cannot recalculate them. Preserve raw scenario-count
wording, the uncalibrated-probability caveat, unavailable-input qualifications,
emulated badges and the absence-of-warning caveat. No “GO” or stronger safety claim.

## Viewer rendering and fallback

Introduce a pure `renderMessage`/`renderRegister` API and a small React component
subscribed to the language store. Return text plus a status (`translated`,
`legacy`, `fallback`) so missing translations are testable without matching prose.
Title, register and availability reason are separate fallback units.

| Input | Rendering behaviour |
|---|---|
| Version 2, all IDs/params/locale entries valid | Render from catalogue, including English |
| Version 2, one unknown ID, invalid parameter or absent locale entry | Show the entire stored English field unchanged; mark that field's fallback status |
| Version 1 | Use stored fields and the legacy translator; no inferred message IDs |
| Unsupported version or missing usable fallback in malformed data | Show explicit unavailable/unsupported content state; preserve the remaining usable sections and source artifact |

Never drop an unknown sentence or mix individually translated sentences with
fallback fragments inside one register. In French, visibly label a version-2
fallback as original English text with a fixed translated UI label; in English,
the status still feeds diagnostics/tests. Do not infer a favourable verdict from
a rendering error. Keep warning ordering, authority and emulation indicators
based on structured findings/evidence regardless of message rendering status.

Mark message-rendered nodes with a new explicit attribute, for example
`data-i18n-owned="message"`. Change both text and attribute traversal in
`LocalizedDocument` to skip these nodes and descendants, including the EN restore
pass and mutation-target path. This marker is proposed: no such exclusion exists
today. New fallback English also stays inside this boundary so `FR_FRAGMENTS`
cannot alter it. Legacy content keeps the current path during migration.

Audit each consumer, not just `StorySection`: first-sentence previews must derive
from the selected locale's rendered message, and the unsupported-coverage override
must use typed messages or remain explicitly legacy. Findings event consequences
and changes-page prose stay outside this initial contract. Printing must preserve
the selected locale; CLI `--print` continues using canonical saved English.

## Migration and deployment

1. Ship readers first: accept versions 1 and 2, add catalogue rendering, fallback
   statuses and ownership boundaries. Test with synthetic version-2 fixtures
   before any producer emits them. Wire every briefing consumer during this reader
   rollout, including previews and coverage overrides; catalogue helpers alone
   are insufficient. Keep all archived version-1 fixtures intact.
2. Ship the pure registry/English renderer and migrate producers in bounded
   families. During partial conversion, keep emitting version 1; exercise proposed
   version-2 objects in tests. Switch to version 2 only when every required field,
   including leg registers and reasons, can be emitted with typed messages.
3. Generate new version-2 snapshots with the same English field bytes and facts.
   Metadata/version changes intentionally alter whole JSON bytes: future producer
   steps must explicitly authorize those changes in their tracker rows. Compare
   a projection without new metadata/version against old goldens; verify English,
   evidence IDs, order, verdict and forecast facts remain identical. This design
   step changes neither goldens nor demo fixtures.
4. Load old files through an in-memory adapter that tags them `legacy` for rendering.
   Do not rewrite IndexedDB, filesystem or served artifacts, bump their IDs, fetch
   newer forecasts or rerun the analysis. No storage-version bump is needed for
   storing an extra property in the existing serialized briefing payload.
5. Keep legacy EN/FR translation while old snapshots are supported. Remove only
   patterns proven unused by *all* remaining callers/corpora. Retain an isolated
   legacy translator if the new UI no longer needs the global path. Removing old
   snapshot support is a separate product decision, not a cleanup side effect.

Compatibility: new reader + old writer uses legacy rendering; new reader + new
writer uses IDs; an older current reader can display retained English fields
but may have incomplete French patterns. Existing schema permissiveness is not
a deployment guarantee: test the actual old reader before rollout. Rollback the
writer to version 1 while retaining the dual reader; already-saved version-2
artifacts must remain readable. Never rewrite snapshots to roll back.

## Acceptance tests for implementation

- Validate old compatibility/demo/golden briefings against version 1 unchanged;
  validate new full sections and legs against version 2 in TypeScript/AJV and the
  Python contract tests. Negative cases cover wrong versions, missing message
  fields, extra/missing params, invalid dates/counts/units and empty registers.
- Registry exhaustiveness: every emitted ID exists in EN and FR with matching
  parameter signatures. Enumerate conditional branches, not only demo outputs.
  Prove an English wording-only change does not affect French lookup.
- Preserve canonical-English output bytes, evidence linkage, order, verdicts and
  numeric values across old and new renderers. Explicitly cover warning override,
  emulation, insufficient data, no next run, both missing-synoptic reasons, every
  wind/verdict/gate variant, ensemble fractions and partial/unassessed coverage.
- Verify unknown IDs, malformed params, missing French entries and mixed-validity
  arrays fall back to the whole saved field without a crash or dropped caveat.
  Test malicious-looking names as escaped literal text.
- Exercise local and served version-1/version-2 snapshots, repeated EN→FR→EN,
  asynchronous load, mutation handling, titles/attributes, professional register,
  per-leg text, first-sentence previews, coverage overrides and print output.
  Assert owned nodes bypass both fragment translation and English restoration.
- Run the campaign guardrails and desktop/mobile EN/FR browser screenshots.
  Keep existing archival fixtures; add version-2 fixtures separately. Update
  coverage classifications deliberately, never broadly allowlist new leaks.

## Proposed implementation slices after review

These are a dependency plan, not newly authorized runtime changes or active rows.
The next current tracker step remains 3.6.

1. Contract/registry and reader foundation: closed writer schema, tolerant reader,
   generated types, EN/FR renderer and validation/fallback fixtures. No emission
   switch; include Python schema parity and message-owned DOM boundary tests.
2. Structured prose inputs: enumerate briefing branches and introduce typed gate,
   coverage and helper facts wherever English is currently passed through. Review
   any findings-contract additions separately; keep existing prose byte-identical.
3. Viewer consumer rollout: wire all briefing consumers, previews and coverage
   overrides using synthetic version-2 fixtures; verify EN/FR, print and old/new
   snapshot behaviour on the real viewer before activating the new producer.
4. Engine emission: map all briefing sections, leg registers and reasons, preserve
   canonical English, then activate version 2 after the dual reader is deployed.
   Explicitly authorize metadata-only golden/demo changes and retain archived
   version-1 cases.
5. Remaining engine prose: separately design findings consequences/diagnostics and
   change-story contracts, migrate their consumers, then assess regex retirement.

Review should confirm the version-2 boundary, whole-field fallback, retained
English ownership, structured-input dependencies and these acceptance criteria
before assigning implementation step IDs. No external dependency is selected by
this design; use the existing TypeScript/React/JSON Schema toolchain.
