# Deepweather prototype review

> Archived on 2026-07-22. This audit predates later implementation work; its
> test counts, screenshots, and product-gap findings are historical.

**Review date:** 2026-07-12  
**Prototype:** local React viewer at 1568 x 1003 desktop and 390 x 844 mobile  
**Reference concepts:** [main causal briefing](./passage-brief-main-briefing.png), [evidence and uncertainty](./passage-brief-evidence-uncertainty.png), [forecast-run changes](./passage-brief-forecast-changes.png)  
**Review type:** product positioning, visual fidelity, interaction design, trust/safety, responsive behavior, and implementation-level UX risks

## Executive verdict

The prototype is a strong, unusually thoughtful foundation. It already has more product integrity than most weather dashboards: it avoids "GO," separates official warnings from personal limits, exposes provenance, distinguishes raw ensemble fractions from calibrated probability, and includes a real verification concept.

However, the current experience does **not yet have the wow factor shown in the references**, and it does **not yet make the differentiator obvious enough to defend against competitors**.

The problem is not that the interface needs more decoration. The problem is that the most distinctive product idea is visually subordinate:

> The prototype currently feels like a careful route-weather dashboard with an evidence drawer. It needs to feel like a professional weather router has explained the one atmospheric event that matters, shown exactly how it reaches the boat, and proved every claim.

The underlying product thesis is differentiated. The visible product is not—yet.

### Recommendation

Proceed, but do not polish the current composition incrementally. Reframe the primary experience around a single signature interaction: **the causal passage story**.

That experience should connect, in one coordinated view:

1. the weather system;
2. its movement through time;
3. the point where it intersects the route;
4. the resulting conditions and limit crossings;
5. the safer departure window and why it is safer;
6. the evidence behind every claim;
7. what changed in the next model run;
8. what the tool later got right or wrong.

This is where the wow factor and the moat can become the same thing.

## Scorecard

| Dimension | Current score | Assessment |
|---|---:|---|
| Product thesis | 8/10 | Strong and safety-conscious in the brief and architecture. |
| Thesis visible in the UI | 4/10 | "The weather story" is often generic or missing; causal attribution is not the visual hero. |
| Reference fidelity | 4/10 | Palette and broad structure are related, but hierarchy, density, annotations, and page-specific composition differ materially. |
| Visual distinctiveness | 5/10 | Marine chart-paper language is appropriate, but the executed UI still reads as a conventional admin/dashboard shell. |
| Information design | 6/10 | The right information exists, but priority and progressive disclosure are inconsistent. |
| Trust and explainability | 7/10 conceptually; 4/10 in this build | Excellent evidence model, undermined by several visible contradictions and source-labeling failures. |
| Competitive differentiation | 5/10 today; 8/10 potential | Common route-risk features are present; the causal/verification wedge is not yet demonstrated. |
| Desktop usability | 7/10 | Functional and legible, but too much empty space and important content falls below the first view. |
| Mobile usability | 2/10 | The fixed 176 px rail consumes almost half the viewport; briefing charts overflow and become unreadable. |
| Technical prototype health | 8/10 | 69 engine tests pass and production build succeeds; viewer-level regression coverage is missing. |

## What is already working well

### 1. The safety framing is substantially better than category norms

- No "GO" wording.
- Official warnings have a separate authority color and band.
- Personal limits are framed as declared limits, not skill categories.
- "Agreement is not proof" is repeated consistently.
- Raw scenario fractions are explicitly distinguished from calibrated probabilities.
- Unsupported hazards and emulated sources exist in the data model.

These are not cosmetic details. They communicate a serious product philosophy and should remain non-negotiable.

### 2. The evidence inspector is a real product asset

The right-side inspector is the most successful translation of the references. It gives rule, route segment, time, source, run, source age, and value versus limit in one place. The dotted-underlined evidence-link convention is also good: it creates a learnable visual grammar.

This mechanism should become more prominent, not less. On desktop, the product can reserve a persistent evidence column for the currently focused claim, as in the AI reference, rather than hide it behind every click.

### 3. The visual language is appropriate

The chart-paper background, ink navy, shallow-water blue, restrained amber/red, and chart-magenta authority color all fit the subject. The product avoids the generic dark SaaS dashboard look.

The palette is already close to a useful system:

