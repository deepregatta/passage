# Credit audit: does Passage show what its data licences require?

_12 November 2026. A dated audit, not current product guidance. Nothing was changed in either repository._

## Provenance

- **What was read.** Passage at `3c131e9` and forecast-tiles at `ae9923c`. The two licence registers: forecast-tiles' register (`forecast-tiles/contracts/data-sources.json`, vendored byte-identical as [`contracts/forecast-tiles-data-sources.json`](../../contracts/forecast-tiles-data-sources.json), 15 entries) and Passage's own register [`config/data-sources.json`](../../config/data-sources.json) (18 entries).
- **Terms used.** Only the terms already recorded: `forecast-tiles/DATA-LICENSES.md` (section "Terms read on 12 November 2026") and [the licence verification proposals](2026-11-12-licence-verification-proposals.md), including the owner's decisions of 12 November 2026. No licence was looked up again. In this document, "the recorded terms say" means those two documents and the register entries.
- **Method.** Code reading only. No test, build, browser session or live site was used. Two auditors each covered one register. An independent reviewer then checked every row, opened every cited file, and corrected verdicts, obligations and surface claims. This record merges the corrected result.

## Summary

Each source is judged by surface: the public bucket, the About page, the GRIB page, the downloaded GRIB file, the briefing and planner screens, and Passage's prepared artifacts. A verdict summarises those surfaces. It is not the single worst case.

| Verdict | forecast-tiles register (15) | Passage register (18) |
|---|---|---|
| met | 2 | 3 |
| partly met | 12 | 2 |
| not met | 0 | 2 |
| no user surface today (would not be met if enabled) | 0 | 7 |
| not applicable | 0 | 1 |
| cannot tell | 1 | 3 |

Credit text exists, but rarely where the recorded terms ask for it.

- The full required wording sits mostly on the About page, inside two sections that are closed by default.
- The GRIB page shows short credits.
- The downloaded GRIB file carries no credit, licence or modification text at all. It names the original provider as originating centre, with "operational" status.
- Modification statements are missing everywhere except UKV.
- The warning, tide and observation feeds are not loaded in production today. They have no place to show credits, so enabling them as they are would fall short.

## Gaps that reach users of the deployed product today, where the recorded terms require something

Ranked by how directly the recorded terms are missed.

### 1. Met Office UKV in downloaded GRIB files

- **Recorded terms say:** CC BY-SA 4.0. "Derived tiles and GRIB exports carry the credit, the licence link, a modification notice and the BY-SA label" (owner decision, 12 November 2026; `forecast-tiles/DATA-LICENSES.md`). Adapted data keep the same licence.
- **Shown today:**
  - The GRIB page "Data sources:" line has all four ([`engine/src/export/gribDatasets.ts`](../../engine/src/export/gribDatasets.ts), `wind-ukv`): "British Crown copyright 2023–2025, Met Office UKV via Open-Meteo; CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); native CRS corrected, remapped and quantized data". `/fr/grib` shows a French translation.
  - The tile manifests and the About card carry the register string.
  - The file itself carries nothing. [`engine/src/export/grib2.ts`](../../engine/src/export/grib2.ts) writes GRIB sections 0, 1 and 3–8 only, with no section 2 and no free text. The browser download is one Blob ([`viewer/src/lib/gribExport.js`](../../viewer/src/lib/gribExport.js)), with no sidecar. `summary.json`, which does carry attribution, exists only in the command-line tool ([`engine/src/cli.ts`](../../engine/src/cli.ts)).
- **Verdict on this surface:** not met. A file passed on by a user loses every BY-SA mark.
- **Smallest fix:** put the credit, BY-SA label, link and modification line where they travel with the data. Options: a text file bundled with the download, or GRIB section 2 (local use). Section 2 is invisible in most GRIB viewers. Both are more than a one-line change.

### 2. ECMWF service credit

