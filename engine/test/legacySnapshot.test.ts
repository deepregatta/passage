/**
 * A passage saved before checks recorded the current grid's time step
 * (fixtures/legacy-current-snapshot, written by the engine of f75248e: see
 * scripts/make-legacy-current-snapshot.ts) still validates, verifies its identity
 * exactly as before, reopens unchanged on an exact retry, and gets no hours with
 * and against the current. The fixture is never regenerated.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assembleAudit } from '../src/findings.js';
import { renderBriefing } from '../src/briefing.js';
import { contentHash } from '../src/hash.js';
import { routeRevision } from '../src/identity.js';
import { writeSnapshot } from '../src/snapshot.js';
import { NodeFsSnapshotStore } from '../src/io/node.js';
import { currentSummary } from '../src/currentSummary.js';
import type { Findings, Route } from '../src/types.js';
import { LEGACY_FILES, legacyOptions } from './helpers/legacyCurrentSnapshot.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = fileURLToPath(new URL('./fixtures/legacy-current-snapshot/', import.meta.url));
const raw = (file: string) => readFileSync(join(DIR, file), 'utf8');
const json = <T = Record<string, unknown>>(file: string) => JSON.parse(raw(file)) as T;
const findings = json<Findings>('findings.json');
const manifest = json('snapshot.json');
const saved = json('decision-inputs.json');
const route = json<Route>('route.json');
const currentsRecord = (f: Findings) => f.inputs.forecast_tiles.find((item) => item.layer === 'currents')!;
const schema = (name: string) => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(ROOT, 'contracts', `${name}.schema.json`), 'utf8')));
};

describe('a check saved before the time step was recorded', () => {
  it('is what it claims: an identity-v2 check on an hourly IBI-named prepared grid, with no recorded step', () => {
    expect(findings.identity_version).toBe(2);
    const record = currentsRecord(findings);
    expect(record).toMatchObject({ current_source: 'prepared', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m' });
    expect(record).not.toHaveProperty('time_step_h');
    expect(findings.legs.flatMap((leg) => leg.hours).every((hour) => hour.current)).toBe(true);
  });

  it('validates against the current contracts', () => {
    for (const [name, doc] of [['findings', findings], ['snapshot', manifest], ['route', route]] as const) {
      const validate = schema(name);
      expect(validate(doc), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('verifies its identity exactly as before', () => {
    expect(contentHash(saved)).toBe(findings.decision_hash);
    expect(manifest.decision_hash).toBe(findings.decision_hash);
    expect(findings.snapshot_id).toBe(`snapshot_v2_${findings.decision_hash}`);
    expect(manifest.snapshot_id).toBe(findings.snapshot_id);
    expect(routeRevision(route, findings.departure_utc)).toBe(findings.route_revision);
    expect(manifest.route_revision).toBe(findings.route_revision);
    expect(contentHash(route)).toBe(findings.inputs.route_hash);
    // the frozen grid's digest, as recorded
    expect(contentHash((saved as { currentGrid: unknown }).currentGrid)).toBe(currentsRecord(findings).content_digest);
  });

  it('the same inputs checked by this engine give the same identity; the findings differ only by the recorded step', () => {
    const { findings: again, decisionInputs: inputs } = assembleAudit(legacyOptions(ROOT, contentHash), { savedIdentity: true });
    expect(JSON.parse(JSON.stringify(inputs))).toEqual(saved);
    expect(again.decision_hash).toBe(findings.decision_hash);
    expect(again.snapshot_id).toBe(findings.snapshot_id);
    expect(again.route_revision).toBe(findings.route_revision);
    expect(currentsRecord(again).time_step_h).toBe(1);
    const withoutStep = JSON.parse(JSON.stringify(again)) as Findings;
    delete currentsRecord(withoutStep).time_step_h;
    expect(withoutStep).toEqual(findings);
  });

  it('an exact retry reopens the saved check unchanged: the old findings are never rewritten', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-current-'));
    try {
      cpSync(DIR, join(root, findings.snapshot_id), { recursive: true });
      const options = legacyOptions(ROOT, contentHash);
      const { findings: again, decisionInputs: inputs } = assembleAudit(options, { savedIdentity: true });
      const reopened = await writeSnapshot(new NodeFsSnapshotStore(root), again, renderBriefing(again),
        { route: options.route, decisionInputs: inputs }, Date.parse('2026-11-13T00:00:00Z'));
      expect(reopened.manifest).toEqual(manifest);
      expect(readdirSync(join(root, findings.snapshot_id)).sort()).toEqual([...LEGACY_FILES].sort());
      for (const file of LEGACY_FILES) expect(readFileSync(join(root, findings.snapshot_id, file), 'utf8'), file).toBe(raw(file));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shows the current block as before: every figure, and no hours with and against the current', () => {
    const summary = currentSummary(findings, route)!;
    expect(summary).not.toBeNull();
    expect(summary.strongest).not.toBeNull();
    expect(summary.gain).not.toBeNull();
    expect(summary.with_against).toBeNull();
    // the same check recorded today would get them
    const today = structuredClone(findings);
    currentsRecord(today).time_step_h = 1;
    expect(currentSummary(today, route)!.with_against).not.toBeNull();
  });
});
