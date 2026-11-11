import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DECISION_MESSAGE_REGISTRY, EN_DECISION_MESSAGES, renderBriefing, renderDecisionMessage } from '@deepweather/engine';
import { FR_DECISION_MESSAGES, renderBriefingField } from '../src/lib/briefingMessages.js';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import BriefingMessage from '../src/components/BriefingMessage.jsx';
import AssessmentDetails from '../src/pages/briefing/AssessmentDetails.jsx';
import { driverSignalText } from '../src/pages/briefing/verdictSentence.js';
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
  // once as the section heading, once in the single professional-register disclosure
  expect(titles).toHaveLength(2);
  for (const title of titles) expect(title).toHaveAttribute('data-message-status', 'translated');
  // the verdict driver in page labels, named as the strongest single signal, never with raw codes
  const pro = document.querySelector('[data-message-field="pro"]');
  expect(pro).toHaveAttribute('data-message-status', 'translated');
  expect(pro).toHaveTextContent(/Signal individuel le plus fort : .+ \(tronçon \d+\) vers /);
  expect(pro.textContent).not.toMatch(/Facteur déterminant|\b[WSTCAV]-[A-Z]+-\d\d\b|\bL\d+\b|\d{4}-\d\d-\d\dT/);
  expect(document.querySelectorAll('[data-message-field]')).toHaveLength(4);
});

it('the plain "why" drops the scenario-count signal for new and old checks, and keeps everything else', () => {
  const opts = { omitScenarioCount: true };
  for (const name of ['ensemble-0-10', 'ensemble-1-1', 'ensemble-3-10']) {
    const section = cases.find(c => c.name === name).briefing.sections[0];
    const { messages: _messages, ...legacy } = section;
    for (const language of ['en', 'fr']) {
      const current = renderBriefingField(1, section, 'plain', language, undefined, opts);
      const old = renderBriefingField(1, legacy, 'plain', language, undefined, opts);
      expect(current.status).toBe('translated');
      expect(old.status).toBe('legacy');
      for (const { text } of [current, old]) {
        expect(text).not.toMatch(/main signal|Signal principal|forecast scenarios|scénarios/i);
        expect(text).toMatch(language === 'fr' ? /^Les conditions prévues dépassent/ : /^Forecast conditions go beyond the limits/);
      }
    }
    // the professional register keeps its driver line
    expect(renderBriefingField(1, section, 'pro', 'en', undefined, opts).text).toMatch(/Driver:/);
  }
  // a numeric signal carries no count: kept
  expect(renderBriefingField(1, numeric, 'plain', 'en', undefined, opts).text).toBe(numeric.register_plain);
  // the bundled example (saved before message IDs) loses only its "all 51 ... exceed" sentence
  const example = read('./fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json').sections.find(s => s.id === 'decision');
  expect(renderBriefingField(1, example, 'plain', 'en', undefined, opts)).toEqual({
    text: 'An official marine warning covers part of your route. That takes precedence over everything below.', status: 'legacy',
  });
  expect(renderBriefingField(1, example, 'plain', 'fr', undefined, opts).text)
    .toBe('Une alerte marine officielle couvre une partie de votre route. Elle prévaut sur tout ce qui suit.');
});

it('restates the professional verdict driver with page labels for new and old checks, or leaves it alone', () => {
  const example = read('./fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json').sections.find(s => s.id === 'decision');
  const exampleFindings = read('./fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json');
  const describeDriver = (params, language) => driverSignalText(exampleFindings, params, language);
  const en = renderBriefingField(1, example, 'pro', 'en', undefined, { describeDriver });
  expect(en.status).toBe('legacy');
  expect(en.text).toMatch(/^Authority override active: an official bulletin covers route zones during the passage window\. Strongest single signal: wind scenarios over your limit near .+ \(leg 4\) around \w{3} \d+ \w{3} \d\d:\d\d, 51 of 51 ensemble members above 18 kt\.$/);
  const fr = renderBriefingField(1, example, 'pro', 'fr', undefined, { describeDriver });
  expect(fr.text).toMatch(/^Priorité active à l’autorité : .+\. Signal individuel le plus fort : scénarios de vent au-dessus de votre limite près de .+ \(tronçon 4\) vers .+, 51 membres d’ensemble sur 51 au-dessus de 18 nd\.$/);
  for (const { text } of [en, fr]) expect(text).not.toMatch(/Driver|Facteur|W-SUST|\bL4\b|2026-07-20T/);
  // new checks: the driver message ref is restated, the rest stays catalogue text
  const numericFindings = { legs: [{ leg_id: numeric.messages.pro[1].params.leg_id, name: 'A → Off Dover, UK' }] };
  const restated = renderBriefingField(1, numeric, 'pro', 'en', undefined, { describeDriver: (p, l) => driverSignalText(numericFindings, p, l) });
  expect(restated.status).toBe('translated');
  expect(restated.text).toMatch(/Strongest single signal: .+ near Off Dover \(leg \d+\) around .+ against your declared [\d.]+ \w+\.$/);
  // without a describer, or when it cannot read the parameters, the stored sentence is unchanged
  expect(renderBriefingField(1, example, 'pro', 'en').text).toBe(example.register_pro);
  expect(renderBriefingField(1, example, 'pro', 'en', undefined, { describeDriver: () => null }).text).toBe(example.register_pro);
  expect(renderBriefingField(1, numeric, 'pro', 'en', undefined, { describeDriver: () => null }).text).toBe(numeric.register_pro);
});

