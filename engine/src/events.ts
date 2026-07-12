import { haversineNm } from './geo.js';
import type { CausalEvent, SynopticFeatures } from './types.js';

export function eventKeyForSystem(system: SynopticFeatures['systems'][number]): string {
  const first = system.track[0];
  const latBand = first ? Math.round(first.lat / 5) * 5 : 0;
  const lonBand = first ? Math.round(first.lon / 5) * 5 : 0;
  const trend = (system.deepening_hpa_per_24h ?? 0) < -1 ? 'deepening' : (system.deepening_hpa_per_24h ?? 0) > 1 ? 'filling' : 'steady';
  return `${system.kind}:${latBand}:${lonBand}:${trend}`;
}

export function assignEventKeys(events: CausalEvent[], synoptic?: SynopticFeatures): CausalEvent[] {
  if (!synoptic) return events;
  return events.map((event) => {
    const system = synoptic.systems.find((item) => item.system_id === event.system_id);
    return system ? { ...event, event_key: eventKeyForSystem(system) } : event;
  });
}

export function matchSystems(previous: SynopticFeatures, latest: SynopticFeatures) {
  const matches = [];
  for (const current of latest.systems) {
    const currentFirst = current.track[0];
    if (!currentFirst) continue;
    const candidates = previous.systems
      .filter((item) => item.kind === current.kind && item.track[0])
      .map((item) => {
        const first = item.track[0]!;
        return {
          previous: item,
          distance_nm: haversineNm(currentFirst.lat, currentFirst.lon, first.lat, first.lon),
          trend_delta: Math.abs((current.deepening_hpa_per_24h ?? 0) - (item.deepening_hpa_per_24h ?? 0)),
        };
      })
      .filter((item) => item.distance_nm <= 600 && item.trend_delta <= 12)
      .sort((a, b) => a.distance_nm - b.distance_nm || a.trend_delta - b.trend_delta);
    if (candidates[0]) matches.push({ latest_system_id: current.system_id, previous_system_id: candidates[0].previous.system_id, distance_nm: Math.round(candidates[0].distance_nm), trend_delta: candidates[0].trend_delta });
  }
  return matches;
}
