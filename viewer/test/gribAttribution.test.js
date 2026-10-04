import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createAnalytics } from '../src/lib/analyticsClient.js';

const utm = { utm_source: 'bluesky', utm_medium: 'social', utm_campaign: 'water-remembers-2026q4', utm_content: 'grib-en' };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

it.each(['/#plan/grib?area=50,51,-2,-1', '/grib?area=50,51,-2,-1', '/fr/grib?area=50,51,-2,-1'])(
  'retains the session tuple and QA contract across download and next steps from %s', (path) => {
    const url = new URL(path, 'https://passage.deepregatta.com');
    for (const [key, value] of Object.entries(utm)) url.searchParams.set(key, value);
    url.searchParams.set('dr_traffic', 'qa');
    vi.stubGlobal('window', { location: url, localStorage, sessionStorage });
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const analytics = createAnalytics({ product: 'passage', collector: 'https://oscar.deepregatta.com/api/event' });
    analytics.track('page_view', { page: 'grib' });
    const sessionId = sessionStorage.getItem('dr.sid');
    const tuple = sessionStorage.getItem('dr.utm.session');
    // Internal navigation/reload can remove the URL tuple; session attribution survives.
    window.location = new URL('https://passage.deepregatta.com/fr/#plan');
    analytics.track('grib_export', { datasets: 'wind-gfs', window: '1d', size_bucket: '0-1MB' });
    analytics.track('grib_next_step', { target: 'plan' });
    analytics.track('grib_next_step', { target: 'fastnet2025' });
    expect(sessionStorage.getItem('dr.utm.session')).toBe(tuple);
    const events = fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(events.filter((event) => event.event === 'session_start')).toHaveLength(1);
    for (const event of events) {
      expect(event.session_id).toBe(sessionId);
      expect(event.props).toMatchObject({ ...utm, event_contract: '2', traffic_class: 'qa', attribution_kind: 'session' });
    }
    for (const event of events.filter((event) => event.event === 'grib_next_step')) {
      expect(Object.keys(event.props).filter((key) => !(key in utm) && !['target', 'product', 'event_contract', 'measurement_build', 'traffic_class', 'attribution_kind'].includes(key))).toEqual([]);
    }
    const replay = new URL(analytics.withUtm('https://oscar.deepregatta.com/?race=fastnet2025&tab=map&lang=fr'));
    for (const [key, value] of Object.entries(utm)) expect(replay.searchParams.get(key)).toBe(value);
    expect(replay.searchParams.get('dr_traffic')).toBe('qa');
    expect(replay.searchParams.has('area')).toBe(false);
  });
