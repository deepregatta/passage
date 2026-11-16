import { readdirSync, readFileSync, statSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { stripInvisibleControls } from '@deepweather/engine';
import { placeLabel } from '../src/lib/format.js';
import AssessmentDetails from '../src/pages/briefing/AssessmentDetails.jsx';
import BriefingMessage from '../src/components/BriefingMessage.jsx';
import ModelsUsed from '../src/components/ModelsUsed.jsx';
import { renderBriefingField } from '../src/lib/briefingMessages.js';
import { useApp } from '../src/stores/appStore.js';

// A saved or imported check carries free text (register_plain, place names) that the page shows
// as is. A bidirectional override in it would reverse what follows on screen (2026-11-16).
const RLO = '\u202E';
const PDF = '\u202C';
afterEach(() => { cleanup(); useApp.setState({ language: 'en', briefing: null, findings: null }); });

it('shows a place label without the bidirectional controls a check file carried', () => {
  expect(placeLabel(`Gusts near wp3${RLO} rof tuo kooL${PDF}.`)).toBe('Gusts near waypoint 3 rof tuo kooL.');
  expect(placeLabel(`Off\u2066 Cherbourg\u2069 at\u200F dawn\u0007`)).toBe('Off Cherbourg at dawn');
  expect(placeLabel(42)).toBe(42);
});

it('shows a reasoning section without a U+202E carried in its register_plain', () => {
  const section = { id: 'conditions', title: 'Conditions', register_plain: `Wind ${RLO}gnisae${PDF} later in the day.`, register_pro: 'Wind easing.', evidence_ids: [] };
  render(<AssessmentDetails sections={[section]} findings={null} />);
  const shown = screen.getByText(/later in the day/);
  expect(shown.textContent).toBe('Wind gnisae later in the day.');
  expect(shown.textContent).not.toContain(RLO);
});

const C1 = '\u0085';
// the controls under test, written as escapes; an independent class (not the engine's own function) so the check cannot pass by sharing a bug
const BAD = new RegExp('[' + ['\u0000-\u0008', '\u000E-\u001F', '\u007F-\u009F', '\u061C', '\u200E\u200F', '\u202A-\u202E', '\u2066-\u2069'].join('') + ']');
// a variable, not a literal: Vite rewrites new URL('literal', import.meta.url) into a served-asset URL
const DECISION_CASES = '../../engine/test/fixtures/decision-messages.json';
const withLeg = (leg) => {
  const cases = JSON.parse(readFileSync(new URL(DECISION_CASES, import.meta.url), 'utf8')).cases;
  const section = structuredClone(cases.find((item) => item.name === 'numeric').briefing.sections[0]);
  for (const field of ['plain', 'pro']) for (const ref of section.messages[field]) if ('leg_name' in ref.params) ref.params.leg_name = leg;
  return section;
};

// The message registry substitutes a check's free-text leg_name into app-written sentences, so a
// control in it reverses the app's own words and the time that follow (2026-11-16).
it.each([['en', RLO], ['en', C1], ['fr', RLO], ['fr', C1]])('shows a decision message without a control carried in leg_name (%s, %j)', (language, control) => {
  const clean = withLeg('Brest ');
  const dirty = withLeg(`Brest ${control}`);
  useApp.setState({ language });
  for (const field of ['title', 'plain', 'pro']) {
    const expected = renderBriefingField(1, clean, field, language).text;
    const { container } = render(<BriefingMessage section={dirty} field={field} version={1} />);
    const shown = container.querySelector('[data-message-field]').textContent;
    expect(shown).not.toMatch(BAD);
    expect(shown).toBe(expected);
    cleanup();
  }
  expect(renderBriefingField(1, dirty, 'plain', language).text).toContain(control);
});

it('shows a professional-register line and a section title without controls', () => {
  const section = { id: 'conditions', title: `Cond${RLO}itions${C1}`, register_plain: 'Plain.', register_pro: `Wind ${RLO}easing${PDF} ${C1}later.`, evidence_ids: [] };
  render(<AssessmentDetails sections={[section]} findings={null} />);
  const titles = screen.getAllByText('Conditions');
  expect(titles.length).toBe(2);
  expect(screen.getByText('Wind easing later.')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(BAD);
});

it('shows the not-assessed coverage detail without controls', () => {
  const findings = { legs: [], coverage: [{ capability: 'warnings', status: 'not_assessed', detail: `gale ${RLO}warnings${PDF} ${C1}feed`, evidence_ids: [] }] };
  const section = { id: 'unsupported', title: 'Not assessed by this analysis', register_plain: 'x', register_pro: 'x', evidence_ids: [] };
  render(<AssessmentDetails sections={[section]} findings={findings} />);
  expect(screen.getByText(/^Not assessed:/).textContent).toContain('Not assessed: gale warnings feed.');
  expect(document.body.textContent).not.toMatch(BAD);
});

it('shows the recorded coverage detail in Models used without controls', () => {
  const findings = { legs: [], inputs: {}, coverage: [{ capability: 'wind', status: 'partially_assessed', detail: `wind ${RLO}for 1${PDF}/2 ${C1}hours`, route_hours: { known: 1, total: 2 }, evidence_ids: [] }] };
  useApp.setState({ findings });
  render(<ModelsUsed />);
  expect(screen.getByText('wind for 1/2 hours')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(BAD);
});

// Every committed fixture and golden: the strings a check carries, register_plain sentences
// among them, must come back byte-identical, so the strip changes nothing legitimate.
const CORPUS = ['../../engine/test/fixtures/', '../../engine/test/golden/', './fixtures/', '../../analysis/tests/fixtures/'];
const jsonFiles = (dir) => readdirSync(dir).flatMap((entry) => {
  const url = new URL(entry, dir);
  if (statSync(url).isDirectory()) return jsonFiles(new URL(`${entry}/`, dir));
  return /\.jsonl?$/.test(entry) ? [url] : [];
});
const strings = (value, out) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out); }
  return out;
};

