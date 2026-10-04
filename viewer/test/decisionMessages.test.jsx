import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DECISION_MESSAGE_REGISTRY, EN_DECISION_MESSAGES, renderBriefing, renderDecisionMessage } from '@deepweather/engine';
import { FR_DECISION_MESSAGES, renderBriefingField } from '../src/lib/briefingMessages.js';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import BriefingMessage from '../src/components/BriefingMessage.jsx';
import AssessmentDetails from '../src/pages/briefing/AssessmentDetails.jsx';
import { useApp } from '../src/stores/appStore.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const cases = read('../../engine/test/fixtures/decision-messages.json').cases;
const findings = read('../../engine/test/golden/findings-cherbourg-plymouth.json');
const numeric = cases.find(c => c.name === 'numeric').briefing.sections[0];
afterEach(() => { cleanup(); useApp.setState({ language: 'en', briefing: null }); });

it('renders every emitted ID in EN/FR with the same parameter contracts', () => {
  expect(Object.keys(FR_DECISION_MESSAGES).sort()).toEqual(Object.keys(DECISION_MESSAGE_REGISTRY).sort());
  for (const { briefing } of cases) {
    const section = briefing.sections[0];
    for (const field of ['title', 'plain', 'pro']) {
      expect(renderBriefingField(1, section, field, 'en')).toEqual({ text: field === 'title' ? section.title : section[`register_${field}`], status: 'translated' });
      const fr = renderBriefingField(1, section, field, 'fr');
      expect(fr.status).toBe('translated');
      expect(fr.text).not.toMatch(/Forecast conditions|The main signal|Driver:|up to|just over/);
    }
  }
});

it('keeps verdict meaning equivalent for old persisted prose and new IDs', () => {
  for (const { briefing, name } of cases.slice(0, 5)) {
    const section = briefing.sections[0];
    const { messages: _messages, ...legacy } = section;
    for (const field of ['plain', 'pro']) {
      expect(renderBriefingField(1, legacy, field, 'fr')).toEqual({ text: renderBriefingField(1, section, field, 'fr').text, status: 'legacy' });
    }
    expect(section.messages.plain[0].message_id).toContain(name);
  }
  const old = read('../../engine/test/golden/briefing-cherbourg-plymouth.json').sections.find(s => s.id === 'decision');
  expect(renderBriefingField(1, old, 'plain', 'fr')).toEqual({ text: translateText(old.register_plain, 'fr'), status: 'legacy' });
});

it('a copy-only English change does not change French lookup, IDs, facts or decision identity', () => {
  const section = structuredClone(numeric);
  const original = renderBriefingField(1, section, 'plain', 'fr');
  section.register_plain = 'New English copy with the same meaning.';
  expect(renderBriefingField(1, section, 'plain', 'fr')).toEqual(original);
  const ref = section.messages.plain[0];
  const copy = { ...EN_DECISION_MESSAGES, [ref.message_id]: () => 'Reworded English assessment.' };
  expect(renderDecisionMessage(ref, copy)).toBe('Reworded English assessment.');
  expect(ref.message_id).toBe(numeric.messages.plain[0].message_id);
  const before = structuredClone(findings);
  renderBriefing(findings);
  expect(findings).toEqual(before);
});

it.each([
  m => m.plain.push({ message_id: 'briefing.decision.future.v9', params: {} }),
  m => { m.plain[1].params.units = 'mph'; },
  m => { delete m.plain[1].params.limit; },
  m => { m.plain[1].params.value = Infinity; },
  m => { m.plain = []; },
  m => { delete m.pro; },
  m => { m.typo = true; },
])('falls back to the complete original field when any message is unusable', mutate => {
  const section = structuredClone(numeric);
  mutate(section.messages);
  expect(renderBriefingField(1, section, 'plain', 'fr')).toEqual({ text: numeric.register_plain, status: 'fallback' });
});

it('missing French entries retain whole English; absent fallback and unknown versions are explicit', () => {
  const french = { ...FR_DECISION_MESSAGES };
  delete french['briefing.decision.numeric.plain.v1'];
  expect(renderBriefingField(1, numeric, 'plain', 'fr', french)).toEqual({ text: numeric.register_plain, status: 'fallback' });
  const broken = { messages: null };
  expect(renderBriefingField(1, broken, 'plain', 'fr').status).toBe('unavailable');
  expect(renderBriefingField(2, numeric, 'plain', 'fr').status).toBe('unsupported');
});