| Token | Current value | Role |
|---|---:|---|
| Chart paper | `#F3EEE3` | Main working surface |
| Deep ink | `#0C1A2C` | Navigation, structure, selected states |
| Ink | `#16283E` | Primary text, route, principal data line |
| Shoal water | `#DCE5E6` | Supporting field and uncertainty surfaces |
| Limit amber | `#A87718` | Approaching-limit state |
| Authority magenta | `#9E2B63` | Official warning/source authority only |

The issue is hierarchy and execution, not the palette itself.

### 4. The route, evidence, changes, and verification architecture is unusually coherent

The prototype already contains the right long-term objects: immutable snapshots, evidence IDs, comparison between model runs, an observation-matching page, and a calibration record. That is far more defensible than adding an AI-generated paragraph to a forecast map.

## Critical trust issues to fix before visual polish

These are P0 because they can make the interface tell two incompatible stories.

### P0.1 — The official warning can be emulated without being visibly labeled as emulated

In the audited snapshot, the authority band says **Official warning active**, but its evidence object is `source_kind: "emulated"` and model `Météo-France BMS (synthetic)`. The prominent banner has no EMULATED stamp and no direct evidence or bulletin action. The only disclosure is buried inside the collapsed "Why this assessment" content.

This violates the repository's own rule that every emulated value must carry a visible badge. It is especially risky because chart-magenta is reserved for real authority.

**Required behavior:**

- If the source is emulated, the warning banner must say `EMULATED WARNING SCENARIO` before any authority language.
- A synthetic warning must never visually impersonate a live Météo-France warning.
- The banner must link to the bulletin/evidence record and show source freshness.
- Production mode should be able to refuse to render an authority state from emulated data.

### P0.2 — The same briefing says warnings are both active and unsupported

The selected briefing contains an active official warning section and later says:

> This briefing does NOT cover: tidal currents & gates, official marine warnings, tropical systems, ice.

That contradiction is present in `data/processed/snapshots/20260720T060000Z_44d2cd5f_4196266b/briefing.json`.

**Required behavior:** generate the unsupported list from actual capability and source status for that snapshot, never from a static list. A capability can be `assessed`, `assessed with emulated data`, `partially assessed`, or `not assessed`; it cannot be active and unsupported simultaneously.

### P0.3 — The evidence headline and primary chart can represent different variables

On the audited L2 evidence page, the headline says:

> 9 of 51 forecast scenarios exceed your 18 kt **wind** limit.

The primary panel is hard-coded as a **wind gust** plume. Its limit comes from `leg.gust_limit_kt`, while the headline selects the worst ensemble evidence of either wind or gust. This is visible in `viewer/src/pages/Evidence.jsx` and `viewer/src/components/EnsemblePlume.jsx`.

The result is not merely mislabeled: the plotted limit can be outside the chart extent and disappear, so the user sees an exceedance claim without the corresponding threshold or highlighted window.

**Required behavior:** the selected evidence object must drive the chart variable, units, threshold, time window, annotation, and inspector. One source of truth, one story.

### P0.4 — "Read the bulletin" has no bulletin action

The warning strip repeatedly instructs the sailor to read the bulletin, but it is not a button or link. A safety-critical instruction must have an immediate action.

**Required behavior:** provide `Open official bulletin`, source, issued time, validity, affected zones, and an explicit stale/unavailable state.

### P0.5 — The causal story silently degrades to generic copy

The selected snapshot has no `synoptic_story` section, so the main card falls back to **The forecast at a glance**. That fallback removes the product's main differentiator without signaling that the synoptic analysis is unavailable.

**Required behavior:**

- Never silently substitute a generic dashboard summary for the causal story.
- Show `Causal attribution unavailable for this run` with the missing input/reason.
- A release/demo snapshot intended to prove the product must contain an actual system → route → impact story.

## Reference screenshot fidelity review

The brief says the concepts are a direction rather than a locked component spec. Exact pixel matching is not the goal. However, the implementation currently diverges from the references in the very choices that create their impact: information hierarchy, integrated storytelling, annotation density, and page-specific composition.

### Reference 1 — Main causal briefing

**What the reference achieves**

- Edge-to-edge working surface with almost no wasted space.
- Route, departure, and personal-limit state in a single top instrument bar.
- The synoptic map occupies the dominant left half and explains the causal system visually.
- The weather story is large, editorial, and specific: a named event plus a route consequence.
- The timeline is integrated into the first screen, aligned with route legs and a causal event marker.
- Evidence/run status is a compact footer, not a separate dashboard section.