it('leaves every string in the committed fixtures and goldens byte-identical', () => {
  let files = 0;
  let sentences = 0;
  for (const dir of CORPUS) {
    for (const url of jsonFiles(new URL(dir, import.meta.url))) {
      const text = readFileSync(url, 'utf8');
      const docs = url.pathname.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [JSON.parse(text)];
      files += 1;
      for (const value of strings(docs, [])) {
        expect(stripInvisibleControls(value), `${url.pathname}: ${JSON.stringify(value).slice(0, 80)}`).toBe(value);
      }
      sentences += JSON.stringify(docs).split('"register_plain"').length - 1;
    }
  }
  expect(files).toBeGreaterThan(100);
  expect(sentences).toBeGreaterThan(50);
});

it('leaves every decision message of the committed demo checks and message cases byte-identical, in both languages', () => {
  const sections = [];
  for (const dir of ['./fixtures/', DECISION_CASES]) {
    for (const url of dir === DECISION_CASES ? [new URL(DECISION_CASES, import.meta.url)] : jsonFiles(new URL(dir, import.meta.url))) {
      const doc = JSON.parse(readFileSync(url, 'utf8'));
      if (Array.isArray(doc.sections)) sections.push(...doc.sections);
      if (Array.isArray(doc.cases)) sections.push(...doc.cases.flatMap((item) => item.briefing?.sections ?? []));
    }
  }
  let rendered = 0;
  for (const section of sections.filter((item) => item.messages)) {
    for (const field of ['title', 'plain', 'pro']) for (const language of ['en', 'fr']) {
      const { text } = renderBriefingField(1, section, field, language);
      expect(stripInvisibleControls(text), `${section.id} ${field} ${language}`).toBe(text);
      rendered += 1;
    }
  }
  expect(rendered).toBeGreaterThan(20);
});
