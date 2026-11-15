// Real checks for the export/import tests: the engine's own Check of a committed
// route on the calm scenario fixture, written by writeSnapshot into memory, so
// the files are exactly what a browser save stores. Nothing is written to disk.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScenarioBundleStore, buildCheckFile, checkFileText, persistSnapshot, runAnalysis } from '@deepweather/engine';
import { gzipText } from '../../src/lib/snapshotCodec.js';

const read = (path) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf8'));
const route = read('../../../config/routes/newport-newyork.json');
const profile = read('../../../config/profiles/default-limits.json');

/** The engine scenario synoptics: like every committed v2 check, they have no route_transitions. */
export const scenarioSynoptic = (scenario = 'reference-demo') => read(`../../../engine/test/fixtures/scenarios/${scenario}/synoptic.json`);

/**
 * One check's files ({ filename: text }) and id. Same inputs and clock, same check.
 * `routeExtras` adds fields to the route (inside the decision inputs, so the check stays whole);
 * `synoptic` adds a prepared synoptic document.
 */
export async function makeCheck({ passageId = 'passage-import-test', departureUtc = '2026-07-20T06:00:00Z', nowMs = Date.parse('2026-07-19T18:00:00Z'), name, routeExtras = {}, synoptic } = {}) {
  const store = new ScenarioBundleStore({ loadBundle: async (bundle) => read(`../../../engine/test/fixtures/scenarios/calm/${bundle}.json`) });
  const checkRoute = { ...route, passage_id: passageId, ...(name ? { name } : {}), ...routeExtras };
  const result = await runAnalysis({ route: checkRoute, profile, departureUtc, store, now: () => nowMs, ...(synoptic ? { synoptic } : {}) });
  const files = {};
  const memory = {
    exists: async () => false,
    read: async (_id, filename) => files[filename] ?? null,
    list: async () => [],
    write: async (_id, filename, content) => { files[filename] = content; },
  };
  const snapshotId = await persistSnapshot(memory, result, checkRoute, nowMs);
  return { snapshotId, files };
}

/** The check file's text and gzip bytes for these files, as an export makes them. */
export async function checkFileOf({ snapshotId, files }, { exportedAt = '2026-11-15T12:00:00.000Z' } = {}) {
  const text = checkFileText(buildCheckFile({ snapshotId, files, exportedAt, exportedBy: 'Passage engine 0.2.0' }));
  return { text, bytes: await gzipText(text) };
}

/** Gzip any text (a hostile file's document). */
export const gzipOf = (text) => gzipText(text);

/** A File the importer reads, from bytes. */
export const fileOf = (bytes, name = 'passage-check.json.gz') => new File([bytes], name, { type: 'application/gzip' });
