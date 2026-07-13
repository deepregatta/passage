# Passage Risk Audit — explainable weather analysis for sailors

*Project brief v2 — 2026-07-11. Full rewrite after external review: repositioned away from "go/no-go dashboard" (a crowded category), technical corrections folded in. `deepweather` is the internal project code name only — the product name will be chosen later (see §14). No code exists yet.*

---

## 1. Vision

A sailor preparing a passage doesn't just need numbers along a route — TidePilot, SeaLegs AI, NaviSight, PredictWind, and newer briefing tools already provide versions of that. The opportunity is to bring a consumer tool closer to the causal, evidence-backed explanation a **professional weather router** provides:

> *"A depression is deepening west of Ireland and will drive its cold front across your route Thursday evening — expect the SW wind to veer NW and strengthen to 25–30 kt behind it, with a rain band and a 2 m cross-swell developing. If you leave Wednesday morning you're in port before it arrives; if you must leave Thursday, the front is the event to plan around."*

That is a different product from a verdict badge. It explains the **weather system causing the conditions**, not just the conditions — which is what lets a skipper reason for themselves when the forecast shifts.

The app is therefore an **explainable, Europe-first forecast-risk audit for the sailor's route** — provided as GPX/waypoints, or computed from start and finish via integrated sail routing (§4.0) — built on three pillars:

1. **Synoptic analysis, not just route weather.** The app detects and tracks pressure systems, front-like transitions, and named regional wind regimes such as the Mistral, relates them to the user's route and timing, and produces a structured first-pass briefing for the skipper to interrogate.
2. **Explainability.** Every statement links to its evidence: the rule that fired, the model and run that produced the value, the route segment and hour it applies to. Before calibration, ensemble output is described as the *fraction of forecast scenarios exceeding the user's declared limits*, never as an unexplained "92% confidence".
3. **Verification.** From the first prototype, every forecast analysis is snapshotted and later compared against independently observed conditions where coverage permits. Calibration is a target that must be earned and displayed with its sample size and observation coverage, not claimed at launch.

Every explanation is written at **two registers at once**: a plain-language layer any amateur can act on, and an expandable professional layer (values, pressures, model details, reasoning) — see §8.

## 2. Competitive positioning (honest version)

The verdict-on-a-route category is crowded: **TidePilot** (per-leg ETA forecasts, personal limits, Favorable/Amber/No-Go, confidence %, trip watch), **SeaLegs AI** (Go/Caution/Avoid, vessel-tailored, multi-model), **NaviSight** (risk scores, 5-model comparison, departure windows), **PredictWind** (departure planning, model agreement guidance, GMDSS warnings). Competing on their ground is pointless; their existence validates the demand.

The narrower combination this project targets is **deterministic synoptic attribution + route-level evidence + an eventually published calibration record**. Individual competitors already offer parts of that combination — including AI briefings, inspectable route evidence, and model-disagreement views — so the differentiation must be demonstrated in working reports rather than asserted broadly.

| Gap | What we build |
|---|---|
| **The "why"** | Synoptic-scale narrative: which systems drive the forecast, how they evolve, which one is the threat, what to watch |
| **Show-your-work** | Every verdict traceable to rule + model + value + segment; no black-box scores |
| **Honest uncertainty** | Raw ensemble scenario fractions first; calibrated threshold-exceedance probabilities only after sufficient verification; model disagreement shown separately |
| **Official warnings** | Marine bulletins (BMS/gale warnings) as a separate authority state that overrides the personal-limit summary, not fine print |
| **Earned calibration** | Post-trip verification against independent observations, published with coverage and sample-size caveats |
| **Ownership** | Open/self-hostable personal tool; potential API/plugin rather than another chartplotter |

## 3. Scope