- **Recorded terms say:** CC BY 4.0 plus ECMWF's Terms of Use for open data. For a service built on the data, show "This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)". It must be shown prominently with the source, the licence link, ECMWF's disclaimer and a statement that the data were modified. This applies to `ecmwf-open-ifs` (tiles) and `ecmwf-open-data-charts` (Passage's prepared run).
- **Shown today:**
  - **About card:** the exact sentence, inside a closed section. It has no link, no disclaimer and no modification statement.
  - **GRIB page:** "ECMWF open data, CC BY 4.0" (`gribDatasets.ts`, const `ECMWF`). French: "Données ouvertes ECMWF, CC BY 4.0".
  - **Synoptic chart PNG:** "ECMWF open data (CC-BY-4.0) — isobars every 4 hPa", at 7 pt and 70 % opacity, bottom right ([`analysis/src/deepweather_analysis/synoptic/render.py`](../../analysis/src/deepweather_analysis/synoptic/render.py)). The chart opens zoomed to the route ([`viewer/src/components/SynopticHero.jsx`](../../viewer/src/components/SynopticHero.jsx), `framed = true`, `overflow-hidden`), so this corner is often cropped. Not checked visually.
  - **Briefing route map:** draws wind arrows from the prepared ECMWF wind grid ([`viewer/src/components/RouteMap.jsx`](../../viewer/src/components/RouteMap.jsx), `fieldArrows`) but credits only OpenStreetMap and OpenSeaMap.
  - **Other screens:** they name the model only ("ECMWF IFS 0.25°").
  - **Data files:** tile provenance reads "ECMWF open data IFS 0.25deg (CC BY 4.0)". The prepared `run.json` records `licence: "CC-BY-4.0, source: ECMWF open data"`.
- **Missing everywhere:** the licence link, ECMWF's disclaimer and a modification statement. The disclaimer wording is not recorded.
- **Smallest fix:**
  - Extend the `ECMWF` constant in `gribDatasets.ts` and the chart footer in `render.py` to the recorded sentence, plus a licence link and "modified".
  - Add the same line where the briefing shows ECMWF data.
  - The owner supplies the disclaimer text.

### 3. Copernicus Marine

- **Recorded terms say:** derived works carry "Generated using E.U. Copernicus Marine Service Information" and each product's DOI, on the home page or on the page where users get the data. GLO12 is 10.48670/moi-00016 and IBI is 10.48670/moi-00027. Redistribution in original form uses different wording. A record-keeping duty passes downstream; that is a risk for a public bucket, not a display duty.
- **Shown today:**
  - **GRIB page (where users get the files):** "Generated using E.U. Copernicus Marine Service Information" (`gribDatasets.ts`, const `COPERNICUS`), with no DOI. The same line serves GLO12 and IBI. `/fr/grib` translates it.
  - **About cards and tile provenance:** "E.U. Copernicus Marine Service Information; doi:10.48670/moi-00016" (or …00027). They have the DOI but not "Generated using".
  - **Passage's own `copernicus-marine-currents` card:** the sentence without a DOI.
  - **Passage page current block:** a model name only ("Copernicus IBI ocean currents", [`viewer/src/lib/sourceNames.js`](../../viewer/src/lib/sourceNames.js)) and "Not an official tidal-stream prediction.".
  - **Plan page (the home page):** nothing.
  - **Prepared current grid JSON on R2:** `source` holds only mode, dataset_id, resolution and fetched_at ([`analysis/src/deepweather_analysis/grids_prep.py`](../../analysis/src/deepweather_analysis/grids_prep.py)).
- **Smallest fix:**
  - Make `COPERNICUS` per product, with the sentence and the DOI.
  - Put the same full line in both register `attribution` fields.
  - Add it beside the current block.
  - Owner decision: whether the French page may translate it.

### 4. DWD ICON-EU and Météo-France AROME

- **Recorded terms say:**
  - ICON-EU: CC BY 4.0, "credit DWD and indicate changes".
  - AROME: "CC BY 4.0 (Open-Meteo bulk catalogue); Météo-France open data". No provider page was read for AROME. Applying CC BY 4.0's own conditions (licence link, indicate changes) is an inference from the recorded licence name.
- **Shown today:**
  - Credit and licence name on the GRIB page: "Deutscher Wetterdienst ICON-EU via Open-Meteo (CC BY 4.0)" and "Météo-France AROME via Open-Meteo (CC BY 4.0)".
  - The same strings on About, in tile manifests, and in the evidence inspector ([`viewer/src/components/EvidenceInspector.jsx`](../../viewer/src/components/EvidenceInspector.jsx)).
  - No modification statement and no link on any surface, although the tiles are remapped and quantised.
- **Smallest fix:** add a modification clause, as UKV already has. Put it in the register `attribution` and in `forecast-tiles/src/ingest/sources/openmeteo/registry.py`, then re-vendor and update `gribDatasets.ts`.

### 5. GRIB file metadata names the provider as originating centre, with operational status

- **Recorded terms say:** NOAA data that has been modified "must not be presented as official", and no endorsement may be implied. ECMWF, DWD and UKV ask for a statement that the data were modified.
- **Shown today:**
  - Section 1 of each file writes centre 7 (NCEP, with process 96 or 11), 98 (ECMWF), 74 (Met Office), 85 (Météo-France) or 78 (DWD), and "production status: operational" (`grib2.ts`, line 199).
  - The GRIB page itself says "Forecast data for planning, not for navigation. Check official forecasts and warnings." (`GRIB_EXPORT_NOTICE`). The page therefore signals "not official"; the file does not.
- **Smallest fix (owner decision):** keep the provider centre codes, which GRIB readers may rely on, or change the subcentre or production status. Otherwise rely on a notice that travels with the file (gap 1).

### 6. EMODnet Bathymetry (public bucket, consumed by Tactician)

- **Recorded terms say:** EMODnet's credit sentence and the DTM's DOI. The catalogue says not for navigation.
- **Shown today:**
  - Land-index manifests carry "EMODnet Bathymetry Consortium (2024): EMODnet Digital Bathymetry (DTM 2024)" and "DO NOT USE FOR NAVIGATION" (`forecast-tiles/src/ingest/land/emodnet.py`).
  - Chart archives carry the short form "EMODnet Bathymetry Consortium (2024)" (`forecast-tiles/src/ingest/charts/build.py`).
  - There is no DOI anywhere.
  - The public `charts/{build}/{cell}.emodnet.npz` cuts carry no credit, licence or warning in their `meta` (`forecast-tiles/src/ingest/charts/products.py`).
- **Smallest fix:** add the DOI to `ATTRIBUTION` in `emodnet.py`, and add attribution, licence and use constraint to the `.npz` `meta`.

### 7. Shom Balisage (public bucket, consumed by Tactician)

- **Recorded terms say:** credit Shom and the date of last update.
- **Shown today:** "Balisage © Shom <year fetched>" (`charts/build.py`, `shom_meta['fetched'][:4]`). The dataset's own last-update date is not captured.
- **Smallest fix:** record the dataset's last-update date and print it, or record that the fetch date is accepted.

### 8. OpenStreetMap in chart archives; no notice object in the bucket

- **Recorded terms say:** credit OpenStreetMap with a link, and ship the ODbL notice with distributed data. Protomaps: "© OpenStreetMap" must be visible.
- **Shown today:**
  - Archive metadata has "© OpenStreetMap contributors" and `licence: "ODbL-1.0"`, with no link.
  - The bucket holds no README, LICENCE or NOTICE object.
  - Forecast manifests carry top-level `attribution` only for AROME, ICON-EU and UKV. NOAA root layers carry a source label only.
  - The `latest*.json` pointers and the chart manifest have no attribution field.
- **Smallest fix:** one notice object in the bucket listing each source's credit, licence and link, plus the ODbL notice.

## Good practice or not settled by the recorded terms

- **NOAA credit.** The recorded terms request credit only for unaltered data. Passage shows modified data, so a NOAA credit line is good practice. The three NOAA register entries have no `attribution`, and their About cards print "Not yet confirmed".
- **About cards printing "Not yet confirmed".**
  - `world-port-index` needs no credit under the recorded terms.
  - These entries have wording recorded in `notes` but an empty `attribution`: `era5-reanalysis`, `meteofrance-marine-bulletins`, `msq-queensland-tides`, `queensland-wave-buoys`. `copernicus-insitu-observations` is the same by inference from its sibling Copernicus entries.
- **Open-Meteo link.** The proposals record that Open-Meteo's licence page asks for a "Weather data by Open-Meteo.com" link. It is recorded as an open point, not a confirmed term. Today AROME, ICON-EU and UKV say "via Open-Meteo" as text only.
- **OpenSeaMap.** The map shows "seamarks © OpenSeaMap", which is the register wording, with no link and no licence name. CC BY-SA normally asks for a licence notice; that is inferred from the licence name, not a recorded condition. The tile licence version is unconfirmed.
- **ERA5 citation.** The recorded terms say credit is the dataset citation with DOI 10.24381/cds.adbb2d47.
  - Users see only aggregate counts: "Skill claims use 11 real ERA5 cases." and 10 pass, 1 fail ([`viewer/src/pages/About.jsx`](../../viewer/src/pages/About.jsx), with the counts from the shipped `corpus.json`).
  - About also names "ERA5 reanalysis (Copernicus)", and the ERA5 card shows licence "CC BY 4.0".
  - Whether aggregate counts trigger a credit is not settled. The table records "not met" because no citation is shown.
- **Translated credits on `/fr/grib`.** The Copernicus, ECMWF, AROME, ICON-EU and UKV lines are translated ([`viewer/src/i18n.js`](../../viewer/src/i18n.js)). The recorded terms do not say whether a translation satisfies prescribed wording. About keeps register credits in English.
- **`licence_url` never printed.** [`viewer/src/components/SourceTerms.jsx`](../../viewer/src/components/SourceTerms.jsx) prints the licence name only, so no licence is linked from any page.
- **Where credits sit.** Full credits are only in the two closed About sections ("Forecast model data", "Other feeds and map layers"). The open "Data providers" list names providers only, for example "Forecast tiles (NOAA, ECMWF, Copernicus)" and "Ocean currents (Copernicus Marine)". The footer has no credits ([`viewer/src/components/Shell.jsx`](../../viewer/src/components/Shell.jsx)).

## Not loaded in production today: needed before enabling

Production loads warnings only in development builds: `DEV_WRITES ? loadJson('/data/warnings/latest.json')` ([`viewer/src/lib/browserAnalysis.js`](../../viewer/src/lib/browserAnalysis.js)). The only shipped tide file, `viewer/public/data/tides/channel.json`, is synthetic. The only published verification case is emulated. The demo briefing's warning is synthetic.

- **Warning issuer chain.** Each fetched feed appends its name to one string ([`analysis/src/deepweather_analysis/warnings_mf.py`](../../analysis/src/deepweather_analysis/warnings_mf.py), `_merge_warning_feed`), even when it returns no bulletins. [`engine/src/findings.ts`](../../engine/src/findings.ts) stamps that string on every bulletin. So every bulletin shows as issued by "Météo-France BMS (data.gouv daily mirror) + Met Office shipping forecast + …".
- **"Issued" shows the fetch time.** `issued_at: doc.fetched_at` in `findings.ts`. The real issue times (CAP `sent`, the BMS row date, UK `issued`, BOM `issue-time-utc`) are parsed or available, then dropped.
- **`coverage_note` is never rendered**, so the lag and coverage caveats do not reach users.
- **MeteoAlarm.** The recorded terms add seven requirements. Status in today's code:
  1. Modified information shown with the unmodified: partly met. The original headline and description are shown verbatim beside Passage's sentence, but the original warning level is not shown.
  2. "EUMETNET – MeteoAlarm" named across several countries: not applicable today (Spain only). "EUMETNET" appears nowhere.
  3. National issuing service named: not met. AEMET is not captured; the issuer shown is the chain.
  4. Time of issue shown: not met. "Issued" is the fetch time.
  5. Link to meteoalarm.org: not met.
  6. Real-time redistribution (under 5 minutes on average, never over 10): not met. Fetch is a manual command, and saved briefings freeze warnings. Whether this counts as "operational redistribution" is an open owner question.
  7. Delay disclaimer published: not met. The wording is not recorded.
- **Météo-France bulletins.** The recorded terms say credit Météo-France and the date of last update. Neither appears per bulletin.
- **Tide credits.**
  - NOAA CO-OPS: credit requested; modified data must not be shown as official.
  - Maritime Safety Queensland: credit the State of Queensland (TMR, MSQ), link the licence, note changes.
  - Copernicus SSH: the Copernicus sentence and DOI.
  - Tidal gates show none of these.
- **Observation credits.**
  - Queensland wave buoys: credit the Queensland Government; Gladstone with Gladstone Ports Corporation.
  - Copernicus in-situ: Copernicus licence.
  - NDBC: the buoys belong to the Met Office, whose terms were not read.
  - The outcome table shows the observation mode only.
- **Two arrangements whose terms are not recorded.** The Met Office shipping forecast and the BOM marine warnings rest on owner arrangements whose terms are not in the repository.

## Per-source tables

### forecast-tiles register (15)

"Tactician" means the data reaches users only through the public bucket. Tactician's display is outside both repositories.

| id | licence | recorded terms require | reaches users via | shown | verdict | smallest fix |
|---|---|---|---|---|---|---|
| `noaa-gfs` | US Gov, public domain | credit requested (unaltered); modified not shown as official; no endorsement | bucket, About, GRIB page and file, screens | "NOAA/NCEP" on GRIB page; About "Not yet confirmed"; file centre 7, operational | partly met | gap 5; NOAA credit is good practice |
| `noaa-gfs-wave` | same | same | same | same, process 11 | partly met | as `noaa-gfs` |
| `noaa-gefs` | same | same | bucket, About, screens; no GRIB export | model name only | met | optional credit line |
| `ecmwf-open-ifs` | CC BY 4.0 + ECMWF terms | service sentence, prominent, link, disclaimer, "modified" | bucket, About, GRIB page and file, screens | sentence on closed About card only | partly met | gap 2 |
| `cmems-glo12` | Copernicus Marine licence | "Generated using…" + DOI moi-00016 where users get data | bucket, About, GRIB page and file, screens | sentence without DOI on GRIB page; DOI without sentence elsewhere | partly met | gap 3 |
| `cmems-ibi` | same | same, DOI moi-00027 | same | same | partly met | gap 3 |
| `meteofrance-arome` | CC BY 4.0 (Open-Meteo catalogue) | credit; link and changes inferred from CC BY | bucket, About, GRIB page and file, inspector | credit and licence name; no link, no "modified" | partly met | gap 4 |
| `dwd-icon-eu` | CC BY 4.0 | credit DWD, indicate changes | same | credit and licence name; no "modified" | partly met | gap 4 |
| `metoffice-ukv` | CC BY-SA 4.0 | credit, link, modification notice, BY-SA label, in tiles and GRIB exports | same | all four on bucket, About, GRIB page; none in file | partly met (file: not met) | gap 1 |
| `gshhg` | LGPL-3.0-or-later, attribution | citation Wessel and Smith (1996) | bucket (Tactician) | citation and licence in land manifest | cannot tell | owner settles LGPL reach |
| `emodnet-bathymetry` | CC BY 4.0 | credit sentence + DTM DOI | bucket (Tactician) | credit, no DOI; `.npz` cuts bare | partly met | gap 6 |
| `openstreetmap` | ODbL 1.0 | credit with link; ODbL notice with data | bucket (Tactician) | credit and licence name; no link, no notice | partly met | gap 8 |
| `protomaps-basemap` | tiles ODbL | "© OpenStreetMap" visible; WorldCover and Mapzen notices if their content is shown | bucket (Tactician) | "© Protomaps", "© OpenStreetMap contributors" | partly met | check WorldCover/Mapzen content; gap 8 |
| `open-waters-seamap` | CC BY 4.0, moving to ODbL | "© Open Waters: Seamap" | bucket (Tactician) | present in archive attribution | met | revisit after licence change |
| `shom-balisage` | Licence Ouverte 2.0 | credit Shom + date of last update | bucket (Tactician) | fetch year, not update date | partly met | gap 7 |

### Passage register (18)

| id | licence or arrangement | recorded terms require | reaches users via | shown | verdict | smallest fix |
|---|---|---|---|---|---|---|
| `forecast-tiles-service` | none (own service) | none; follows the forecast-tiles register | all forecast screens | About card "Not yet confirmed" | not applicable | owner: show "see Forecast model data" on the card |
| `ecmwf-open-data-charts` | CC BY 4.0 + ECMWF terms | as `ecmwf-open-ifs` | chart PNG, route-map arrows, About, R2 `prepared/` | short footer on chart; sentence on closed About card | partly met | gap 2 |
| `copernicus-marine-currents` | Copernicus Marine licence | sentence + DOI where users get data | current block, routing, R2 `prepared/` JSON (if secrets set) | model name; sentence only on About | not met | gap 3 |
| `era5-reanalysis` | CC BY 4.0 | dataset citation with DOI | About counts | "ERA5 reanalysis (Copernicus)", "CC BY 4.0"; no citation | not met | add citation; owner supplies text |
| `meteofrance-marine-bulletins` | Licence Ouverte 2.0 | credit, last-update date, no endorsement | local only | chain name; fetch time | no user surface today | per-bulletin source and issue time |
| `metoffice-shipping-forecast` | arrangement | not recorded | local only | composed text with issue time | cannot tell | record the terms |
| `nws-marine-alerts` | open data | application User-Agent | local only | UA "passage-deepregatta (+https://passage.deepregatta.com)" | met | none |
| `meteoalarm-warnings` | MeteoAlarm T&C | CC BY 4.0 + seven requirements | local only | see MeteoAlarm list | no user surface today | see section above |
| `bom-marine-warnings` | arrangement | not recorded | local only | "<phenomena> for <areas>"; issue time dropped | cannot tell | record the terms |
| `noaa-coops-tides` | public domain | credit requested; not shown as official | local only | nothing | no user surface today | credit line at tidal gates |
| `msq-queensland-tides` | CC BY 4.0 | credit State of Queensland, link, changes | local only | nothing | no user surface today | same credit line |
| `copernicus-marine-ssh-tides` | Copernicus Marine licence | sentence + DOI | local only | nothing | no user surface today | same credit line |
| `ndbc-observations` | public domain; Met Office buoys | Met Office terms not read | local only | mode only | cannot tell | read Met Office terms |
| `copernicus-insitu-observations` | Copernicus Marine licence | sentence (inferred) | local only | nothing | no user surface today | fill `attribution`; credit on outcome table |
| `queensland-wave-buoys` | CC BY 4.0 | credit Queensland Government (+ Gladstone Ports Corporation) | local only | nothing | no user surface today | credit on outcome table |
| `world-port-index` | public domain | nothing recorded; NGA and Esri terms unread | Plan port names | no credit | met | record "none required" |
| `openstreetmap-base-map` | tile policy; ODbL | visible credit; no bulk download | three maps | "© OpenStreetMap contributors" with copyright link ([`viewer/src/lib/basemap.js`](../../viewer/src/lib/basemap.js)) | met | none |
| `openseamap-seamarks` | data ODbL; tiles CC BY-SA | "seamarks © OpenSeaMap"; licence notice inferred | three maps | "seamarks © OpenSeaMap", no link | partly met | add link and "CC BY-SA" |

## Feeds in no register, and public objects with no credit

- **Open-Meteo historical-forecast API** (`https://historical-forecast-api.open-meteo.com/v1/forecast`). Used in [`analysis/src/deepweather_analysis/openmeteo_history.py`](../../analysis/src/deepweather_analysis/openmeteo_history.py) for the verification corpus, in the factory only; only a boolean and a model name are kept. This is the free API under non-commercial terms. The proposals doc already asks for a register entry or a research-only note.
- **Open-Meteo bulk files.** The intermediary for AROME, ICON-EU and UKV. It has no entry of its own; its terms are an open point in the proposals.
- **GLOBE elevation data via the `global-land-mask` package** (MIT package licence; data from NOAA NGDC; terms not recorded). Built into `viewer/public/data/land/global-005.*`, shipped by Pages, used for browser routing and the chart land tint. No credit is shown.
- **Esri Deutschland ArcGIS service.** The intermediary for the port index ([`viewer/src/data/PROVENANCE.md`](../../viewer/src/data/PROVENANCE.md)). It is noted in the register but has no entry.
- **Public objects with no credit:**
  - `charts/{build}/{cell}.emodnet.npz` in the forecast-tiles bucket.
  - The prepared current grid JSON on R2 (Copernicus-derived), whose `source` holds no attribution, licence or DOI.

Nothing else was found. The fetch code in both repositories was searched for provider hosts and data libraries. Every other provider has a register entry, and RTOFS has no fetch code.

## Register facts

- **Empty `attribution` in the forecast-tiles register: 3 of 15** (`noaa-gfs`, `noaa-gfs-wave`, `noaa-gefs`). No credit wording is recorded for them.
- **Empty `attribution` in Passage's register: 13 of 18.**
  - Wording recorded in `notes` or the proposals: `era5-reanalysis`, `meteofrance-marine-bulletins`, `msq-queensland-tides`, `queensland-wave-buoys`.
  - Inferred from its Copernicus siblings: `copernicus-insitu-observations`.
  - No wording recorded: `forecast-tiles-service`, `metoffice-shipping-forecast`, `nws-marine-alerts`, `meteoalarm-warnings` (requirements only), `bom-marine-warnings`, `noaa-coops-tides` (credit requested, no wording), `ndbc-observations`, `world-port-index` (none needed).
- **Empty `verified_on`:**
  - forecast-tiles register: `meteofrance-arome`.
  - Passage register: `forecast-tiles-service`, `metoffice-shipping-forecast`, `bom-marine-warnings`, `ndbc-observations`, `world-port-index`.
- **Empty `licence_url`:**
  - forecast-tiles register: the three NOAA entries, `meteofrance-arome`, `gshhg`, `open-waters-seamap`.
  - Either way, About never prints the field.

## Could not determine

- What the live bucket, R2 `prepared/` and the deployed site serve today, including whether a prepared current grid exists. [`docs/capabilities.md`](../capabilities.md) says the current block is not deployed or checked live.
- Whether the zoomed synoptic chart shows its credit footer.
- How Tactician displays the chart and land credits.
- Whether the depth companion `.pmtiles` metadata carries EMODnet attribution, and whether WorldCover or Mapzen content is in the chart archives.
- Texts not recorded: ECMWF's disclaimer, the full ERA5 citation, the MeteoAlarm disclaimer, DWD's credit templates, the OpenSeaMap tile licence version, and the terms of the BOM and Met Office arrangements.
- Whether GLOBE's terms or the package's MIT notice attach to the shipped land mask.
- Whether aggregate ERA5 counts trigger a credit, and whether a translated credit satisfies prescribed wording.

## Decisions for the owner

1. **GRIB files.** Put credit, licence and modification text inside the download (a bundled text file or GRIB section 2), or keep it only beside the download button.
2. **GRIB metadata.** Decide whether files should keep naming the provider as originating centre with "operational" status.
3. **Credit wording.** Lengthen the ECMWF, Copernicus (with DOI), DWD and AROME credit strings on the GRIB page, the chart footer and the briefing. Supply the ECMWF disclaimer text.
4. **Register fields.** Fill the register `attribution` fields from the wording already recorded, and decide how a source that needs no credit should read.
5. **About page.** Print `licence_url` as a link, and decide whether the terms section opens by default or a credits line goes in the footer.
6. **Public bucket.** Add one notice object to the forecast-tiles bucket, and add credit fields to the `.emodnet.npz` cuts and the prepared current grid.
7. **Before enabling feeds.** Decide what must exist before warnings, tides and observations go to production: per-bulletin issuer and issue time, the MeteoAlarm requirements, and the credit lines.
8. **Unregistered feeds.** Add register entries, or research-only notes, for the Open-Meteo historical API, the Open-Meteo bulk files, GLOBE via `global-land-mask`, and Esri as port-index intermediary.

## Fixed on 12 November 2026

_Added after the audit; the findings above are unchanged and describe the code as it stood at `3c131e9`._ This change corrects credit wording only, from the recorded terms. It adds no licence wording that was not recorded.

**Closed or partly closed (wording):**

- **Gap 2, ECMWF (partly closed).** The GRIB page line, the synoptic chart footer (two lines, inside the image) and both registers' `attribution` fields now carry the service sentence, the source, the CC BY 4.0 link and a modification statement. The briefing map's attribution, while the ECMWF wind arrows are drawn, carries a short form only: "ECMWF open data, CC BY 4.0 (modified)" with the licence link, not the service sentence. The two registers' lines share the sentence, source and licence link; their modification clauses differ with the use (tiles and GRIB files: "converted and quantized data"; the prepared run's charts and wind arrows: "cropped to the chart window, converted and drawn as isobar charts and wind arrows"). Not closed: ECMWF's disclaimer is still shown nowhere, the About card is still in a closed section, and the footer is still in the bottom-right corner, which the audit says the zoomed briefing chart may crop (the PNG was checked, the briefing view was not).
- **Gap 3, Copernicus Marine.** The GRIB page has one line per product, each with "Generated using E.U. Copernicus Marine Service Information", the product's DOI and the modification clause. The register `attribution` of `cmems-glo12` and `cmems-ibi` is the full line. The "Current along your route" block shows the sentence with the DOI for the GLO12 and IBI families and without a DOI for the North West Shelf, Mediterranean and Baltic families, and nothing for RTOFS or a model not recorded. Passage's `copernicus-marine-currents` names both recorded DOIs (IBI and global); its notes say the other regional products carry their own.
- **Gap 4, DWD ICON-EU and Météo-France AROME.** The GRIB page lines and the register `attribution` fields gained the modification statement; the GRIB lines also gained the licence link.
- **ERA5 credit.** The About page shows the dataset credit with DOI `10.24381/cds.adbb2d47` beside the skill statement, and the `era5-reanalysis` register `attribution` holds it.
- **Register fields (owner decisions 3 and 4, wording part).** `attribution` was filled for `era5-reanalysis`, `meteofrance-marine-bulletins` (the credit "Météo-France" only: the date of last update is not shown anywhere and stays a duty in `notes`), `msq-queensland-tides` and `queensland-wave-buoys` from the wording recorded in their `notes`; the NOAA entries, `copernicus-insitu-observations`, `world-port-index`, the arrangements and the other empty fields stay empty.
- **French.** On `/fr/grib` only what a provider prescribes is shown as written (`data-i18n-owned`): the ECMWF service sentence, "Generated using E.U. Copernicus Marine Service Information", the DOIs, UKV's Crown copyright statement, and the licence names and links. Passage's own words (source labels such as "Météo-France AROME via Open-Meteo" and "ECMWF open data", and the modification clause) are translated. The same applies to the other new credit lines: the About ERA5 credit and the current block's Copernicus line are English as written, with their label translated.