**What the implementation does instead**

- A persistent 176 px sidebar and `max-w-6xl` content container create a conventional app shell and unused desktop space.
- A generic Leaflet basemap is the default hero; the actual synoptic chart is behind a tab.
- The route markers and wind arrows cluster, while the weather system that causes them is absent from the main state.
- The story card can be mostly empty, with a generic fallback title and two bullets.
- The timeline is a separate card below the hero and does not visually connect its event to the map or narrative.
- Typography is much smaller and less confident than the reference, reducing both drama and scanability.

**Verdict:** related visual language, different product experience. The implementation preserves the dashboard shape but loses the reference's causal thesis.

### Reference 2 — Evidence and uncertainty

**What the reference achieves**

- The raw count and percentage are the first visual fact.
- The ensemble plume dominates the page.
- The user's limit, exceedance interval, scenario lines, median, and envelope are all visibly annotated.
- A persistent evidence inspector makes provenance part of the composition.
- Deterministic model disagreement is secondary but still tied to the same interval.

**What the implementation does instead**

- A large page title and explanatory paragraphs consume the top hierarchy.
- The key count is present but visually modest.
- No separate percentage is shown.
- The evidence inspector is closed by default.
- Chart annotations are too subtle, and in the audited case the wrong-variable threshold is not visible.
- The model comparison is clean but generic; it lacks the strong interval callout shown in the concept.

**Verdict:** the correct components exist, but the reference's hierarchy and teaching value are not reproduced.

### Reference 3 — Forecast-run changes

**What the reference achieves**

- A single sentence summarizes the causal change.
- Previous and latest synoptic maps are compared side by side.
- Three material changes form an edited ledger, not an exhaustive log.
- The event-time shift is visualized as a before/after timeline.
- The page ends with a concrete reassessment action and next-run time.

**What the implementation does instead**

- It presents a 31-entry engineering diff ledger.
- Rule IDs and raw values dominate the page.
- There is no synoptic before/after comparison.
- There is no visual movement of the key event.
- Cleared low-level signals overwhelm the decision-relevant changes.
- One item reads `New signal A-WARN-01 on null`, exposing internal data leakage.

**Verdict:** functionally useful for debugging, not yet a sailor-facing "what changed" experience.

## The missing wow factor

The product should spend its visual boldness in one place rather than add animation and decoration everywhere.

### Proposed signature: Causal Briefing Playback

The memorable interaction should be a synchronized, scrub-able causal sequence:

```text
T+0           T+12            T+24             T+36
low deepens ─ front approaches ─ route intersects ─ conditions ease
      │               │                │
      └─ system track ┴─ route event ───┴─ limit/evidence focus
```

As the user scrubs or plays the sequence:

- the system track advances on the synoptic chart;
- isobars tighten or relax;
- the route occupancy marker moves according to slow/nominal/fast ETA;
- the relevant route segment illuminates;
- the timeline cursor moves to the same hour;
- the story changes from cause to consequence;
- the evidence inspector updates to the exact claim in focus;
- an alternative departure ghost-route shows why a different window avoids the event.

This is not ornamental animation. It teaches the sailor the meteorological reasoning and makes the product legible in seconds.

### Why this is stronger than a conventional dashboard

Most competitors answer **what conditions are expected** and **which window scores better**. The signature above answers:

> What atmospheric event causes the risk, when does my boat meet it, how sensitive is that meeting to ETA and departure time, and what evidence supports the claim?

That is the professional-router mental model described in the brief.

## Competitive differentiation review

The current market makes several prototype features table stakes rather than differentiators.

### What competitors already claim

