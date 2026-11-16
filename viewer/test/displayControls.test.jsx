import { readdirSync, readFileSync, statSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { stripInvisibleControls } from '@deepweather/engine';
import { placeLabel } from '../src/lib/format.js';
import AssessmentDetails from '../src/pages/briefing/AssessmentDetails.jsx';
import { useApp } from '../src/stores/appStore.js';

// A saved or imported check carries free text (register_plain, place names) that the page shows
// as is. A bidirectional override in it would reverse what follows on screen (2026-11-16).
const RLO = '\u202E';
const PDF = '\u202C';
afterEach(() => { cleanup(); useApp.setState({ language: 'en', briefing: null }); });

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