**One wording per product.** The register `attribution` and the GRIB page line are the same text for ECMWF IFS, GLO12, IBI, ICON-EU and AROME, in the form credit; licence (link); modification clause, recorded in forecast-tiles `DATA-LICENSES.md` ("Credit lines for derived tiles") with the source files the clause rests on. UKV keeps its own register line, which differs from its GRIB line (see below). Lines recorded here for the Passage register, as the files their `recorded_in` cite:

- `ecmwf-open-data-charts`: the ECMWF line above with the clause "modified: cropped to the chart window, converted and drawn as isobar charts and wind arrows" (the chart footer in `render.py` says "cropped and drawn as isobars every 4 hPa"; the arrows come from the same prepared run).
- `copernicus-marine-currents`: "Generated using E.U. Copernicus Marine Service Information; doi:10.48670/moi-00027 (IBI), doi:10.48670/moi-00016 (global analysis and forecast)". The prepared grid does not record its product id (`grids_prep.py` keeps only the dataset id), an adjacent finding not fixed here.
- `era5-reanalysis`: "ERA5 reanalysis (Copernicus Climate Data Store), doi:10.24381/cds.adbb2d47; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)".
- `meteofrance-marine-bulletins`: "Météo-France".
- `msq-queensland-tides`: "State of Queensland (Transport and Main Roads, Maritime Safety Queensland); CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)".
- `queensland-wave-buoys`: "Queensland Government; for the Gladstone buoy, Queensland Government and Gladstone Ports Corporation; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)".