### v1 (narrow, but covering the author's waters)
- **Coastal passages of 6–36 hours in Atlantic Europe and the Western Mediterranean.** Atlantic Europe (Channel, Brittany, Biscay) is the author's home region and the primary proving ground; the Western Med stays in scope for its generic hazards, with the named-regime pattern rules (Mistral/Tramontane) arriving in Phase 2.
- **Tides and currents are v1 scope, not deferred.** This is the non-negotiable consequence of including the Atlantic (and was the review's condition for it): in the Channel and Brittany, tide dominates both safety (wind-against-current seas, timing at gates like the Raz de Sein or Alderney Race) and ETA. v1 covers: current-corrected speed over ground and ETAs, wind-against-current flags, and adverse-current gates at named passages.
- **Route input, two modes:**
  - **Route provided** (v1 core): GPX import or waypoints clicked on a map — the analysis layer over the sailor's own route.
  - **Start + finish** (Phase 2): the app computes a realistic candidate route via an integrated open-source sail-routing engine (polars, coastline avoidance, currents), then runs the exact same analysis on it (§4.0). Routing is route *acquisition* feeding the analysis — the product is still the audit, not another router.
- **ETA uncertainty is explicit**: user gives slow / nominal / fast speeds (or a polar scaling); every leg gets an ETA *range*, current-corrected, and conditions are evaluated across that range, not at a single fictional instant.
- Single user, English first, on-demand analysis + snapshot recording.

### Explicitly deferred (and why)
- **Race-start mode** — a different product needing much finer spatial/temporal resolution.
- **A→B straight-line corridor inference** — a straight line + average speed can cross land and misplace the boat by hours; replaced by route input (v1) and true routing (Phase 2).
- Other regions, mobile apps, accounts.

## 4. The analysis: two layers

### 4.0 Route acquisition — provided or computed

The unit of analysis is always *a route with ETA ranges*. Two ways to obtain one:

- **Provided** (v1): GPX import or map waypoints.
- **Computed** (Phase 2): for "start + finish + departure window" input, an integrated **open-source isochrone routing engine** (candidate: the Python `weatherrouting` library behind gWeatherRouting — license and fit to confirm, §13) generates the route from: a boat polar (ORC VPP database + matching ladder imported from coachregatta, §10, scaled by the slow/nominal/fast factor), GSHHG coastline data for land avoidance, forecast winds, and CMEMS currents. This resolves the review's original objection to A→B input: routing produces realistic positions and weather-dependent ETAs instead of a straight-line corridor. Multiple departure candidates couple naturally with the best-window scan.

Either way, the downstream analysis pipeline is identical — a computed route adds no special cases to the engines, and the report states which mode produced the route (a computed route inherits polar uncertainty, flagged as such).

### 4.1 Synoptic layer — "what is happening in the atmosphere"

Deterministic feature detection on gridded forecast fields (not point time series):

- **Pressure systems**: detect lows/highs from MSLP fields (local extrema + closed-contour tests), track them across forecast hours (position, central pressure, deepening/filling rate, motion vector).
- **Front-like transitions along the route**: signature screening at route points — wind veer + pressure trough + temperature/humidity change + rain band — timestamped per leg. A signature alone is not enough to distinguish a cold front from a trough, convergence line, sea-breeze boundary, or model noise. The app uses the cautious label *front-like transition* unless an official analysis or independently validated gridded diagnostic corroborates the front type.
- **Named regional regimes**, encoded as pattern rules: e.g. Mistral/Tramontane = ridge over the Bay of Biscay + low over the Gulf of Genoa → strong NW gradient flow over the Gulf of Lion, with known acceleration zones. These are *gradient-wind* events, detected from pressure patterns — **not** convection (a correction from review).
- **Trend across model runs**: is the low deepening faster than the previous run predicted? Systems that shift between runs are flagged as the source of uncertainty.

Output of this layer is **structured facts** ("low L1: 985 hPa at 52N 15W, deepening 8 hPa/24h, moving ENE 25 kt; front-like transition F1 intersects route legs 3–4 between Thu 16:00–21:00; front type unconfirmed"), which the renderer turns into appropriately qualified narrative.

### 4.2 Route layer — "what it means for your boat"

Per-leg, per-hour within each leg's ETA range:

- Wind and gusts, **course-relative** (25 kt on the beam ≠ 25 kt hard on the nose).
- Sea state, computed correctly (§5).
- Convective risk, fog/visibility (§5).
- Each condition scored against the user's **declared limits** (§7) → raw scenario-exceedance fractions, with calibrated probabilities only where verification supports them (§6).

### 4.3 The structured first-pass briefing (the deliverable)

Structured like a router's note, generated from the two layers:

1. **Synoptic situation** — the systems on the board and their evolution ("the story").
2. **Route impact, leg by leg** — expected conditions in each leg's ETA window, with the causal link back to the synoptic story.
3. **The decision** — limits assessment (§7 wording), which specific event drives it, alternative windows and why they're better ("Wednesday works because you're in port 12 h before the front").
4. **What could change** — the flagged uncertainties: which system the models disagree on, when the next model run arrives, what to re-check.
5. **Active official warnings** — always on top when present (§7).

Rendering is templated with a bounded meteorological vocabulary (rules-only decision stands). Note for later: this narrative layer is where an optional LLM writer would add the most value — the seam (facts JSON → renderer) makes it a safe, swappable upgrade since all numbers and claims come from the deterministic layer.

## 5. Hazards (v1, with corrections applied)

| Hazard | Method | Corrections from review |
|---|---|---|
| **Wind & gusts** | Sustained + gusts per leg ETA range, course-relative; gradient-wind regimes from synoptic layer | Mistral/Tramontane detected via pressure patterns, not convection |
| **Sea state** | Significant height, **wind-wave and swell components separately** (height/period/direction each); cross-sea angle; wind-against-swell | Steepness computed properly: deep-water wavelength L ≈ gT²/2π, steepness ≈ H/L — *not* H/T |
| **Convective / squalls** | CAPE + convective precipitation as a *screening* signal, clearly labeled as low-skill for localized squalls | CAPE is a weak proxy — presented as "elevated squall potential", never as a precise prediction; official warnings are the authority |
| **Fog & visibility** | Visibility fields + dew-point spread | — |
| **Tidal currents & gates** (new in v1) | CMEMS shelf-model currents sampled along legs: SOG/ETA correction; wind-against-current flag (steep breaking seas, e.g. Alderney Race, Raz de Sein); adverse-current gates at named passages timed against slack/HW | Added with the Atlantic v1 scope — the review's condition for including the region. Where shelf-model resolution is too coarse for a narrow passage, the gate is flagged as *locally under-resolved*, not silently trusted |

**Official marine warnings are a first-class authority override**, not a hazard among others: an active BMS/gale warning covering the route forces the separate "official warning active" state above the personal-limit assessment (§7). It does not claim that a particular numerical user limit was exceeded; it says that the competent authority has issued a warning. Hazards outside scope (tropical systems, ice) are **explicitly listed as unsupported in every report** so absence of a warning is never read as absence of risk.

## 6. Uncertainty: scenario exceedance first, calibrated probability later

No single blended "confidence %". The report separates four things:

1. **Scenario exceedance fraction** — per hazard, per leg: the fraction of available **atmospheric ensemble members** that exceed the user's declared limit (wind, gusts, precip). Example: "33 of 51 forecast scenarios exceed your 28 kt gust limit Thursday evening." This is not presented as a calibrated real-world probability until retrospective verification supports that interpretation for the variable, area, and lead time.
2. **Model disagreement** — deterministic runs (ECMWF, GFS, ICON, AROME where available) shown side by side, with the caveat made explicit in-product: *agreement is not proof* — models share observations and assumptions, and ECMWF's own guidance warns against over-interpreting consistent small-scale detail. Disagreement mainly tells us *when to wait for the next run*.
3. **Source freshness & coverage** — model run age, next-run time, horizon at which each model's skill fades (and where high-res coverage ends).
4. **Unsupported hazards & data limits** — what the tool did not assess (e.g. tropical systems), plus where tidal-current data is too coarse for narrow passages, stated in every report.
5. **Waves and currents are deterministic-only in v1** — Open-Meteo's Marine API provides no wave ensembles, and CMEMS shelf currents are single-model output; their uncertainty is approximated from wind-ensemble spread + model comparison, and labeled as such.

Decision guidance follows from the combination: high scenario exceedance + models agreeing → "forecast conditions are outside your declared envelope"; borderline + models diverging → "insufficient confidence, reassess after the next run (tonight 00z, available ~03:30)". The skipper, not the application, decides whether to depart or postpone.

## 7. Limits, verdicts, and wording (safety-critical design)

- Profiles are **declared operational limits**, not sailor categories. Presets ("coastal cruising — cautious", "coastal cruising — experienced") exist only as starting points that pre-fill editable limits: max sustained wind by point of sail, max gusts, max wave height, max steepness/cross-sea flag, night-sailing, minimum visibility. **No preset relaxes squall/storm tolerance** — a "racer" label must never imply thunderstorms are acceptable.
- **The app never says "GO".** Verdict states:
  - ✅ **Within your declared limits**
  - ⚠️ **Approaching your limits** (≥ ~75% of a limit, or ensemble scenario-exceedance fraction above a declared floor)
  - ⛔ **Exceeds your limits**
  - 🌀 **Insufficient forecast confidence — reassess at the next model run**
  - 🚩 **Official warning active** (separate authority state displayed above, and overriding, the personal-limit summary)
- Every verdict expands to its evidence: which limit, which leg, which hour, which model/run, which value.

## 8. Two-register explanations & chart literacy

The requirement: **deep enough for a pro, simple enough for an amateur** — same report, layered:

- **Layer 1 (everyone)**: plain language, no jargon, action-oriented. *"A storm system near Ireland is sending a band of strong wind and rain across your route Thursday evening. Leaving Wednesday morning keeps you ahead of it."*
- **Layer 2 (expand)**: the professional reasoning. *"972 hPa low at 52°N 15°W deepening 8 hPa/24 h (ECMWF 00z), trailing front-like transition crossing legs 3–4 Thu 16:00–21:00: veer SW→NW, sustained 22–28 kt, gusts 35 kt after passage, isobar spacing tightening over the Gulf of Lion. Front type unconfirmed."*
- **Layer 3 (data)**: raw values, ensemble plumes, model-by-model table, source links.
- Jargon terms are glossary-linked everywhere (front, veer, gradient wind, significant wave height…). The tool should *teach while briefing* — regular users become better forecast readers.

**Annotated charts with explanations** (the "charts" requirement) — every chart ships with an auto-generated caption saying what to look at and why it matters:

1. **Synoptic chart** — MSLP isobars rendered from gridded data with detected systems (L/H markers, tracks, front lines) and the route overlaid. Caption: *"The low marked L1 is your problem: watch how the isobars tighten over your route between the Thursday and Friday panels — tighter lines = stronger wind."* Sequence view (T+0/24/48/72) to show evolution.
2. **Route timeline** — wind/gusts/waves per hour along the passage, colored by limit status, with appropriately qualified event markers ("front-like transition", "Mistral onset").
3. **Ensemble plume / exceedance chart** — all ensemble members as thin lines, user's limit as a horizontal line, scenario-exceedance region shaded. Caption teaches how to read spread and explicitly says that member fractions are not automatically calibrated probabilities.
4. **Model comparison** — deterministic runs overlaid; divergence zones highlighted and dated ("models split after Friday 12:00 — that's why confidence drops").

## 9. Post-trip verification (in the first prototype, not "later")

The credibility engine, and a key differentiator:

- Every analysis stores an immutable **snapshot**: model runs used, fields, findings, verdicts.
- After the passage window, fetch **independent observations** from moored buoys, coastal stations, and tide gauges (Channel/Biscay coverage is good; Med patchier) via Copernicus Marine in-situ / EMODnet. Model analysis fields may be shown as contextual fallback, but are not labeled ground truth and do not independently verify the forecast model.
- Every verification result carries a coverage class: **verified near observation**, **partially observed**, **reanalysis-referenced** (compared against ERA5/ERA5T where no buoy exists — stronger than raw model fields because reanalysis assimilates observations, but still not independent ground truth), or **not independently observed** — plus distance/time offset, source quality flags, and sample size. A sailor's two-minute experience log is valuable qualitative evidence but is stored separately from instrument observations.
- Start with a retrospective corpus of at least ten archived cases from the target waters — Channel/Biscay front passages and wind-against-tide episodes, plus Mistral events for the Med — before exposing causal labels to users.
- Aggregate only sufficiently matched forecast/observation pairs into a **calibration record** per variable, lead time, and area. Do not introduce region/season-specific model weighting until the sample is large enough to justify it.

## 10. Data sources (corrected)

> **Architecture update (2026-07):** the Open-Meteo runtime dependency described
> below was removed. Production weather now comes from the provider-independent
> **forecast-tile pipeline** (public repo `deepregatta/forecast-tiles`,
> spec in `docs/forecast-tiles-spec.md`): NOAA GFS (deterministic + hazards),
> GEFS (31-member ensemble), GFS-Wave, ECMWF open data (second deterministic
> model), and Copernicus GLO12 currents — quantized into immutable PFT1 tiles on
> Cloudflare R2, downloaded per-route by the browser and cached in IndexedDB.
> Runtime quotas are gone; run ids in the audit trail are exact, not inferred.
> The Open-Meteo rows below are retained as the historical v1 design record.

| Source | Provides | Notes & limits |
|---|---|---|
| **Open-Meteo Forecast API** *(retired 2026-07)* | Point time series: ECMWF, GFS, ICON/ICON-EU; **AROME (France only, ~1.5 km, horizon ≈ 2 days)** | Route-layer sampling. High-res is a bonus where available, never assumed |
| **Open-Meteo Ensemble API** *(retired 2026-07)* | Atmospheric ensembles (wind, gusts, precip…) | Raw scenario-exceedance fractions; calibrated probabilities only after verification. **No wave ensembles** |
| **Open-Meteo Marine API** *(retired 2026-07)* | Deterministic wave models (height/period/direction, wind-wave + swell components) | Waves labeled deterministic-only (§6) |
| **ECMWF Open Data (GRIB, 0.25°)** | Gridded MSLP, 10 m wind, 850 hPa fields | Required for the synoptic layer (feature detection + chart rendering) — point APIs can't do this |
| **Official marine warnings** | Météo-France BMS / marine bulletins, Atlantic + Med zones (v1); UK Met Office / other national services later | Authority-override layer (§7) |
| **Copernicus Marine (CMEMS) regional models — IBI / NWS / MED / BAL** | Hourly surface currents incl. tidal signal (regional, ~2–7 km per coachregatta's implemented catalog), sea level | Free with registration. v1 tidal/current layer: SOG/ETA correction, wind-against-current, gates. Region auto-selection + global fallback imported from coachregatta (see below); deepweather uses the *forecast* product variants, resolutions to confirm. Limits flagged per §5 |
| **Tidal predictions (harmonic)** | HW/LW times & heights at reference ports | Source to finalize (§13): FES constituents (registered, non-commercial), national open data (SHOM/UKHO free tiers). No import available — coachregatta never implemented tides |
| **ERA5 / ERA5T (Copernicus CDS)** | Hourly 0.25° reanalysis: wind, MSLP (NetCDF via `cdsapi`) | **Verification reference only (§9)** where buoys are absent — never a forecast source. ERA5T for recent events (<90 d), upgrade to final ERA5 later. Fetch pattern imported from coachregatta |
| **ORC polar database + overrides** | VPP tables for 1000+ boat models (`ALL2025.json`, ~12 MB) + per-boat override file | Phase 2 routing polars (§4.0). Database, multi-tier matching ladder, and override format imported from coachregatta |
| **Copernicus Marine in-situ / EMODnet** | Buoy, coastal station & tide-gauge observations | Verification layer (§9). Not implemented in coachregatta (its hindcast use case didn't need them), but its planning docs shortlist per-region sources worth starting from: CEFAS SmartBuoy (English Channel), Météo-France buoys (Biscay, limited), NDBC (US) — see coachregatta `proposals/implemented/historical_weather_currents_plan.md` |

**Quota design (day one, not later):** Open-Meteo free tier is non-commercial and capped (~300k weighted calls/month). Route points × ETA hours × models × ensemble members multiplies fast → cache per (location-grid-cell, model-run), batch multi-point requests, re-fetch only on new model runs, and downsample route points to model resolution. If the project ever goes public/commercial: paid API or direct GRIB ingestion (the ECMWF open-data path already builds that muscle).

### Strategies imported from `coachregatta`

The author's `coachregatta` project (offshore-race hindcast analytics, Python) has already solved several of this project's acquisition problems in production. Import the strategy and port the code — don't reinvent:

- **Currents via the `copernicusmarine` client** — auto-detect the region from bounds; prefer regional models in priority order **IBI > NWS > MED > BAL** with a minimum-overlap threshold (default 0.25 of the area); fall back to a downsampled global product (GLORYS-class); auto-downsample oversized areas; dataset IDs overridable by env var. Reference: `analysis/src/coachregatta_analysis/environment_fetcher.py` (`fetch_regional_currents`, `fetch_global_currents`). deepweather points the same skeleton at the *analysis & forecast* datasets instead of the reanalysis ones.
- **ERA5/ERA5T via `cdsapi`** for the verification layer — hourly 0.25° NetCDF; use ERA5T when the passage is < 90 days old and upgrade to final ERA5 when published (coachregatta's `--upgrade-environment` pattern). Reference: `environment_fetcher.py::fetch_era5_weather`.
- **Open-Meteo fallback with rate-limit discipline** — point cache keyed `{lat}_{lon}_{dates}`, early abort on 429, coarse-grid NetCDF fallback. Reference: `weather.py::fetch_historical_weather`.
- **Extent-aware environment cache** — per-trip cache directory with a `metadata.json` recording source, tier, resolution, bounds, and status; invalidated when bounds or time window change; bounds computed from robust percentiles so a single outlier point can't inflate a data request. Dovetails with the snapshot discipline (§9) and the quota design above.
- **Vectorized grid-to-track interpolation** — batched, with nearest-vs-linear thresholds tunable by env var; directly reusable for sampling forecast grids along route legs.
- **ORC polar database + matching ladder** — `ALL2025.json` (1000+ boats with full VPP tables) plus multi-tier matching: user override → exact name+model → community polars (Meltemus, Seapilot) → model-only → fuzzy nearest → generic fallback; overrides in a `polar_overrides.json`. Resolves the polar question for the Phase 2 routing engine.
- **Confirmed gaps — nothing to import**: tides (coachregatta's `.env.example` has FES2014/AVISO credentials but the tidal-atlas exploration was abandoned before production) and buoy/station observations (never implemented). Both remain deepweather's own build (§13).

## 11. Architecture

```
┌───────────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ Data layer        │ →  │ Analysis engines   │ →  │ Findings JSON    │
│ · point APIs      │    │ · synoptic features│    │ (structured,     │
│ · gridded GRIBs   │    │ · route hazards    │    │  versioned,      │
│ · warnings feeds  │    │ · exceedance calc  │    │  snapshotted)    │
│ · observations    │    │ (pure, unit-tested)│    └────────┬─────────┘
└───────────────────┘    └────────────────────┘             │
                    ┌────────────────────────────────────────┤
                    ▼                    ▼                   ▼
             Briefing renderer    Chart renderer      Verification
             (templated EN/FR,    (synoptic, plume,   (vs observations,
              two registers,      timeline + auto     calibration
              LLM-swappable)      captions)           records)
```

- **Backend: Python** — xarray/cfgrib for GRIBs, numpy/scipy for feature detection, FastAPI for the API. The engines are pure libraries: same inputs → same findings, unit-tested against historical cases (e.g. a known Mistral event, a corroborated frontal passage, and non-frontal lookalikes). Several data-layer components port directly from coachregatta (§10): CMEMS region selection/fallback, ERA5 verification fetch, Open-Meteo fallback, extent-aware caching, and vectorized grid-to-route interpolation.
- **Storage: SQLite** (fine for single-user) — routes, limits, findings snapshots, observations, calibration records.
- **Scheduling (corrected):** no in-process APScheduler. An **external trigger** (system cron / GitHub Actions schedule / hosted cron) calls an **idempotent** `/jobs/refresh` endpoint keyed by model-run ID — safe across restarts and duplicate fires. Watch-mode alerts diff the new findings snapshot against the previous one.
- **Frontend:** React (Vite); MapLibre GL for maps; ECharts for plumes/timelines; synoptic chart rendered server-side (matplotlib/contour from GRIBs) with detected-feature annotations.
- **Hosting (corrected):** a small VPS (e.g. Hetzner ~€4/mo) — Fly.io no longer has a free tier and Railway's free resources are experimentation-scale. GRIB processing wants a persistent disk anyway. Email alerts via a free-tier sender.

## 12. Roadmap

**Phase 1A — Evidence-bearing vertical slice**
- One fixed test route in the author's home Atlantic waters, with slow/nominal/fast ETA ranges; no general route editor yet
- Wind/gust assessment against editable declared limits using one deterministic run plus one ECMWF ensemble
- **CMEMS currents sampled along the route from the start**: SOG/ETA correction + wind-against-current flag (an Atlantic slice without tide would prove nothing)
- Report raw scenario-exceedance fractions; do not claim calibrated probability
- Synoptic v0: low/high detection and tracking; cautious front-like transition markers requiring official or validated corroboration before assigning a front type
- **Météo-France BMS integration from the start** as a separate authority state
- One templated two-register briefing, one route timeline, and one ensemble plume chart with evidence links
- Immutable snapshots of inputs, findings, warnings, and rendered output from day one
- Run at least ten archived cases (Channel/Biscay fronts, wind-against-tide episodes, one Mistral case), then review the causal labels and false positives before expanding scope

**Phase 1B — Generalize the proven slice**
- GPX import + map waypoints; slow/nominal/fast ETA ranges for arbitrary 6–36 h routes in Atlantic Europe and the Western Med
- Add sea state with correct steepness and separate wind-wave/swell components
- Tidal gates at named passages (adverse-current timing vs slack/HW), with under-resolved-passage flagging
- Expand route weather to 2–3 deterministic models and retain explicit model disagreement
- Add basic observation matching with verification coverage labels; validate against real passages of the author

**Phase 2 — The briefing experience**
- **Start + finish input via integrated sail routing** (§4.0): isochrone engine + polar presets + coastline + currents, feeding the unchanged analysis pipeline
- Synoptic chart rendering with annotations + auto-captions; model comparison view
- Named-regime detection (Mistral/Tramontane pattern rules for the Med)
- Watch mode: external cron + idempotent jobs + "what changed since the last run" alert emails
- Best-window scan across the next days (coupled with routing departure candidates); French output

**Phase 3 — Trust & polish**
- Calibration dashboard (the public track record)
- Convective screening + fog; glossary/teaching layer polish
- Interactive map with hazard markers along the route
- Simple accounts for sailing friends

**Later / parked**
- Optional LLM narrative writer at the renderer seam (facts stay deterministic)
- Deeper tidal features (tidal atlases, secondary-port corrections, high-res local current models for narrow passages)
- Race-start mode; other regions
- Open-source release / self-host docs; API or chartplotter-plugin form factor

## 13. Open questions

- Independent verification coverage along the author's actual sailing areas (Atlantic + Med): how dense are usable buoy, station, and tide-gauge observations? (Determines which cases can support calibration and which remain only partially observed.)
- Front detection skill: signature-based detection at route points is v0 — validate against archived charts (Météo-France/DWD analyses) before trusting the narrative.
- Which warnings feed is programmatically accessible for French Atlantic and Med zones, and in what format?
- Routing engine: does the `weatherrouting` / gWeatherRouting library's license (GPL family) fit the project's intended distribution, and is its isochrone quality adequate with currents? Fallback: implement a minimal isochrone core (well-documented algorithm) rather than adopt a poor fit.
- ~~Polar sources~~ — resolved by importing coachregatta's ORC database + matching ladder (§10). Remaining sub-questions: annual refresh of the ORC export, and capturing the author's own boat polar as an override.
- CMEMS regional models: coachregatta's implemented catalog (IBI ~3 km, NWS ~7 km, MED ~4 km) sets the starting priority; confirm the *forecast*-product resolutions for the author's waters, and which named passages exceed them (to be flagged per §5).
- Tidal heights source: FES constituents (registered, non-commercial license) vs station-based harmonics from national open data (SHOM/UKHO free tiers). Context from coachregatta: it *deliberately removed* FES from its tier system (decision dated 2025-12-23) because CMEMS regional models already provide **total currents — tidal + wind-driven + mesoscale — at higher resolution**, which subsumes a tidal-only atlas for its use case. The same holds for deepweather's tidal *streams* (CMEMS covers them); the genuine remaining build is narrower than "tides": (a) HW/LW **height** predictions at reference ports, for gate timing in the sailor's vocabulary ("slack at the Raz ≈ HW Brest −0h30") and height-dependent hazards, and (b) higher-fidelity streams in passages the shelf models under-resolve.
- How to phrase raw scenario fractions for the amateur register without implying calibrated probability ("33 of 51 forecast scenarios exceed your gust limit Thursday evening").
- Threshold defaults per preset — calibrate against pilot-book guidance and the author's logged experience.

## 14. Naming

`deepweather` is the **internal project code name** (repo, docs, code) — not the product name. The public name will be chosen later, before any branding or release. Note for that future decision: "DeepWeather" itself is unavailable (collides with an existing weather app and a NZ forecasting research project). Parked candidates: **PassageBrief**, **RouteAudit**, **Synoptique**, **Isobar**.

## 15. Safety framing

The product is a decision *aid* and must behave like one structurally, not just in a disclaimer: no "GO" wording (§7), the official-warning authority state is presented above and overrides the personal-limit summary, unsupported hazards are disclosed in every report, and calibration records are honestly displayed — including where the tool has been wrong. Skippers remain solely responsible; official marine forecasts (Météo-France, national services) remain the authority of record.

## 16. UI concept screenshots

These generated concepts establish a visual direction, not a locked component specification. The intended character is sober marine cartography: chart-paper surfaces, ink-navy structure, restrained hazard colors, evidence-dense layouts, and minimal dashboard-card chrome.

1. [Main causal briefing](./passage-brief-main-briefing.png) — synoptic system, route impact, plain-language story, timeline, and source evidence on one screen.
2. [Evidence and uncertainty](./passage-brief-evidence-uncertainty.png) — ensemble plume as the primary visualization, raw scenario fraction, deterministic model comparison, and rule/run provenance.
3. [Forecast-run changes](./passage-brief-forecast-changes.png) — previous/latest synoptic comparison, evidence-backed change ledger, shifted event timing, and the official-warning authority layer.

**Mockup review notes (carry into implementation):**
- The evidence footer on the main briefing labels each model "High/Medium confidence" — that is exactly the blended-confidence wording §6 forbids. Replace with run age + agreement/divergence status per model.
- The synoptic charts draw classical front symbols confidently; §4.1 requires the cautious *front-like transition* treatment (dashed styling / explicit label) unless the front type is corroborated.
- "Wind over tide in the approaches to Calvi" appears in the main briefing — consistent with the new v1 tide scope, but any tide claim must cite its currents source (CMEMS run, cell, time) in the evidence inspector like every other value.
- Everything else translates well: the "23 of 51 scenarios" headline, the rule ID + source-age evidence inspector, "Agreement is not proof", the change ledger with previous→latest values, and the "reassess after next run, expected 14:30" footer are §6–§8 rendered faithfully.
