import { expect, it } from 'vitest';
import { ruleLabels } from '../src/lib/changeStory.js';
import { translateText } from '../src/i18n.js';
import { STATUS_HEX, VERDICT } from '../src/lib/format.js';
import { evidenceById } from '../src/lib/evidenceSelectors.js';
import { useApp } from '../src/stores/appStore.js';
import tailwind from '../tailwind.config.js';

it('preserves the complete rule vocabulary in English and French', () => {
  expect(Object.entries(ruleLabels).map(([id, label]) => [id, label, translateText(label, 'fr')])).toMatchSnapshot();
  const phrases = ['sustained wind vs your limit', 'gusts vs your limit', 'wind scenarios over your limit',
    'gust scenarios over your limit', 'wave height vs your limit', 'cross-sea', 'steep waves',
    'wind against swell', 'wind against current', 'tidal gate fit', 'official marine warning',
    'model disagreement', 'thunderstorm potential', 'visibility'];
  expect(phrases.map(phrase => translateText(`New signal: ${phrase} near waypoint 2 around Mon 20 Jul 23:00 UTC.`, 'fr'))).toMatchSnapshot();
});

it('preserves theme colors and verdict/status metadata', () => {
  expect({ colors: tailwind.theme.extend.colors, VERDICT, STATUS_HEX }).toMatchSnapshot();
});

it('returns the first matching evidence object and null for missing ids in both entry points', () => {
  const first = { evidence_id: 'a', value: 1 };
  const findings = { evidence: [first, { evidence_id: 'a', value: 2 }] };
  useApp.setState({ findings });
  expect(evidenceById(findings, 'a')).toBe(first);
  expect(useApp.getState().evidenceById('a')).toBe(first);
  expect(evidenceById(findings, 'missing')).toBeNull();
  expect(useApp.getState().evidenceById('missing')).toBeNull();
  useApp.setState({ findings: null });
  expect(evidenceById(null, 'a')).toBeNull();
  expect(useApp.getState().evidenceById('a')).toBeNull();
});