**Current block.** The Copernicus credit line is not shown under emulated current values, even when the record carries a real Copernicus dataset id.

**Modification statements.** They say what the code does: the tiles are converted and quantized, so the clause reads "modified: converted and quantized data". Only UKV's tiles are remapped (`adapter.py`), so "remapped" was not used for the other sources.

**Wording looked for and not found.** On 12 November 2026 the page the ECMWF register entry cites, <https://www.ecmwf.int/en/forecasts/datasets/open-data>, was read again through a fetch tool that summarises the page. It states "subject to appropriate attribution" and points to ECMWF's Terms of Use, but carries neither the service sentence nor a disclaimer, so the disclaimer is still not shown anywhere. The CDS page for ERA5 (<https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels>) gave only the DOI line under "Citation and attribution", not a citation text, so the ERA5 credit gives the dataset name, DOI and licence and no author citation. Nothing was recorded in `DATA-LICENSES.md` because nothing new was read.

**Gap 1, GRIB files (built, not switched on).** The owner chose text inside the file. The engine can now write, in GRIB2 Section 2 of every message, the dataset's credit line as on the GRIB page (for UKV with the Crown copyright, the CC BY-SA 4.0 label and link and its modification clause), a line saying Passage by DeepRegatta produced and modified the data and that it is not an official product of the provider, and the planning-not-navigation notice ([GRIB export → Credits inside the file](../grib-export.md#credits-inside-the-file-section-2-off-by-default)). ecCodes and cfgrib read files with it exactly as without it for every originating centre the exporter writes. It is **off by default**, so downloaded files still carry no credit: current XyGrib source has a commented-out check that discarded every record with a local section ("to allow ICON gribs"), so zyGrib and older XyGrib builds may drop such files, and no sailing reader (Adrena, qtVlm, OpenCPN, XyGrib, Expedition) has opened such a file. Switching it on waits for that check, Adrena first.

