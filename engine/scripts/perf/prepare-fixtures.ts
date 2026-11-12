/**
 * Writes the synthetic forecast the browser measurement serves, as static
 * files, so the same files can also be served to a phone:
 *
 *   forecast/latest.json, forecast/forecast-runs/<run>/manifest.json and the PFT1 tiles
 *   api/polars/invented-cruiser                       (a formula-built invented polar)
 *   forecast/prepared/runs/<name>/current_grid.json   prepared current grids for the Channel passage
 *   meta.json                                         passages, clock and file names for the harness
 *
 *   npm run perf:fixtures -w engine            writes ../output/perf/fixtures (git-ignored)
 *   npm run perf:fixtures -w engine -- --live  writes ../output/perf/fixtures-live on the real clock, for a phone
 *
 * Nothing here is a real forecast or a real boat; see engine/scripts/perf/scenarios.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --live: build the scenario on the real clock instead of the fixed 2026-07-20 one (for a phone)
const live = process.argv.includes('--live');
if (live) process.env.PERF_NOW = new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const { routeBbox } = await import('../../src/fetch/liveGrids.js');
const { CYCLE, DEPARTURE_ISO, INVENTED_POLAR_ENTRY, NOW_ISO, PASSAGES, buildPerfTransport, preparedCurrentGrid } = await import('./scenarios.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv.find((arg, k) => k > 1 && !arg.startsWith('--')) ?? join(HERE, '..', '..', '..', 'output', 'perf', live ? 'fixtures-live' : 'fixtures'));

const put = (relative: string, body: string | Uint8Array) => {
  const file = join(outDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};

const transport = buildPerfTransport();
put('forecast/latest.json', JSON.stringify(transport.latest));
for (const [runId, manifest] of transport.manifests) put(`forecast/forecast-runs/${runId}/manifest.json`, JSON.stringify(manifest));
let tileBytes = 0;
for (const [key, bytes] of transport.tiles) { put(`forecast/forecast-runs/${key}`, bytes); tileBytes += bytes.byteLength; }
put('api/polars/invented-cruiser', JSON.stringify(INVENTED_POLAR_ENTRY));

// Prepared current grids for the Channel passage: they cover its router box; one of them
// runs out in the last candidate's search; one is too small for the router (a gap).
const channel = PASSAGES.find((p) => p.id === 'channel-63nm')!;
const box = routeBbox(channel.start, channel.finish);
const around = (m: number) => ({ minLat: box.minLat - m, maxLat: box.maxLat + m, minLon: box.minLon - m, maxLon: box.maxLon + m });
const preparedBase = new Date(Date.parse(DEPARTURE_ISO) - 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'); // fetched two hours before the first departure
const lastDepartureMs = Date.parse(DEPARTURE_ISO) + 120 * 3600_000;
const grids = {
  covering: preparedCurrentGrid({ box: around(0.3), baseIso: preparedBase, hours: 130 }),
  // axis holds every departure, ends one hour after the last: the router runs out of it on the last candidate
  'runs-out': preparedCurrentGrid({ box: around(0.3), baseIso: preparedBase, hours: Math.ceil((lastDepartureMs - Date.parse(preparedBase)) / 3600_000) + 1 }),
  small: preparedCurrentGrid({ box: { minLat: Math.min(channel.start.lat, channel.finish.lat) - 0.1, maxLat: Math.max(channel.start.lat, channel.finish.lat) + 0.1, minLon: Math.min(channel.start.lon, channel.finish.lon) - 0.1, maxLon: Math.max(channel.start.lon, channel.finish.lon) + 0.1 }, baseIso: preparedBase }),
};
const prepared: Record<string, { run_id: string; artifact: string; dims: string }> = {};
for (const [name, grid] of Object.entries(grids)) {
  const runId = `perf-channel-${name}`;
  const artifact = `runs/${runId}/current_grid.json`;
  grid.run_id = runId;
  put(`forecast/prepared/${artifact}`, JSON.stringify(grid));
  prepared[name] = { run_id: runId, artifact, dims: `${grid.nlat}x${grid.nlon}x${grid.time_axis.length}` };
}

put('meta.json', JSON.stringify({
  nowIso: NOW_ISO, cycle: CYCLE, departureIso: DEPARTURE_ISO, polarId: INVENTED_POLAR_ENTRY.id, polarLabel: INVENTED_POLAR_ENTRY.label,
  passages: PASSAGES.map(({ id, label, start, finish }) => ({ id, label, start, finish })), prepared,
}, null, 2));
console.log(`wrote ${outDir}: ${transport.tiles.size} tiles (${(tileBytes / 1e6).toFixed(1)} MB compressed), ${Object.keys(prepared).length} prepared grids`);