it('the plain "why" names the main signal by place and header-zone time, for new and old checks', () => {
  const demo = read('./fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json');
  const localize = {
    departure: demo.departure_utc,
    leg: (name, language) => (name === 'Casquets TSS crossing → Mid-Channel' ? (language === 'fr' ? 'près de Mid-Channel (tronçon 4)' : 'near Mid-Channel (leg 4)') : null),
    time: (iso, language) => `${language}@${iso.slice(11, 16)}`,
  };
  const signal = { message_id: 'briefing.decision.numeric.plain.v1', params: { leg_name: 'Casquets TSS crossing → Mid-Channel', valid_time: '2026-07-20T21:00:00Z', value: 22, limit: 18, units: 'kt', hazard: 'winds', relation: 'over', style: 'up_to' } };
  const section = structuredClone(numeric);
  section.messages.plain = [section.messages.plain[0], signal];
  section.register_plain = renderBriefingField(1, section, 'plain', 'en').text;
  expect(section.register_plain).toMatch(/ on Casquets TSS crossing → Mid-Channel around Mon 20 Jul 21:00 UTC\.$/);
  // new checks: the catalogue sentence, with its leg and time restated
  expect(renderBriefingField(1, section, 'plain', 'en', undefined, { localize }).text)
    .toMatch(/The main signal: winds up to 22 kt, over your 18 kt limit near Mid-Channel \(leg 4\) around en@21:00\.$/);
  expect(renderBriefingField(1, section, 'plain', 'fr', undefined, { localize }).text)
    .toMatch(/ près de Mid-Channel \(tronçon 4\) vers fr@21:00\.$/);
  // a leg the page cannot name keeps its name, with the time still in the header zone
  const unknown = renderBriefingField(1, numeric, 'plain', 'en', undefined, { localize });
  expect(unknown.text).toMatch(/ on Wind limit <img src=x onerror=alert\(1\)> Jul around en@18:00\.$/);
  // old checks (no message IDs): the saved sentence, the year read from the weekday
  const { messages: _messages, ...legacy } = section;
  expect(renderBriefingField(1, legacy, 'plain', 'en', undefined, { localize }))
    .toEqual({ text: expect.stringMatching(/ near Mid-Channel \(leg 4\) around en@21:00\.$/), status: 'legacy' });
  // without `localize` nothing changes
  expect(renderBriefingField(1, section, 'plain', 'en')).toEqual({ text: section.register_plain, status: 'translated' });
  expect(renderBriefingField(1, legacy, 'plain', 'en').text).toBe(section.register_plain);
});

it('renders the main signal in the header zone and by place in the page, not in UTC', () => {
  const demo = read('./fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json');
  const section = structuredClone(numeric);
  section.messages.plain = [section.messages.plain[0], { message_id: 'briefing.decision.numeric.plain.v1', params: { leg_name: 'Casquets TSS crossing → Mid-Channel', valid_time: '2026-07-20T21:00:00Z', value: 22, limit: 18, units: 'kt', hazard: 'winds', relation: 'over', style: 'up_to' } }];
  section.register_plain = renderBriefingField(1, section, 'plain', 'en').text;
  useApp.setState({ language: 'en', findings: demo });
  const { container, rerender } = render(<BriefingMessage section={section} field="plain" />);
  // unit tests run in Europe/Paris: 21:00 UTC is 23:00, as the verdict sentence reads it
  expect(container).toHaveTextContent(/over your 18 kt limit near Mid-Channel \(leg 4\) around Mon 20 Jul 23:00\.$/);
  expect(container.textContent).not.toMatch(/UTC|\bL4\b/);
  act(() => useApp.setState({ language: 'fr' }));
  rerender(<BriefingMessage section={section} field="plain" />);
  expect(container.textContent).toMatch(/ vers lun\. 20 juil\. 23:00\.$/);
  expect(container.textContent).not.toMatch(/UTC|\bL4\b/);
});

it('keeps the whole original field when a message cannot be read, and legs without a place in their name as recorded', () => {
  const localize = { departure: '2026-07-20T06:00:00Z', leg: () => 'near SOMEWHERE (leg 1)', time: () => 'LOCAL' };
  const section = structuredClone(numeric);
  section.messages.plain.push({ message_id: 'future.message.v9', params: {} });
  // the fallback is the stored field, UTC and all, never a restated one
  expect(renderBriefingField(1, section, 'plain', 'en', undefined, { localize })).toEqual({ text: numeric.register_plain, status: 'fallback' });
});
