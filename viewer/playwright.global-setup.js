import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Refuse to run fixture tests against a live-data or stale dev server. */
export default async function verifyDemoServer(config) {
  const base = config.projects[0].use.baseURL;
  try {
    const identity = await fetch(new URL('/__passage_fixture', base), { signal: AbortSignal.timeout(5_000) });
    if (!identity.ok || (await identity.json()).fixture !== 'demo') {
      throw new Error('server is not running with VITE_DW_FIXTURE=demo');
    }
    const index = await fetch(new URL('/data/index.json', base), { signal: AbortSignal.timeout(5_000) });
    const expected = readFileSync(path.join(import.meta.dirname, 'test/fixtures/demo/index.json'), 'utf8');
    if (!index.ok || await index.text() !== expected) throw new Error('served demo index differs from this checkout');
  } catch (cause) {
    throw new Error(`Playwright requires the viewer-demo launch configuration at ${base}: ${cause.message}`, { cause });
  }
}
