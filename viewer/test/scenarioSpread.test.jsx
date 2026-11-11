import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import EvidenceSection from '../src/pages/briefing/EvidenceSection.jsx';
import EnsemblePlume from '../src/components/EnsemblePlume.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { scenarioSpreadSentences, wholeKnotsUp } from '../src/lib/scenarioSpreadSentence.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedPlume from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/plume.json';

const chart = vi.hoisted(() => ({ option: null }));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({
  default: (props) => { chart.option = props.option; return null; },
}));

const NBSP = '\u00A0'; // French typography puts a no-break space before ';'
const FORBIDDEN_EN = /probabilit|chance|likel|odds|%/i;
const FORBIDDEN_FR = /probabilit|chance|probable|cote|%/i;

/** Independent reading of the fixture: each member's maximum over the hours the findings audited. */
function expectedFromFixture(variable) {
  const key = variable === 'gust' ? 'gust_members' : 'wind_members';
  const maxima = [];
  for (const leg of savedFindings.legs) {
    const plumeLeg = savedPlume.legs.find((l) => l.leg_id === leg.leg_id);
    if (!plumeLeg) continue;
    const audited = new Set(leg.hours.map((h) => Date.parse(h.valid_time)));
    plumeLeg[key].forEach((series, m) => series.forEach((value, i) => {
      if (value !== null && audited.has(Date.parse(plumeLeg.times[i]))) maxima[m] = Math.max(maxima[m] ?? -Infinity, value);
    }));
  }
  const sorted = maxima.filter((v) => v !== undefined).sort((a, b) => a - b);
  const q = (p) => { const pos = (sorted.length - 1) * p; const lo = Math.floor(pos); const hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); };
  return { members: sorted.length, median: wholeKnotsUp(q(0.5)), p90: wholeKnotsUp(q(0.9)) };
}

const withoutEnsembleClaims = (findings) => ({ ...findings, evidence: findings.evidence.filter((e) => !(e.source_kind === 'ensemble' && e.member_fraction)) });

function setApp({ findings = structuredClone(savedFindings), plume = structuredClone(savedPlume) } = {}) {
  useApp.setState({ ...useApp.getInitialState(), findings, plume, selectedEvidenceId: null }, true);
}
beforeEach(() => { chart.option = null; setApp(); });

const spreadText = (container) => container.querySelector('[data-testid="scenario-spread"]')?.textContent ?? null;

it('shows the sentence beside the claim when scenarios exceed a limit', () => {
  const { container } = render(<EvidenceSection />);
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^\d+ of 51 forecast scenarios exceed your (wind|gust) limit$/);
  const wind = expectedFromFixture('wind');
  const gust = expectedFromFixture('gust');
  expect(wind.members).toBe(51);
  const paragraphs = [...container.querySelectorAll('[data-testid="scenario-spread"] p')].map((p) => p.textContent);
  expect(paragraphs).toEqual([
    `In half of the 51 emulated forecast scenarios the strongest wind at the points checked along your route stays at or under ${wind.median} kt; in nine out of ten, at or under ${wind.p90} kt.`,
    `In half of the 51 emulated forecast scenarios the strongest gust at the points checked along your route stays at or under ${gust.median} kt; in nine out of ten, at or under ${gust.p90} kt.`,
  ]);
  // the "N of M" count appears once: the new sentence does not repeat it
  expect(container.textContent.match(/(?<!\d)\d+ of 51(?!\d)/g)).toHaveLength(1);
});

it('shows the sentence in the calm case, where no scenario exceeds a limit and no plume is drawn', () => {
  setApp({ findings: withoutEnsembleClaims(savedFindings) });
  const { container } = render(<EvidenceSection />);
  expect(container.querySelector('[role="img"]')).toBeNull();
  expect(chart.option).toBeNull();
  expect(spreadText(container)).toMatch(/^In half of the 51 emulated forecast scenarios the strongest wind .* in nine out of ten, at or under \d+ kt\.In half of the 51 emulated forecast scenarios the strongest gust /);
  // the text around it no longer says "not available" next to a statement about the scenarios
  expect(container.textContent).toContain('No forecast scenario exceeds your wind or gust limit at the points checked, so there is no ensemble limit claim to show.');
  expect(container.textContent).not.toContain('No ensemble limit claim is available');
});

it('says "emulated" only for emulated scenarios: a named real ensemble gets the plain wording', () => {
  setApp({ plume: { ...structuredClone(savedPlume), model: 'gefs' } });
  const { container } = render(<EvidenceSection />);
  expect(spreadText(container)).toMatch(/^In half of the 51 forecast scenarios the strongest wind /);
  expect(spreadText(container)).not.toMatch(/emulated/);
});

it('names only the wind limit in the calm case when the plume carries no gust scenarios', () => {
  const windOnly = { ...savedPlume, legs: savedPlume.legs.map((leg) => ({ ...leg, gust_members: [] })) };
  setApp({ findings: withoutEnsembleClaims(savedFindings), plume: windOnly });
  const { container } = render(<EvidenceSection />);
  expect(container.textContent).toContain('No forecast scenario exceeds your wind limit at the points checked, so there is no ensemble limit claim to show.');
  expect(container.textContent).not.toContain('wind or gust limit');
  expect(spreadText(container)).not.toMatch(/strongest gust/);
});