**Remains open:**

- Gap 1 for files users download (the credit section is built but off, see above), gap 5 (GRIB originating-centre metadata, which also decides whose definition the Section 2 text sits under) and the notice object in the public bucket.
- Gaps 6, 7 and 8 (EMODnet, Shom, OpenStreetMap in the chart archives).
- ECMWF's disclaimer and the full ERA5 citation: owner to supply, or a page that carries them.
- The NOAA credit, how a source that needs no credit should read, and the Open-Meteo link.
- Printing `licence_url` on About, and opening its terms sections by default or adding a credits line to the footer.
- Everything for warnings, tides and observations, the unregistered feeds, and credit fields in the prepared current grid JSON and the `.emodnet.npz` cuts.
- The tile manifests: `forecast-tiles/src/ingest/sources/openmeteo/registry.py` (AROME, ICON-EU, UKV) and `cmems.py` / `ibi.py` still write their earlier attribution strings into published manifests, so the About-page register lines and the manifest strings now differ until a producer change is made and a run published.
- PNG charts already published or committed as fixtures keep the old footer until regenerated.
- Inconsistencies that remain between surfaces:
  - Published tile manifests and the evidence inspector (`EvidenceInspector.jsx`, which prints the manifest's attribution) still show the earlier credit strings, until a producer change is made and a run published.
  - The UKV register line ("British Crown copyright, Met Office UKV via Open-Meteo; CC BY-SA 4.0. Modified: …") differs in form and wording from its GRIB page line.
  - The briefing route map uses a short ECMWF form, not the service sentence.
  - `msq-queensland-tides` records a "note changes" duty in its notes that its credit line does not carry (the feed is not in production).
