# Passage by DeepRegatta — product brief

_Maintained brief, updated 2026-07-22._

## Purpose

Passage is an explainable passage-weather risk audit for sailors. It helps a
skipper understand which forecast event matters, where and when it intersects
the route, which personal limits it challenges, and what changed between model
runs. It is a decision aid, not an authority and never a substitute for an
official marine forecast or the skipper's judgment.

The public product name is **Passage by DeepRegatta**. `deepweather` is retained
only in internal package names, commands, and storage keys.

## Product promise

Passage combines three things that must remain visible in the interface:

1. **Causal explanation.** Describe the weather system, connect it to the
   route and timing, and explain the consequence in plain language.
2. **Inspectible evidence.** Every material claim is traceable to a rule,
   source, model run, route segment, and valid time.
3. **Earned trust.** Separate scenario-exceedance fractions from calibrated
   probability, disclose unsupported hazards and coverage gaps, and exclude
   emulated cases from skill claims.

## Current product surface

The browser application follows a four-stage passage cycle:

- **Plan** — draw or compute a route, compare departure windows, choose a boat
  polar, declare limits, and manage browser-local briefings.
- **Brief** — read the causal story and decision summary, follow the shared
  passage-time cursor, and inspect exact evidence.
- **Watch** — compare immutable forecast snapshots and review the edited change
  story plus the full change ledger.
- **Verify** — inspect the real-case corpus, calibration sample sizes, and
  frozen case studies, with emulated demonstrations clearly excluded.

The interface supports English and French, browser-local 24-hour time with an
explicit timezone, deep-linked stages, desktop and mobile navigation, and
browser-local persistence. The current live surface is still a prototype; its
safety and calibration claims must remain conservative.

## Scope

The working scope is coastal passages of roughly 6–36 hours in Atlantic Europe
and the western Mediterranean. Route input may be supplied as waypoints/GPX or
computed from endpoints using weather-dependent isochrone routing and boat
polars. Forecast analysis includes route-timed wind and gusts, sea state,
currents, model/ensemble disagreement, synoptic features, official warnings,
and evidence coverage where the configured sources support them.

Passage explicitly does not issue a “GO” decision. Official warnings are shown
as a separate authority state above personal-limit assessments. Hazards that
are unsupported or locally under-resolved must be disclosed in the briefing.

## Data and computation principles

- Per-user route analysis runs in the browser through the pure TypeScript
  `engine/`; it has no DOM or weather-API dependency.
- Route-independent preparation runs in `analysis/` and publishes versioned
  JSON artifacts. Forecast grids come from immutable PFT1 tiles produced by
  the separate `forecast-tiles` pipeline.
- Inputs and findings are frozen into immutable snapshots so comparisons and
  later verification refer to the exact forecast that the sailor saw.
- External providers use `live`, `fixture`, or `synthetic` modes. Emulated data
  carries `source_kind: "emulated"`, is visibly badged, and never contributes
  to real skill claims.
- Scenario exceedance is expressed as a count/fraction of forecast members. It
  is not presented as calibrated real-world probability without sufficient
  independent verification for that variable, region, and lead time.

Implementation boundaries and deployment details are maintained in the
[repository README](../README.md). Contract details belong in `contracts/` and
the [PFT1 format specification](forecast-tile-format.md), not in this brief.

## Maintenance rule

This document describes current product intent. Dated research, reviews, and
superseded roadmaps belong in `trashbin/`, where they remain available as
historical evidence without competing with maintained documentation.
