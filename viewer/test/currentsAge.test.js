import { describe, expect, it } from 'vitest';
import { STALE_CURRENTS_MS, currentsFetchedLine, gridFetchedAt } from '../src/lib/currentsAge.js';
import { fmtLocalTime } from '../src/lib/format.js';
import { translateText } from '../src/i18n.js';
import { routingCurrentSummary } from '../src/lib/routingInputs.js';

const FETCHED = '2026-11-14T03:22:00Z';
const at = (ms) => Date.parse(FETCHED) + ms;
const H = 3600_000;
const when = fmtLocalTime(FETCHED);

describe('gridFetchedAt', () => {
  it('reads the source fetch time first, then the grid generation time', () => {
    expect(gridFetchedAt({ source: { fetched_at: FETCHED }, generated_at: '2026-11-14T03:00:00Z' })).toBe(FETCHED);
    expect(gridFetchedAt({ source: { mode: 'live' }, generated_at: '2026-11-14T03:00:00Z' })).toBe('2026-11-14T03:00:00Z');
    expect(gridFetchedAt({ generated_at: '2026-11-14T03:00:00Z' })).toBe('2026-11-14T03:00:00Z');
  });

  it('falls back from a fetch time that is not a time, and gives nothing when neither reads', () => {
    expect(gridFetchedAt({ source: { fetched_at: 'not a time' }, generated_at: '2026-11-14T03:00:00Z' })).toBe('2026-11-14T03:00:00Z');
    expect(gridFetchedAt({ source: { fetched_at: 12 }, generated_at: 'soon' })).toBeNull();
    expect(gridFetchedAt({ source: {} })).toBeNull();
    expect(gridFetchedAt(undefined)).toBeNull();
  });
});

describe('currentsFetchedLine', () => {
  it('states the fetch time in local time and the age in hours, as a plain line', () => {
    expect(currentsFetchedLine(FETCHED, at(2 * H))).toEqual({ stale: false, text: `Currents fetched ${when} local time, 2 h ago` });
    expect(currentsFetchedLine(FETCHED, at(20 * 60_000)).text).toBe(`Currents fetched ${when} local time, under 1 h ago`);
  });

  it('stays a plain line at exactly 24 h and just under, and becomes a caution just over', () => {
    expect(STALE_CURRENTS_MS).toBe(24 * H);
    expect(currentsFetchedLine(FETCHED, at(24 * H - 1))).toMatchObject({ stale: false });
    expect(currentsFetchedLine(FETCHED, at(24 * H))).toMatchObject({ stale: false });
    expect(currentsFetchedLine(FETCHED, at(24 * H + 1))).toMatchObject({ stale: true });
  });

  it('counts hours below 48 h and days from there on, in the caution', () => {
    expect(currentsFetchedLine(FETCHED, at(30 * H))).toEqual({ stale: true, text: `These currents were fetched ${when} local time, 30 h ago.` });
    expect(currentsFetchedLine(FETCHED, at(47 * H)).text).toContain(', 47 h ago.');
    expect(currentsFetchedLine(FETCHED, at(48 * H)).text).toContain(', 2 days ago.');
    expect(currentsFetchedLine(FETCHED, at(5 * 24 * H)).text).toBe(`These currents were fetched ${when} local time, 5 days ago.`);
  });

  it('claims no cause for an old grid and uses none of the words the planner avoids', () => {
    const { text } = currentsFetchedLine(FETCHED, at(72 * H));
    expect(text).not.toMatch(/no currents|newer|failed|tidal stream|\bbest\b|probab|\bGO\b|deepweather/i);
  });

  it('says nothing without a readable fetch time or clock, and never invents one', () => {
    for (const bad of [null, undefined, '', 'yesterday', 20261114]) expect(currentsFetchedLine(bad, at(H))).toBeNull();
    expect(currentsFetchedLine(FETCHED, Number.NaN)).toBeNull();
  });

  it('reads a fetch time in the future (clock skew) as under 1 h, never as a negative age', () => {
    expect(currentsFetchedLine(FETCHED, at(-3 * H)).text).toBe(`Currents fetched ${when} local time, under 1 h ago`);
  });

  it('renders in French with the day and month in French and the right plural', () => {
    const fr = (ms) => translateText(currentsFetchedLine(FETCHED, at(ms)).text, 'fr');
    // TZ is pinned to Europe/Paris by vitest.config.js: 03:22Z is 04:22 on Sat 14 Nov.
    expect(fr(2 * H)).toBe('Courants récupérés le sam. 14 nov. 04:22 (heure locale), il y a 2 h');
    expect(fr(20 * 60_000)).toBe('Courants récupérés le sam. 14 nov. 04:22 (heure locale), il y a moins d’1 h');
    expect(fr(30 * H)).toBe('Ces courants ont été récupérés le sam. 14 nov. 04:22 (heure locale), il y a 30 h.');
    expect(fr(48 * H)).toBe('Ces courants ont été récupérés le sam. 14 nov. 04:22 (heure locale), il y a 2 jours.');
    expect(fr(5 * 24 * H)).toContain('il y a 5 jours.');
  });
});

describe('routingCurrentSummary fetch time', () => {
  const prepared = (grid) => routingCurrentSummary({ grid, provenance: { current_source: 'prepared', model: 'cmems_mod_ibi_phy_anfc' } });
  it('carries the prepared grid’s own fetch time, or null when it records none', () => {
    expect(prepared({ source: { mode: 'live', fetched_at: FETCHED } }).fetchedAt).toBe(FETCHED);
    expect(prepared({ source: { mode: 'live' }, generated_at: '2026-11-14T03:00:00Z' }).fetchedAt).toBe('2026-11-14T03:00:00Z');
    expect(prepared({ source: { mode: 'live' } }).fetchedAt).toBeNull();
  });

  it('does not add one for tile currents', () => {
    const summary = routingCurrentSummary({ grid: { source: { fetched_at: FETCHED } }, provenance: { current_source: 'tiles' } });
    expect(summary).not.toHaveProperty('fetchedAt');
  });
});
