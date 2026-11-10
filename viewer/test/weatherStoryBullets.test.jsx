import { render } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import WeatherStoryCard from '../src/pages/briefing/WeatherStoryCard.jsx';
import { fmtTextTime } from '../src/lib/format.js';
import { useApp } from '../src/stores/appStore.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';

let findings;
beforeEach(() => {
  findings = structuredClone(savedFindings);
  useApp.setState({ ...useApp.getInitialState(), findings, briefing: savedBriefing, page: 'briefing' }, true);
});

const bulletList = (container) => container.querySelector('ul');
/** Visible sentence text: the glossary tooltip sits inside the Term span. */
const visibleText = (element) => {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove());
  return copy.textContent;
};

it('keeps each story bullet as two flex children: the marker and one inline sentence', () => {
  const { container } = render(<WeatherStoryCard findings={findings} sections={savedBriefing.sections} />);
  const items = [...bulletList(container).children];
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item.children).toHaveLength(2);
    expect(item.children[0]).toHaveAttribute('aria-hidden');
  }
  const strongest = items.find((item) => item.textContent.includes('Strongest'));
  const sentence = strongest.children[1];
  // text, leg and the glossary button all live in the one sentence element
  // hours while the boat is on leg 6 only (22:00-05:00 UTC); the 06:00 sample after the 05:37 slow exit is left out
  expect(visibleText(sentence)).toBe('Strongest near Plymouth breakwater (leg 6): wind 28 kt, gusts 38 kt, waves 2.6 m, hourly maximum of the emulated scenario forecast while you are on this leg.');
  expect(sentence.querySelectorAll('[class*="text-[11px]"], [class*="text-[10px]"]')).toHaveLength(0);
  expect(sentence.querySelector('button')).toHaveTextContent('gusts');
});

it('names the wind-over-tide leg by place then number, never by the raw L-id', () => {
  findings.events.unshift({ kind: 'wind_against_current', leg_id: 'L2', window: { from: '2026-07-20T19:38:00Z', to: '2026-07-20T19:38:00Z' } });
  const { container } = render(<WeatherStoryCard findings={findings} sections={savedBriefing.sections} />);
  const line = [...bulletList(container).children].find((item) => item.textContent.includes('Wind over tide'));
  expect(visibleText(line)).not.toMatch(/\bL\d\b/);
  expect(visibleText(line)).toContain('near NW of Cap de la Hague (leg 2)');
});

it('states wind-over-tide time in the header zone, without a UTC suffix', () => {
  findings.events.unshift({ kind: 'wind_against_current', leg_id: 'L2', window: { from: '2026-07-20T19:38:00Z', to: '2026-07-20T19:38:00Z' } });
  const { container } = render(<WeatherStoryCard findings={findings} sections={savedBriefing.sections} />);
  const line = [...bulletList(container).children].find((item) => item.textContent.includes('Wind over tide'));
  expect(visibleText(line)).toContain(`around ${fmtTextTime('2026-07-20T19:38:00Z')}.`);
  expect(visibleText(line)).not.toMatch(/UTC/);
});

it('shows the note for the leg the verdict names, not the first leg in route order', () => {
  const { container } = render(<WeatherStoryCard findings={findings} sections={savedBriefing.sections} />);
  const note = container.querySelector('[data-testid="leg-note"]');
  // the verdict sentence governs on leg 3; leg 1's "Gusts up to 22 kt" event is not shown as the fact
  expect(note.textContent).toBe('Winds just over your 18 kt limit while the low crosses NW of Cap de la Hague → Casquets TSS crossing.');
  expect(container.textContent).not.toMatch(/Gusts up to 22 kt/);
  // the system is a section subheading, not a competing headline
  const heading = container.querySelector('h2');
  expect(heading.textContent).toBe('A low-pressure system crosses your passage window');
  expect(heading.className).not.toMatch(/text-\[(2\d|3\d)px\]/);
});
