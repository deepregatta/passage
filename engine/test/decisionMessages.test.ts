import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DECISION_MESSAGE_REGISTRY, EN_DECISION_MESSAGES, decisionMessageDefinitions, isDecisionMessageRef, renderDecisionRegister, validDecisionMessageFields } from '../src/briefingMessages.js';
import { plainValueVsLimit, VERDICT_TEXT } from '../src/plainLanguage.js';
import { expect, it } from 'vitest';
import { writeSnapshot } from '../src/snapshot.js';
import { renderBriefing } from '../src/briefing.js';
import type { Findings } from '../src/types.js';

const baseline = JSON.parse(readFileSync(new URL('./golden/findings-cherbourg-plymouth.json', import.meta.url), 'utf8')) as Findings;

it('emits stable semantic decision IDs and literal typed driver facts beside saved English', () => {
  const findings = structuredClone(baseline);
  findings.gates = [];
  findings.verdict.state = 'exceeds';
  const driver = findings.evidence.find(e => e.evidence_id === findings.verdict.driver_evidence_id)!;
  delete driver.member_fraction;
  Object.assign(driver, { source_kind: 'deterministic', rule_id: 'W-GUST-01', value: 28.1, limit: 28, units: 'kt', valid_time: '2026-07-12T18:00:00Z' });
  findings.legs.find(l => l.leg_id === driver.leg_id)!.name = 'Wind limit <img src=x onerror=alert(1)> Jul';
  const decision = renderBriefing(findings).sections.find(s => s.id === 'decision')!;
  expect(decision).toMatchObject({ messages: {
    title: { message_id: 'briefing.decision.title.v1', params: {} },
    plain: [
      { message_id: 'briefing.decision.exceeds.plain.v1', params: {} },
      { message_id: 'briefing.decision.numeric.plain.v1', params: {
        value: 28.1, limit: 28, units: 'kt', style: 'just_over', relation: 'over',
        leg_name: 'Wind limit <img src=x onerror=alert(1)> Jul', valid_time: '2026-07-12T18:00:00Z',
      } },
    ],
  } });
  expect(decision.register_plain).toContain('gusts just over your 28 kt limit');
  expect(findings.snapshot_id).toBe(baseline.snapshot_id);
});


const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const cases = read('./fixtures/decision-messages.json').cases;
const ajv = new Ajv2020({ strict: false, strictNumbers: true });
addFormats(ajv);
const writer = read('../../contracts/briefing.schema.json');
const reader = read('../../contracts/briefing-reader.schema.json');
const validateWriter = ajv.compile(writer);
const validateReader = ajv.compile(reader);

it('validates actual producer output, generated schema parity and every registered EN ID', () => {
  const ids = new Set<string>();
  for (const { briefing } of cases) {
    expect(validateWriter(briefing), JSON.stringify(validateWriter.errors)).toBe(true);
    expect(validateReader(briefing)).toBe(true);
    const section = briefing.sections[0];
    expect(validDecisionMessageFields(section)).toBe(true);
    for (const ref of [section.messages.title, ...section.messages.plain, ...section.messages.pro]) ids.add(ref.message_id);
    expect(validDecisionMessageFields({ ...section, register_plain: 'Changed fallback without changing IDs' })).toBe(false);
  }
  expect([...ids].sort()).toEqual(Object.keys(DECISION_MESSAGE_REGISTRY).sort());
  expect(Object.keys(EN_DECISION_MESSAGES).sort()).toEqual([...ids].sort());
  expect(writer.$defs).toEqual(decisionMessageDefinitions(true));
  expect(reader.$defs).toEqual(decisionMessageDefinitions(false));
});

it.each([
  ['W-GUST-01', 28.1, 28, 'kt'], ['W-SUST-01', 18, 20, 'kt'],
  ['S-HS-01', 2.6, 2.5, 'm'], ['C-CAPE-01', 1400, 1000, 'J/kg'],
  ['V-VIS-01', 0.5, 2, 'nm'], ['W-SUST-01', 8, 20, 'kt'],
] as const)('preserves numeric English facts and relation for %s', (rule_id, value, limit, units) => {
  const findings = structuredClone(baseline);
  findings.gates = [];
  findings.verdict.state = 'exceeds';
  const driver = findings.evidence.find(e => e.evidence_id === findings.verdict.driver_evidence_id)!;
  Object.assign(driver, { source_kind: 'deterministic', rule_id, value, limit, units });
  delete driver.member_fraction;
  const section = renderBriefing(findings).sections.find(s => s.id === 'decision')!;
  expect(section.messages?.plain).toHaveLength(2);
  expect(section.register_plain).toContain(plainValueVsLimit(rule_id, value, limit, units));
  expect(section.register_plain).toContain(VERDICT_TEXT.exceeds!.plain);
  expect(validDecisionMessageFields(section)).toBe(true);
});