it.each([
  [0, 10, 'aucun des 10 scénarios de prévision ne dépasse'],
  [1, 1, 'le scénario de prévision dépasse'],
  [1, 10, '1 scénario sur 10 dépasse'],
  [3, 10, '3 scénarios sur 10 dépassent'],
  [10, 10, 'les 10 scénarios de prévision dépassent'],
])('keeps raw counts and grammar for %d of %d', (exceed, total, phrase) => {
  const ref = { message_id: 'briefing.decision.ensemble.plain.v1', params: { exceed, total, limit: 28, valid_time: '2026-07-12T18:00:00Z', leg_name: 'L1' } };
  const text = renderDecisionMessage(ref, FR_DECISION_MESSAGES);
  expect(text).toContain(phrase);
  expect(text).not.toMatch(/probabilité|%/);
});

it.each([['kt', 'nd'], ['m', 'm'], ['nm', 'nm'], ['J/kg', 'J/kg']])('formats %s without converting the measured values', (units, frenchUnit) => {
  const section = structuredClone(numeric);
  section.messages.plain[1].params.units = units;
  section.messages.pro[1].params.units = units;
  expect(renderBriefingField(1, section, 'plain', 'fr').text).toContain(`28 ${frenchUnit}`);
  expect(renderBriefingField(1, section, 'pro', 'fr').text).toContain(`28.1 ${frenchUnit}`);
});

it('escapes literal parameter text and owns repeated EN/FR/EN and DOM mutation handling', async () => {
  useApp.setState({ language: 'en' });
  const view = language => <><LocalizedDocument language={language} /><div data-testid="owned" data-i18n-owned="message" title="Wind limit Jul"><BriefingMessage section={numeric} field="plain" /><b title="Wind limit">Wind limit Jul</b></div><p>Wind</p></>;
  const { rerender } = render(view('en'));
  expect(screen.getByTestId('owned')).toHaveTextContent('gusts just over your 28 kt limit');
  for (const language of ['fr', 'en', 'fr', 'en']) {
    await act(async () => { useApp.setState({ language }); rerender(view(language)); });
    const owned = screen.getByTestId('owned');
    expect(owned).toHaveTextContent('Wind limit <img src=x onerror=alert(1)> Jul');
    expect(owned.querySelector('img')).toBeNull();
    expect(owned.getAttribute('title')).toBe('Wind limit Jul');
    expect(owned.querySelector('[data-message-status]').dataset.messageStatus).toBe('translated');
    expect(owned).toHaveTextContent(language === 'fr' ? 'rafales juste au-dessus' : 'gusts just over');
    expect(screen.getByText(language === 'fr' ? 'Vent' : 'Wind')).toBeInTheDocument();
  }
  await act(async () => { useApp.setState({ language: 'fr' }); rerender(view('fr')); });
  await act(async () => {
    const nested = screen.getByTestId('owned').querySelector('b');
    nested.firstChild.data = 'Loading… Wind limit Jul';
    nested.setAttribute('title', 'Loading…');
    nested.appendChild(document.createTextNode(' Wind limit'));
  });
  expect(screen.getByTestId('owned').querySelector('b')).toHaveTextContent('Loading… Wind limit Jul Wind limit');
  expect(screen.getByTestId('owned').querySelector('b')).toHaveAttribute('title', 'Loading…');
});

it('shows a bilingual fallback label and never fragment-translates saved English', async () => {
  const section = structuredClone(numeric);
  section.messages.plain[1].message_id = 'future';
  useApp.setState({ language: 'fr' });
  render(<><LocalizedDocument language="fr" /><BriefingMessage section={section} field="plain" /></>);
  expect(screen.getByRole('status')).toHaveTextContent('Texte original en anglais');
  expect(screen.getByRole('status').parentElement).toHaveTextContent(numeric.register_plain);
});

it('connects actual assessment titles and both registers while other sections remain legacy', async () => {
  const data = renderBriefing(findings);
  useApp.setState({ briefing: data, language: 'fr' });
  render(<><LocalizedDocument language="fr" /><AssessmentDetails sections={data.sections} findings={findings} /></>);
  const titles = document.querySelectorAll('[data-message-field="title"]');
  expect(titles).toHaveLength(1);
  expect(titles[0]).toHaveAttribute('data-message-status', 'translated');
  expect(document.querySelector('[data-message-field="pro"]')).toHaveTextContent('Facteur déterminant');
  expect(document.querySelectorAll('[data-message-field]')).toHaveLength(3);
});
