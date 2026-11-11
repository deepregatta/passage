# Licence verification: proposals for the owner

_12 November 2026. A dated review, not current product guidance and not legal advice. It proposes values for the two licence registers; it changes neither. An entry moves from `unconfirmed` only when the owner confirms it._

**Provenance.** Each provider's own pages were read on 12 November 2026, by one reader and then again by a second. Most were read through a fetch tool that returns a summary of the page, not its full text, so clause numbers and wording below are paraphrases to check against the page. The MeteoAlarm terms were read in full in a browser. Pages that could not be read are listed at the end. Registers: `contracts/forecast-tiles-data-sources.json` (vendored from forecast-tiles) and `config/data-sources.json`.

## Conclusion

Of the 33 register entries, 20 can be proposed as redistributable, each with conditions. Twelve cannot yet, and one is Passage's own data. Three of the twelve need a decision before anything else, because the terms found may not allow what Passage does today:

1. **Australian marine warnings (BOM).** Every Bureau page refused automated reading. A search summary, unverified, says the default terms cover personal and in-house use only and that onward supply needs a Registered User arrangement.
2. **UK shipping forecast (Met Office).** The website's terms license content under the Open Government Licence but prohibit automated page-scraping outside official APIs. Passage parses the printable page, and no official feed for this text exists.
3. **UKV model data.** The public cloud registry states CC BY-SA 4.0. A Met Office page that names UKV 2 km states CC BY-NC-ND 4.0. It probably describes an older offering, but that is an inference. NC-ND would bar derived tiles.

## Proposed `yes`, with conditions

| Register id | Licence or status found | Conditions | Share-alike | Confidence |
|---|---|---|---|---|
| `noaa-gfs`, `noaa-gefs` | US Government work, public domain; NOAA's open-data listings say the data can be used as desired | Credit requested for unaltered data. Do not present modified data as official; imply no endorsement; the NWS name and logo are trademarks | No | High |
| `noaa-gfs-wave` | Same, by inference: no page names the wave files | Same | No | Medium |
| `noaa-coops-tides` | Public domain (NOS disclaimer) | Credit requested; data are "as is"; modified data must not be shown as official | No | High |
| `nws-marine-alerts` | Open data, free for any purpose (API documentation) | A User-Agent identifying the application is required; unpublished rate limits | No | High |
| `ecmwf-open-ifs`, `ecmwf-open-data-charts` | CC BY 4.0 plus ECMWF's Terms of Use for open data | For a service built on the data, the credit ECMWF gives is "This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)", shown prominently with the source, the licence link, ECMWF's disclaimer and a statement that the data were modified. ECMWF may ask for the credit to be removed | No | Medium–high |
| `era5-reanalysis` | CC BY 4.0, replacing the older Copernicus licence on 2 July 2025 | The dataset's own citation with its DOI (10.24381/cds.adbb2d47). The older "Copernicus Climate Change Service information" sentence and disclaimer belong to the previous licence. Downloads need a Climate Data Store account | No | Medium |
| `cmems-glo12`, `cmems-ibi`, `copernicus-marine-currents`, `copernicus-marine-ssh-tides` | One Copernicus Marine licence for the whole catalogue | See "Copernicus Marine" below | No | Medium |
| `dwd-icon-eu` | CC BY 4.0 (DWD legal notice) | Credit DWD and indicate changes; DWD's page of credit templates was not read. Reaches Passage through Open-Meteo's bulk files: subject to decision 5 | No | Medium |
| `meteofrance-marine-bulletins` | Licence Ouverte 2.0 on the government portal's dataset page; this is the dataset `warnings_mf.py` reads | Credit Météo-France and the date of last update; imply no endorsement | No | High |
| `msq-queensland-tides` | CC BY 4.0 on the Queensland portal (two of four prediction datasets checked; one near-real-time dataset shows CC BY 3.0) | Credit the State of Queensland (Transport and Main Roads, Maritime Safety Queensland), licence link, note changes | No | Medium |
| `queensland-wave-buoys` | CC BY 4.0 on the Queensland portal (Gladstone record read) | Credit the Queensland Government; the Gladstone buoy is run jointly with Gladstone Ports Corporation | No | Medium |
| `emodnet-bathymetry` | CC BY 4.0 | EMODnet's credit sentence and the DTM's DOI. The DTM's catalogue records, not the terms page, say it is not for navigation | No | High |
| `shom-balisage` | Licence Ouverte 2.0 | Credit Shom and the date of last update. The portal page says the dataset has no DOI. It is harvested from a Shom portal whose own terms were not read | No | Medium |
| `openstreetmap` | ODbL 1.0 | Credit OpenStreetMap with a link; ship the ODbL notice with distributed data | **Yes** for a derived database | High on the licence |
| `protomaps-basemap` | Tiles ODbL (as a produced work of OSM), code BSD-3-Clause, styles CC0 | "© OpenStreetMap" visible. The build also holds ESA WorldCover (CC BY 4.0, credit needed if the land-cover layer is shown), Mapzen icons (MIT notice), coastline polygons (ODbL) and Natural Earth (public domain). A fork or tile service must not use the Protomaps name | ODbL on the tiles | Medium–high |