it('keeps gated decisions and noncatalogued units whole-field legacy', () => {
  const findings = structuredClone(baseline);
  findings.gates = [{ gate_id: 'gate', name: 'Gate', leg_id: 'L1', reference_port: 'Port', distance_nm: 1, favorable: [], transit: { from: '2026-07-12T18:00:00Z', to: '2026-07-12T19:00:00Z' }, status: 'conflict', rule_text: 'legacy timing rule; unverified' }];
  const section = renderBriefing(findings).sections.find(s => s.id === 'decision')!;
  expect(section.messages?.plain).toBeUndefined();
  expect(section.messages?.pro).toBeUndefined();
  expect(section.register_plain).toContain('outside the favorable stream (legacy timing rule)');
  expect(section.register_pro).toContain('legacy timing rule; unverified');
  findings.gates = [];
  findings.evidence.find(e => e.evidence_id === findings.verdict.driver_evidence_id)!.units = 'future unit';
  expect(renderBriefing(findings).sections.find(s => s.id === 'decision')!.messages?.plain).toBeUndefined();
});

it('retains old snapshots unchanged and distinguishes unknown-ID reading from writing', () => {
  const old = read('./golden/briefing-cherbourg-plymouth.json');
  expect(validateWriter(old)).toBe(true);
  expect(validateReader(old)).toBe(true);
  const future = structuredClone(cases[5].briefing);
  future.sections[0].messages.plain.push({ message_id: 'briefing.decision.future.v7', params: { future: true } });
  expect(validateWriter(future)).toBe(false);
  expect(validateReader(future)).toBe(true);
  expect(renderDecisionRegister(future.sections[0].messages.plain)).toBeNull();
  future.schema_version = 99;
  expect(validateReader(future)).toBe(false);
});

it.each([
  { value: Infinity }, { value: NaN }, { value: '28' }, { units: 'mph' },
  { valid_time: 'tomorrow' }, { valid_time: '2026-02-30T18:00:00Z' },
  { valid_time: '2026-07-12T18:00:00+02:00' }, { added: 'unexpected' },
])('rejects malformed numeric parameters %j', bad => {
  const ref = structuredClone(cases[5].briefing.sections[0].messages.plain[1]);
  Object.assign(ref.params, bad);
  expect(isDecisionMessageRef(ref)).toBe(false);
  expect(renderDecisionRegister([ref])).toBeNull();
  const doc = structuredClone(cases[5].briefing);
  doc.sections[0].messages.plain[1] = ref;
  expect(validateWriter(doc)).toBe(false);
});

it.each([{ exceed: -1 }, { exceed: 11 }, { total: 0 }, { exceed: 0.5 }])('rejects invalid counts at the producer validation layer %j', bad => {
  const section = structuredClone(cases[6].briefing.sections[0]);
  Object.assign(section.messages.plain[1].params, bad);
  expect(validDecisionMessageFields(section)).toBe(false);
});

it('rejects empty/missing registers and extra metadata properties', () => {
  for (const mutate of [
    (m: Record<string, unknown>) => { m.plain = []; },
    (m: Record<string, unknown>) => { delete m.pro; },
    (m: Record<string, unknown>) => { m.typo = []; },
  ]) {
    const doc = structuredClone(cases[5].briefing);
    mutate(doc.sections[0].messages);
    expect(validateWriter(doc)).toBe(false);
  }
});

it('rejects invalid producer metadata before writing any snapshot artifact', async () => {
  const findings = structuredClone(baseline);
  delete findings.identity_version;
  const briefing = renderBriefing(findings);
  const section = briefing.sections.find(s => s.id === 'decision')!;
  section.register_plain = 'Fallback contradicts the catalogue.';
  let writes = 0;
  await expect(writeSnapshot({ exists: async () => false, write: async () => { writes++; } }, findings, briefing, {
    route: read('../../config/routes/cherbourg-plymouth.json'),
  }, 0)).rejects.toThrow('decision message');
  expect(writes).toBe(0);
});
