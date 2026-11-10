// Text a sailor wants before downloading a GRIB file, shared by the React page
// (pages/grib/GribInfo.jsx, below the tool) and the build-time prerender
// (scripts/prerender-fr.mjs renderGribHtml), so a non-JS fetch of /grib and
// /fr/grib reads the same words the app shows. DOM-free for Node.
//
// English is the source: every string is a key in the i18n.js catalogue (see
// the "GRIB information" block there). Each block is a single text node so the
// runtime localiser and translateText() agree. Every claim is backed by code or
// docs (docs/grib-export.md, docs/forecast-tile-format.md, engine/src/export,
// viewer/src/lib/gribExport.js); a program not yet opened in the real
// application says so. Re-check it when a model, a horizon or a reader changes.

import { privacyPath } from './lib/routes.js';

// Block types: h2, h3, p, ul (items), privacy (text + link to the privacy page).
export const GRIB_INFO_BLOCKS = [
  { type: 'h2', text: 'Which models are used' },
  { type: 'p', text: 'Each file comes from one model run. After you build a file, File details names the run, for example “ECMWF 06Z”.' },

  { type: 'h3', text: 'Wind' },
  { type: 'p', text: 'Passage chooses the wind model from your area, and falls back to the other global model when the first has no data there. You can switch with the model buttons next to the download button.' },
  { type: 'ul', items: [
    'ECMWF: the default when the centre of your box is in Europe (25–72°N, 35°W–45°E). Global, 0.25° grid (about 28 km), every 3 h to +144 h, then every 6 h to +240 h.',
    'GFS (NOAA): the default outside Europe. Global, 0.25° grid (about 28 km), every hour to +120 h, then every 3 h to +240 h.',
    'AROME (Météo-France), optional: 0.025° grid (about 2.8 km), every hour to +51 h, over France and its surrounding waters (37.5–55.4°N, 12°W–16°E).',
    'ICON-EU (DWD), optional: 0.0625° grid (about 7 km), every hour to +78 h, then every 3 h to +120 h, over 29.5–70.5°N, 23.5°W–62.5°E.',
    'UKV (Met Office), optional: about 2 km, every hour to +54 h, over the UK.',
  ] },
  { type: 'p', text: 'AROME, ICON-EU and UKV appear only when their forecast is published for your area, and they are never the default. For a fixed period such as the next 3 days they must cover all of it; otherwise the page shows a Shorter forecast line with the longest period they do cover.' },
  { type: 'p', text: 'Gusts depend on the model. GFS and UKV give an instantaneous gust. ECMWF gives the maximum over the 1, 3 or 6 hours before each time, and AROME and ICON-EU the maximum over the previous hour.' },

  { type: 'h3', text: 'Waves' },
  { type: 'p', text: 'GFS-Wave (NOAA/NCEP) is the only wave model: 0.25° grid (about 28 km), every 3 h to +384 h. There is no wave data over land.' },

  { type: 'h3', text: 'Currents' },
  { type: 'ul', items: [
    'IBI (Copernicus Marine), the default wherever it covers your whole box: regional model, 1/36° grid (about 3 km), every hour to +120 h, tide included, over 26–56°N, 19°W–5°E.',
    'Global (Copernicus Marine, GLO12): used when IBI covers only part of your box or none of it. 1/12° grid (about 9 km), every 6 h to +240 h. Tides are not resolved.',
  ] },
  { type: 'p', text: 'Both are ocean-model currents. Neither is an official tidal-stream prediction.' },

  { type: 'h2', text: 'How current the forecast is' },
  { type: 'p', text: 'When you press a download button, Passage reads the newest published run, and checks the list of runs again if the last check is over 10 minutes old. File details gives the run and the times in each file.' },
  { type: 'p', text: 'Publication schedule, as set in Passage’s forecast pipeline: GFS and GFS-Wave every 6 hours, ECMWF four runs a day (00Z and 12Z to +240 h, 06Z and 18Z to +144 h), currents once a day, AROME, ICON-EU and UKV twice a day. A run reaches Passage some time after its model time, so check the run in File details.' },

  { type: 'h2', text: 'What is in the files' },
  { type: 'ul', items: [
    'Wind file: wind at 10 m (east and north components) and gusts, in metres per second (1 m/s = 1.944 knots).',
    'Waves file: significant wave height; primary wave period and direction; wind-wave height, period and direction; swell height, period and direction (first swell partition). Heights are in metres, periods in seconds, directions in degrees true, the direction the waves come from.',
    'Currents file: surface current (east and north components), in metres per second.',
    'Wind + currents file: the wind file followed by the currents file, unchanged, so it holds two grids. The page offers it only when both files can be made. Waves are not included.',
    'All files are GRIB2 on a regular latitude/longitude grid. Land, and anywhere outside a regional model, is left empty. A box across the 0° meridian works (tested in Adrena).',
    'File names look like passage_wind-gfs_20260923T00Z_N48W006_N51E002.grb2: model, run, then the south-west and north-east corners.',
  ] },

  { type: 'h2', text: 'What is not in the files' },
  { type: 'p', text: 'No pressure or isobars, rain, temperature, cloud cover or visibility. The GRIB files hold only the fields listed above, and pressure is not in Passage’s forecast data.' },

  { type: 'h2', text: 'Opening the files in your software' },
  { type: 'p', text: 'The files are standard GRIB2. We decoded sample files for three areas (the Channel, the mid-Atlantic and a box across 0°) with ecCodes, and every message matched the forecast data within rounding. Apart from Adrena, we have not yet opened them in the programs below: the notes for OpenCPN, qtVlm and XyGrib come from their source code or manual.' },
  { type: 'ul', items: [
    'Adrena: read the wind and currents files in our test on 2026-09-27, including a box across 0°. Not yet tested in Adrena: waves files, the wind + currents file, and gusts.',
    'OpenCPN (GRIB plugin): open the GRIB dialog and choose the file. Not yet tested in the application. From its source code, it should read wind, gusts, currents and wave height, and it draws wave arrows and period from the wind waves. It drops swell and the primary wave period and direction, as it does with NOAA’s own GFS-Wave files. It can load several files, so the separate wind and currents files should open together.',
    'XyGrib: choose File > Open. Not yet tested in the application. From its source code, it should read wind, gusts, currents and waves (height, primary direction and period), but it drops swell, as it does with NOAA’s own files. It opens one file at a time, so use the wind + currents file to see both.',
    'qtVlm: load the wind file in one GRIB slot and the currents file in another (from its manual). Not yet tested. The 2013 open-source version skipped gusts written as a maximum over a period (ECMWF, AROME, ICON-EU) and the current version is unverified, so those gusts may not appear. Whether it reads the waves file is unknown.',
  ] },

  { type: 'h2', text: 'Limits' },
  { type: 'ul', items: [
    'Not for navigation: this is forecast data for planning. Check official forecasts and warnings.',
    'The area is a box you draw: at least 0.25° on each side, snapped outward to 0.1°, and it cannot cross the 180° meridian.',
    'A file estimated at over 200 MB is refused, because your browser holds all of its data in memory. Draw a smaller box, choose a shorter period, or thin the time steps to every 3 h or 6 h under More options.',
    'AROME, ICON-EU and UKV have a tighter size budget: a large box can be refused with “Choose a smaller area for this regional model.”',
    'AROME, ICON-EU and UKV forecasts are shorter than the global ones. Full forecast takes each model to its own last time.',
    'No server builds the files. Your browser reads the forecast tiles for your area from Passage’s storage and writes the file itself, with no account.',
  ] },

  { type: 'h2', text: 'Data and privacy' },
  { type: 'p', text: 'Data: NOAA/NCEP (GFS, GFS-Wave), ECMWF open data (CC BY 4.0), Météo-France (AROME), Deutscher Wetterdienst (ICON-EU) and the Met Office (UKV) via Open-Meteo, and E.U. Copernicus Marine Service information. The exact attribution for your files is shown under the download buttons.' },
  { type: 'privacy', text: 'Privacy policy' },
];

/** Every English string of the section, in order (for translation checks). */
export function gribInfoTexts() {
  return GRIB_INFO_BLOCKS.flatMap((block) => (block.type === 'ul' ? block.items : [block.text]));
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The section as static HTML for a language; `translate` is translateText. */
export function gribInfoHtml(language, translate) {
  const t = (text) => escapeHtml(translate(text, language));
  return GRIB_INFO_BLOCKS.map((block) => {
    switch (block.type) {
      case 'h2': return `<h2>${t(block.text)}</h2>`;
      case 'h3': return `<h3>${t(block.text)}</h3>`;
      case 'p': return `<p>${t(block.text)}</p>`;
      case 'ul': return `<ul>${block.items.map((item) => `<li>${t(item)}</li>`).join('')}</ul>`;
      case 'privacy': return `<p><a href="${privacyPath(language)}">${t(block.text)}</a></p>`;
      default: throw new Error(`grib: unknown block type ${block.type}`);
    }
  }).join('');
}