| Product | Current relevant claims | Implication for deepweather |
|---|---|---|
| TidePilot | Route- and boat-specific briefs, personal/crew limits, per-leg ETA conditions, 30+ models and observations, alternative windows, advisories, and watch-until-departure updates. [Official product page](https://www.tidepilot.ai/) | Personal limits, per-leg reasoning, many models, and change alerts are not a moat. |
| SeaLegs AI | Plain-English route analysis, multiple professional models, vessel-specific GO/CAUTION/AVOID guidance, hourly breakdowns, and condition-change notifications. [Official FAQ](https://www.sealegs.ai/faq) | "AI explains marine weather simply" is already crowded and deepweather should avoid the same marketing frame. |
| NaviSight | Five-model route scoring, vessel profiles, weather overlays, PDF/GPX, departure suggestions, and planned learning from AIS/casualty/real-vessel behavior. [Official product page](https://navisight.io/) | Five-model comparison, risk scores, reports, and future learned risk are not distinctive claims. |
| PredictWind | Multi-model routing, four-way departure planning, animated routes relative to weather systems, currents, tidal currents, wave/vessel modeling, and offshore delivery. [Departure Planning](https://help.predictwind.com/en/articles/2884536-how-to-use-the-departure-planning), [subscription features](https://help.predictwind.com/en/articles/8563285-predictwind-subscriptions-differences-between-standard-and-professional) | Deepweather should not try to win on breadth, routing power, data inventory, or offshore ecosystem. |

### What can actually be differentiated

| Candidate claim | Current market pressure | Deepweather opportunity | Current proof in prototype |
|---|---|---|---|
| Personal limits on a route | High | Necessary, not a headline | Good |
| Multi-model comparison | Very high | Necessary evidence layer | Good but conventional |
| Departure-window comparison | High | Explain causally, not just rank | Basic list only |
| Plain-language briefing | High | Make it bounded, sourced, and meteorologically causal | Partial |
| Synoptic attribution | Lower | **Core differentiator:** name/track the system and connect it to route impact | Hidden behind a tab; often missing |
| Claim-level provenance | Medium | **Strong differentiator:** rule + model + run + segment + value | Strong foundation |
| Honest uncertainty semantics | Medium | **Strong trust differentiator:** scenario fractions, disagreement, and data limits remain separate | Strong concept; chart mismatch weakens it |
| Published post-trip verification | Low | **Potential moat:** show where the tool was wrong, by region/lead/variable | Skeleton exists; current records are emulated |
| Open/self-hostable audit | Low | Valuable to technical sailors and integrations | Not visible in product |

### Innovation verdict

**Is it innovative enough today?** No, not in the visible prototype. A user could reasonably summarize it as "a nicer, more honest PredictWind/TidePilot-style dashboard."

**Can it become genuinely differentiated?** Yes. The combination below is unusual and coherent:

1. deterministic synoptic attribution;
2. route/ETA intersection with that synoptic event;
3. claim-level evidence;
4. separate uncertainty semantics;
5. official-warning authority state;
6. published verification and calibration record.

The product must make this combination the main workflow and demonstrate it on real archived cases. It cannot remain architecture behind a generic map-and-chart interface.

## Product strategy: what to emphasize and what to stop emphasizing

### Emphasize

- **"Why this happens"**, not just maximum values.
- **Event interception:** when the boat meets the front/regime/low.
- **Counterfactual reasoning:** why six hours earlier avoids it.
- **Inspectable claims:** every sentence resolves to evidence.
- **Forecast evolution:** what changed causally between model runs.
- **Earned trust:** what the system previously forecast versus what was observed.
- **Europe-first local seamanship:** tidal gates, wind-against-current, BMS zones, under-resolved passages.

### De-emphasize

- Number of weather models as a marketing headline.
- Generic "AI marine intelligence" language.
- A single score or confidence percentage.
- Breadth of worldwide coverage.
- Competing with established routing engines on fastest route.
- An exhaustive engineering diff presented directly to sailors.

## Proposed information architecture

The current seven-item navigation is serviceable, but the product story would be stronger as a four-stage sailor workflow:

```text
PLAN → BRIEF → WATCH → VERIFY
  │       │       │        │
route   causal   what     track
limits  story    changed  record
window  evidence alerts   cases
```

Recommended primary navigation:

1. **Plan** — route, departure, boat, declared limits, candidate windows.
2. **Brief** — causal story, passage chart, timeline, uncertainty, evidence.
3. **Watch** — model-run changes, warning changes, next update, saved passage status.
4. **Verify** — past passages, forecast/observation match, calibration record.

`My briefings`, `Deep dive`, and `My limits` can remain as subviews or contextual actions. This reduces the feeling of an admin console and makes the product's lifecycle explicit.

## Visual direction

### Keep

- Chart-paper, navy ink, shoal-water wash, and restricted warning colors.
- Serif for authored meteorological narrative.
- Condensed utility labels and monospaced values.
- Hairlines, title blocks, route-leg numbering, and evidence underlines.

### Change

- Replace system-dependent serif fallbacks with shipped web fonts so the intended character is consistent.
- Use a more deliberate role system: a readable editorial serif for the weather story, a narrow maritime/instrument sans for headings and controls, and a mono face only for timestamps, rules, and values.
- Increase the main story headline and reduce explanatory page-title copy.
- Stop wrapping every region in the same light card. Use chart borders and sectional rules to create one composed briefing surface.
- Make the synoptic chart, route, timeline, and story share a common time cursor and event color.
- Use authority magenta only for official, verified authority data; use a clearly separate test-pattern treatment for emulation.

### The one aesthetic risk worth taking

Make the main briefing resemble a **living pilot chart / router's annotated desk sheet**, not a web dashboard. Use hand-authored-looking meteorological callouts, restrained grease-pencil event marks, and a synchronized time ruler spanning the map and timeline. The evidence remains digitally precise; the annotation layer gives the product memory and character.

## Responsive and accessibility review

### Mobile is currently broken for the briefing

At 390 px:

- The fixed 176 px sidebar uses 45% of the viewport.
- The briefing document reports a 466 px scroll width, causing horizontal overflow.
- Route, story, and charts collapse into columns that are too narrow to read.
- Timeline legends and leg labels overlap heavily.
- The authority band and route title wrap into a tall, fragmented header.

The planner technically avoids horizontal overflow but leaves only ~214 px for the main content, making the map and form impractical.

### Required responsive model

- Below 768 px, replace the rail with a compact top bar and bottom four-item workflow navigation.
- Make the mobile briefing a narrative sequence: decision → one-sentence cause → route event → key timeline → evidence action.
- Use a full-screen chart mode for map/plume interactions.
- Convert dense tables into labeled rows or horizontally scrollable regions with clear affordance.
- Set mobile-specific ECharts grid margins and label density; do not merely shrink desktop charts.
- Keep touch targets at least 44 x 44 px.

### Accessibility positives

- Semantic buttons are used extensively.
- Keyboard focus styles exist.
- Reduced-motion support is present.
- Several charts expose SVG text to the accessibility tree.

### Accessibility gaps

- No skip link or mobile navigation alternative.
- The inspector uses `role="dialog"` but does not visibly demonstrate focus trapping or focus return.
- Color carries a large amount of route-status meaning; markers also need durable text/pattern semantics.
- Dense chart content needs a concise table/text alternative tied to the selected event.
- Tooltip-only glossary definitions are not sufficient for touch and keyboard users unless they are focusable.

## Performance and implementation observations

- Engine test suite: **69/69 passing**.
- Production build: **successful**.
- The viewer currently has no dedicated test suite in the root test run.
- The ECharts bundle is approximately **1.05 MB minified / 348.94 kB gzip**, which triggers the Vite chunk warning.
- Leaflet is approximately **296 kB minified / 90.58 kB gzip**.
- The only browser-console issue observed in the core flow was a missing `favicon.ico`; additional 404s occurred on the Track record page when the selected future snapshot had no verification case.

Recommended implementation work:

- Add route-level viewer regression tests for warning provenance, variable/limit alignment, missing synoptic attribution, and unsupported-capability text.
- Add Playwright visual checkpoints at 1568 x 1003 and 390 x 844.
- Lazy-load ECharts and Leaflet by route or view.
- Give verification fetches explicit empty-state handling without noisy 404 console failures.
- Add a compact snapshot fixture whose content exactly exercises all three reference screens.

## Prioritized redesign plan

### P0 — Restore trust and internal consistency

| Work | Size | Acceptance criterion |
|---|---:|---|
| Source-kind treatment for official warnings | S | Synthetic warnings can never render as real authority; banner includes visible source-kind badge and evidence action. |
| Dynamic assessed/unsupported capability list | S–M | No snapshot can list a capability as both active and unsupported. |
| Evidence-driven chart selection | M | Headline variable, chart series, units, threshold, interval, and inspector always originate from the same evidence claim. |
| Bulletin action and freshness | M | Every active warning has a source, issued/valid time, freshness, and working action or an explicit unavailable state. |
| Causal-story availability state | S | Missing synoptic attribution is explicit; no silent generic fallback. |
| Mobile shell replacement | M | No horizontal overflow at 390 px; navigation consumes no permanent content column. |

### P1 — Deliver the reference-level experience and wow factor

| Work | Size | Acceptance criterion |
|---|---:|---|
| Recompose the main briefing | L | At 1568 x 1003, system, route, story, key timeline, verdict, and evidence status are visible in the first screen. |
| Causal Briefing Playback | L | A single time control synchronizes synoptic chart, route occupancy, timeline, narrative, and evidence. |
| Evidence page hierarchy | M | Raw count and fraction are dominant; selected threshold and exceedance interval are unmistakable; inspector is persistent on desktop. |
| Edited change story | M–L | The page leads with one causal sentence, at most three decision-relevant changes, before an optional full ledger. |
| Before/after synoptic comparison | M | Previous/latest system position, pressure, and route intersection are visually comparable. |
| Web-font and type-scale system | S–M | Rendering is consistent across OSes and the weather story has a recognizable voice. |

### P2 — Build the defensible product moat

| Work | Size | Acceptance criterion |
|---|---:|---|
| Structured causal-event object | L | A system/event has stable identity across runs and links cause → route intersection → effects → evidence. |
| Counterfactual departure explanation | L | Alternative windows state not only that they score better, but which event they avoid and by how much. |
| Real verification corpus | L | At least ten target-water cases use independently classified observations; emulated records are excluded from skill claims. |
| Public case-study format | M | A shareable report shows the original forecast, later observations, errors, and corrected interpretation. |
| Europe-first seamanship layer | L | Named tidal gates, wind-against-current events, BMS zones, and local resolution caveats are first-class story elements. |

## Concrete acceptance checklist for the next design iteration

### Desktop briefing

- [ ] The first screen answers: What is happening? Where? When does the boat meet it? What should be rechecked?
- [ ] Synoptic cause is visible without selecting a secondary tab.
- [ ] One event uses the same name, color, and timestamp on map, timeline, story, and evidence.
- [ ] Official warnings are actionable and source-labeled.
- [ ] Synthetic data is unmistakable from five feet away.
- [ ] The weather story never falls back silently to generic copy.
- [ ] No more than three key route facts appear before expansion.

### Evidence

- [ ] Headline and chart refer to the same variable and rule.
- [ ] Count, total, and percentage are visible without calculation.
- [ ] Limit line is always in range and labeled.
- [ ] Exceedance interval is visually obvious.
- [ ] Raw fraction is never labeled as calibrated probability.
- [ ] Inspector shows source, run, age, route segment, time, value, limit, and source kind.

### Changes

- [ ] One sentence explains the causal change.
- [ ] Previous and latest synoptic states are comparable.
- [ ] At most three material changes appear before the full ledger.
- [ ] Event-time shift is visualized.
- [ ] The next-run time and reassessment action are prominent.
- [ ] No internal nulls, raw enum names, or unexplained rule IDs appear in primary copy.

### Mobile

- [ ] No permanent side rail below 768 px.
- [ ] No horizontal document overflow at 390 px.
- [ ] Map and charts have full-screen inspection modes.
- [ ] Main decision and cause are understandable without opening a chart.
- [ ] All actions have touch-sized targets.

## Final point of view

The prototype is good because it has discipline. It avoids many dangerous shortcuts that competitors and AI-generated designs normalize. But discipline alone does not create desire, and the current visual implementation makes the product look more conventional than the thinking behind it.

Do not chase wow with more cards, gradients, or scattered animation. Make the causal explanation itself spectacular:

> **Show the weather system moving toward the route, show the boat's ETA envelope intersecting it, show the exact limit that changes, and show why another departure avoids it—all with evidence one click away.**

If deepweather delivers that experience and later publishes where it was right and wrong, it can be meaningfully different. If it remains a route map, a verdict chip, multi-model charts, and an AI-style summary, it will be entering a crowded race from behind.

## Audit artifacts

Local browser captures used in this review:

- [Desktop briefing library](./output/playwright/my-briefings-desktop.png)
- [Desktop main briefing](./output/playwright/briefing-desktop.png)
- [Desktop synoptic tab](./output/playwright/briefing-synoptic-desktop.png)
- [Desktop evidence page](./output/playwright/evidence-desktop.png)
- [Desktop evidence inspector](./output/playwright/evidence-inspector.png)
- [Desktop change ledger](./output/playwright/changes-desktop.png)
- [Desktop track record](./output/playwright/track-record-desktop.png)
- [Desktop planner](./output/playwright/planner-desktop.png)
- [Mobile briefing](./output/playwright/briefing-mobile.png)
- [Mobile planner](./output/playwright/planner-mobile.png)