it('renders nothing for the spread without a plume, and keeps the old calm text', () => {
  setApp({ findings: withoutEnsembleClaims(savedFindings), plume: null });
  const { container } = render(<EvidenceSection />);
  expect(spreadText(container)).toBeNull();
  expect(container.textContent).toContain('No ensemble limit claim is available for this check.');
  expect(container.textContent).not.toMatch(/forecast scenarios the strongest/);
});

it('renders nothing for the spread without a plume, in the exceeding case too', () => {
  setApp({ plume: null });
  const { container } = render(<EvidenceSection />);
  expect(spreadText(container)).toBeNull();
});

it('renders wind alone when the saved plume carries no gust series', () => {
  const plume = structuredClone(savedPlume);
  for (const leg of plume.legs) leg.gust_members = [];
  const { container } = render((setApp({ plume }), <EvidenceSection />));
  const paragraphs = container.querySelectorAll('[data-testid="scenario-spread"] p');
  expect(paragraphs).toHaveLength(1);
  expect(paragraphs[0].textContent).toContain('the strongest wind');
});

it('is built from the saved findings and plume alone: a plume of an older shape works unchanged', () => {
  // no field is read that the plume schema (version 1) does not already have
  const plume = structuredClone(savedPlume);
  for (const leg of plume.legs) { delete leg.deterministic; delete leg.deterministic_times; }
  const { container } = render((setApp({ plume }), <EvidenceSection />));
  expect(spreadText(container)).toContain('forecast scenarios the strongest wind');
});

it('writes the same sentence in French, with nd for knots, in both cases', async () => {
  for (const calm of [false, true]) {
    setApp({ findings: calm ? withoutEnsembleClaims(savedFindings) : structuredClone(savedFindings) });
    const { container, unmount } = render(<div id="root"><EvidenceSection /><LocalizedDocument language="fr" /></div>);
    const wind = expectedFromFixture('wind');
    const gust = expectedFromFixture('gust');
    await waitFor(() => expect(spreadText(container)).toContain('Dans la moitié des 51 scénarios de prévision'));
    expect([...container.querySelectorAll('[data-testid="scenario-spread"] p')].map((p) => p.textContent)).toEqual([
      `Dans la moitié des 51 scénarios de prévision simulés, le vent le plus fort aux points vérifiés le long de votre route reste à ${wind.median} nd ou moins${NBSP}; dans neuf scénarios sur dix, à ${wind.p90} nd ou moins.`,
      `Dans la moitié des 51 scénarios de prévision simulés, la rafale la plus forte aux points vérifiés le long de votre route reste à ${gust.median} nd ou moins${NBSP}; dans neuf scénarios sur dix, à ${gust.p90} nd ou moins.`,
    ]);
    expect(spreadText(container)).not.toMatch(FORBIDDEN_FR);
    if (calm) expect(container.textContent).toContain('Aucun scénario de prévision ne dépasse votre limite de vent ou de rafales aux points vérifiés');
    unmount();
  }
});

it('never uses probability language, in either language', () => {
  const sentences = scenarioSpreadSentences({
    wind: { median: 16.2, p90: 19, members: 31 },
    gust: { median: 21, p90: 27.7, members: 31 },
  });
  expect(sentences).toHaveLength(2);
  for (const { text } of sentences) expect(text).not.toMatch(FORBIDDEN_EN);
  const { container } = render(<EvidenceSection />);
  expect(spreadText(container)).not.toMatch(FORBIDDEN_EN);
  setApp({ findings: withoutEnsembleClaims(savedFindings) });
  const calm = render(<EvidenceSection />);
  expect(calm.container.textContent).not.toMatch(/likel|chance|odds/i);
});

it('writes whole knots rounded up, so "at or under" stays true', () => {
  expect(wholeKnotsUp(16)).toBe(16);
  expect(wholeKnotsUp(16.000000000000004)).toBe(16);
  expect(wholeKnotsUp(16.1)).toBe(17);
  expect(scenarioSpreadSentences({ wind: { median: 15.5, p90: 19.9, members: 31 }, gust: null })).toEqual([{
    variable: 'wind',
    text: 'In half of the 31 forecast scenarios the strongest wind at the points checked along your route stays at or under 16 kt; in nine out of ten, at or under 20 kt.',
  }]);
  expect(scenarioSpreadSentences(null)).toEqual([]);
});

it('keeps the plume chart on the same P10, median and P90 values as before the quantile moved', () => {
  // the quantile the chart used before it was shared with the engine, kept here as the reference
  const before = (sorted, q) => {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const leg = savedPlume.legs[0];
  const claim = savedFindings.evidence.find((e) => e.source_kind === 'ensemble' && e.member_fraction && e.leg_id === leg.leg_id) ?? savedFindings.evidence.find((e) => e.source_kind === 'ensemble');
  for (const variable of ['wind', 'gust']) {
    chart.option = null;
    const { unmount } = render(<EnsemblePlume evidence={{ ...claim, leg_id: leg.leg_id }} variable={variable} />);
    const members = variable === 'gust' ? leg.gust_members : leg.wind_members;
    const series = (name) => chart.option.series.find((s) => s.name === name).data;
    const expected = (q) => leg.times.map((t, i) => {
      const vals = members.map((s) => s[i]).filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      return [Date.parse(t), vals.length ? Math.round(before(vals, q) * 10) / 10 : null];
    });
    expect(series('P10')).toEqual(expected(0.1));
    expect(series('median (P50)')).toEqual(expected(0.5));
    expect(series('P90')).toEqual(expected(0.9));
    expect(series('P10').some(([, v]) => v !== null)).toBe(true);
    unmount();
  }
});
