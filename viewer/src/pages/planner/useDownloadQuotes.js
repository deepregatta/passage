import { useEffect, useRef, useState } from 'react';
import { forecastStore } from '../../lib/forecastStore.js';
import { FORECAST_CHECK_MS, refreshForecastIfStale } from '../../lib/forecastFreshness.js';
import { downloadLine, quotePlannerActions } from '../../lib/downloadQuote.js';

const NO_LINES = Object.freeze({ compute: null, scan: null, check: null });

/**
 * How often an open page re-quotes. Shorter than the freshness threshold on
 * purpose: `refreshForecastIfStale` acts only when the last check is more than
 * FORECAST_CHECK_MS old, so a tick of exactly that length would find the store
 * just under it every other time.
 */
export const QUOTE_TICK_MS = 60_000;

/**
 * The line under each of the Compute, Scan and Check buttons: how much forecast
 * data the action would download. Computed in the background from the pinned run
 * manifests and the store's tile holdings; it never fetches a tile and never
 * blocks typing or the map. The figure is an estimate designed as an upper bound
 * (docs/capabilities.md lists the ways it can still be low).
 *
 * What it does fetch: the first time something is quotable (two endpoints and a
 * boat, or a route) it initialises the forecast store, which reads latest.json
 * and one manifest per layer: a network read on page view that did not happen
 * before. On every quote pass (an edit, a tick, focus) it then calls
 * `refreshForecastIfStale`, which re-reads latest.json only when the last check is
 * over ten minutes old and no action is running, so the quote is about the run an
 * action would use; with a fresh store that call makes no request. A failed refresh
 * (the store was stale and its check time did not advance) or a failed first load
 * is not retried for ten minutes, so editing offline does not refetch on every
 * edit; the quote still comes from what is held. A pressed action refreshes by
 * its own rule (`withFreshForecast`), unchanged, and clears that wait.
 *
 * It recomputes when the route, endpoints, boat or departure change, when an action
 * finishes (its tiles are then held, so the line says so), every minute while the
 * page sits open, and when the page becomes visible or focused again: a newer
 * forecast run replaces the tiles an earlier quote counted as held. While an action
 * runs, or when an action is blocked, its line is hidden.
 *
 * @param {{ want: { compute: boolean, scan: boolean, check: boolean }, busy: string | null, mode: string,
 *   endpoints: Array<{lat: number, lng: number}>, polarId: string | null, route: object | null,
 *   departureUtc: string | null, passageHours: number | null }} inputs
 */
export default function useDownloadQuotes(inputs) {
  const { want, busy, mode, endpoints, polarId, route, departureUtc, passageHours } = inputs;
  const [lines, setLines] = useState(NO_LINES);
  const [tick, setTick] = useState(0);
  const latest = useRef(inputs);
  latest.current = inputs;
  // Waits after a failed first load or failed refresh (ms); a pressed action clears both.
  const initBlockedUntil = useRef(0);
  const refreshBlockedUntil = useRef(0);
  const loaded = useRef(false);
  const shownFor = useRef(null);
  const idle = busy === null;
  useEffect(() => {
    if (!idle) {
      initBlockedUntil.current = 0;
      refreshBlockedUntil.current = 0;
    }
  }, [idle]);

  // Re-quote on the freshness interval and when the page comes back to the foreground.
  useEffect(() => {
    if (!idle) return undefined;
    const bump = () => setTick((n) => n + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    const timer = setInterval(bump, QUOTE_TICK_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', bump);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', bump);
    };
  }, [idle]);

  const wantKey = [want.compute, want.scan, want.check].join('|');
  const endpointsKey = JSON.stringify(endpoints.map(({ lat, lng }) => [lat, lng]));
  // The name and passage id are not inputs of a quote; the points, speeds and timing are.
  const routeKey = route ? JSON.stringify([route.waypoints?.map((p) => [p.lat, p.lon]), route.speeds_kt, route.timing]) : '';

  useEffect(() => {
    // A re-quote for the clock or focus alone keeps the line up; an edit clears it until the new figure is in.
    const inputKey = [idle, wantKey, mode, endpointsKey, polarId, routeKey, departureUtc, passageHours].join('#');
    if (shownFor.current !== inputKey) {
      shownFor.current = inputKey;
      setLines(NO_LINES);
    }
    const current = latest.current;
    if (!idle || !(current.want.compute || current.want.scan || current.want.check)) return undefined;
    let live = true;
    (async () => {
      let quotes;
      try {
        const store = forecastStore();
        if (typeof store?.init !== 'function' || typeof store.manifestFor !== 'function') return;
        const now = Date.now();
        if (!loaded.current) {
          if (now < initBlockedUntil.current) return;
          try {
            await store.init();
            loaded.current = true;
          } catch {
            initBlockedUntil.current = now + FORECAST_CHECK_MS;
            return;
          }
        }
        if (now >= refreshBlockedUntil.current) {
          const checkedBefore = typeof store.lastCheckedMs === 'function' ? store.lastCheckedMs() : undefined;
          await refreshForecastIfStale({ store });
          // Stale before and not advanced after: the read failed (or none could start). Wait before the next try.
          if (checkedBefore !== undefined && (checkedBefore === null || now - checkedBefore > FORECAST_CHECK_MS)
            && store.lastCheckedMs() === checkedBefore) {
            refreshBlockedUntil.current = now + FORECAST_CHECK_MS;
          }
        }
        if (!live) return;
        quotes = await quotePlannerActions({
          store, manifests: (layer) => store.manifestFor(layer), want: current.want, mode: current.mode,
          endpoints: current.endpoints, polarId: current.polarId, route: current.route,
          departureUtc: current.departureUtc, passageHours: current.passageHours,
        });
      } catch {
        return; // no figure rather than a wrong one
      }
      if (live) {
        setLines({ compute: downloadLine(quotes.compute), scan: downloadLine(quotes.scan), check: downloadLine(quotes.check) });
      }
    })();
    return () => { live = false; };
  }, [idle, tick, wantKey, mode, endpointsKey, polarId, routeKey, departureUtc, passageHours]);

  return {
    compute: want.compute ? lines.compute : null,
    scan: want.scan ? lines.scan : null,
    check: want.check ? lines.check : null,
  };
}