### Copernicus Marine

- Derived works may be distributed for any purpose with the credit "Generated using E.U. Copernicus Marine Service Information" and each product's DOI. Redistribution in the original form uses a different wording, without "Generated using".
- The credit goes on the home page or on the page where users get the data.
- A clause asks licensees to keep records that trace product use, and says that duty passes into every downstream licence. A public bucket cannot trace its users. This is the main obstacle and the reason for medium confidence.
- The licence carries an indemnity, is under French law, has no version number and can be revised at any time.
- Downloads need a personal login. No page of the service says any product can be downloaded without one.

## Not yet proposable (stay `unconfirmed`)

| Register id | What was found | What is missing |
|---|---|---|
| `bom-marine-warnings` | Every Bureau page refused automated reading. Unverified summary: default copyright allows personal and in-house use, not onward supply; the FTP guide points to Registered User Services | The Bureau's copyright page, anonymous-FTP product listing and FTP user guide, read in person. Leans `no` |
| `metoffice-shipping-forecast` | Site content is under OGL v3.0 with exclusions; the terms ban robots and page-scrapers outside official APIs. The Met Office's RSS feeds cover warnings and news, not marine forecasts. The forecast is issued on behalf of the Maritime and Coastguard Agency, so a third party may hold the copyright | Written authorisation, or a licensed data service. The Met Office open-data policy and DataHub terms were not read |
| `metoffice-ukv` | CC BY-SA 4.0 with British Crown copyright on the cloud registry entry (a two-year archive, a few hours' latency). A Met Office page naming UKV 2 km states CC BY-NC-ND 4.0, with a 24-hour delay and seven-day retention, which reads like an older offering | The Met Office's confirmation of which licence applies. If BY-SA: tiles and GRIB exports carry the credit, the licence link, a modification notice and the BY-SA label |
| `meteoalarm-warnings` | The terms (15 March 2024) allow redistribution on terms equivalent to CC BY 4.0 with seven added requirements, listed below | Whether Passage meets them, above all the real-time one |
| `meteofrance-arome` | No current Météo-France page naming the licence for AROME model data was found. Older pages suggest Licence Ouverte | The data portal's current terms |
| Open-Meteo bulk files (the route for AROME, ICON-EU and UKV; no register id) | The bucket's README says CC BY 4.0. Open-Meteo's terms limit the non-commercial rule to its "free API services" and do not mention the bucket. Its licence page asks for a "Weather data by Open-Meteo.com" link | A statement from Open-Meteo. It matters if Passage becomes paid |
| `ndbc-observations` | NDBC data is public domain, but the two buoys Passage reads (62103, 62050) are owned by the UK Met Office and NDBC states no terms for relayed data | The Met Office's terms for those observations |
| `copernicus-insitu-observations` | Same Copernicus Marine licence; no extra condition seen on the product page | The product's user manual, where contributor conditions would be. Which in-situ product is read |
| `gshhg` | LGPL since version 2.2.2; the NOAA archive copy is labelled CC0 1.0 | Which statement governs the downloaded file, and what LGPL reaches for a derived land index |
| `open-waters-seamap` | Identified, with medium confidence, as a project stating CC BY 4.0 for tiles and ODbL for OSM-derived data | Confirmation that this is the project used; the bathymetry source's terms |
| `world-port-index` | NGA's own pages could not be read. Public-domain status rests on secondary sources | NGA's page. The bundled copy came through a third-party portal, which may add terms |
| `openstreetmap-base-map` | Displayed, not redistributed. The tile policy forbids bulk download, requires visible credit and warns commercial services that access can be withdrawn | Nothing; a decision if Passage becomes paid |
| `openseamap-seamarks` | Data ODbL; tiles CC BY-SA (version 2.0, from a search summary). No tile usage policy found | OpenSeaMap's own page |

`forecast-tiles-service` is Passage's own tiles, not a third-party source; it follows the forecast-tiles register.

### MeteoAlarm's added requirements

In paraphrase:

1. modified information is shown together with the same information unmodified;
2. across several countries, the source is named "EUMETNET – MeteoAlarm";
3. for a single country, the national service that issued the warning is named;
4. the time of issue is shown;
5. an internet application links to meteoalarm.org;
6. operational redistribution is in real time: under five minutes behind on average, never more than ten;
7. a set disclaimer about possible delays is published.

A saved briefing keeps a warning as it was at check time, which is by design not real time. Whether that is "operational redistribution" is a question for the owner, or for MeteoAlarm.

## Decisions and actions for the owner

1. **BOM.** Read the Bureau's copyright page, FTP product listing and FTP user guide. Until then, consider whether the Australian warnings feed should stay live on a public site.
2. **Met Office shipping forecast.** Ask the Met Office for authorisation or a licensed service, and decide whether to keep parsing the page meanwhile.
3. **UKV.** Ask the Met Office which licence applies to the registry data. Then decide the licence label and modification notice on UKV tiles and GRIB exports.
4. **MeteoAlarm.** Decide how saved briefings stand against the real-time requirement, and check the page against the other six.
5. **Open-Meteo and AROME.** Ask Open-Meteo whether the bulk files are free of the non-commercial rule; read Météo-France's current terms for AROME.
6. **Met Office buoys through NDBC.** Read the Met Office's terms for marine observations.
7. **Copernicus Marine.** Read the record-keeping clause and decide whether a public bucket is compatible with it. Save a dated copy of the licence.
8. **OpenStreetMap in vector chart archives** (Tactician's chart pack, published by forecast-tiles). If features can be extracted from the archives, they are a derived database under ODbL, not a produced work.
9. **GSHHG and the port index.** Read the licence file inside the GSHHG archive; fetch the port index from NGA directly.
10. **A source missing from the registers.** `analysis/src/deepweather_analysis/openmeteo_history.py` calls Open-Meteo's historical-forecast API for the verification corpus. That is the free API, under the non-commercial terms. It needs a register entry, or a note that it is research-only.

## What confirmation would change

- For each confirmed row: `licence`, `licence_url`, `attribution`, `share_alike`, `redistribute`, `verified_on` and `verified_from` in the register that owns it (forecast-tiles first, then re-vendored here).
- A separate task, not started: compare what the site, the tiles and the GRIB exports show today with the credits, disclaimers and modification notices listed above. Several conditions (ECMWF's service credit and disclaimer, Copernicus credits with DOIs, UKV's ShareAlike label, MeteoAlarm's disclaimer and link) are obligations on the product, not only register fields.

## Not determined

- Pages not read: every Bureau of Meteorology page (refused), NGA's port-index and terms pages (errors), the GSHHG home page (certificate error), OpenSeaMap's FAQ (not found), the Met Office shipping-forecast page itself, its open-data policy and DataHub terms, NOAA's NOMADS terms, DWD's credit templates, the Shom source portal, two of the four Queensland tide datasets.
- Full texts not read: ECMWF's Terms of Use, the Copernicus Marine licence, the ODbL legal code.
- Whether any provider restricts commercial use beyond its licence. NOAA's pages do not address it.
- What the Copernicus Marine service agreement says about the period after 30 June 2028.
- For later tasks: the North-West Shelf product (`NWSHELF_ANALYSISFORECAST_PHY_004_013`) falls under the same Copernicus Marine licence, and ECMWF's AIFS open data shares the IFS open-data terms.
