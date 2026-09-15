import { phraseExceedance } from '../exceedance.js';
import { hazardNoun, plainValueVsLimit } from '../plainLanguage.js';
import { haversineNm } from '../geo.js';
import type { assessGates } from '../hazards/tides.js';
import type { CausalEvent, Evidence, FindingsEvent, LegFinding, SynopticFeatures } from '../types.js';
import { evidenceLimitRatio } from './evidence.js';
import { RULES } from './rules.js';

/**
 * Attribute only evidence that is on the affected leg and inside the interval in
 * which a tracked system is near the route. Broad weather-system influence is
 * deliberately not inferred when there is no temporal and spatial overlap.
 */
export function deriveCausalEvents(
  synoptic: SynopticFeatures | undefined,
  legs: LegFinding[],
  evidence: Evidence[],
): CausalEvent[] {
  if (!synoptic) return [];
  const causal: CausalEvent[] = [];
  const HOUR = 3600_000;
  for (const system of synoptic.systems) {
    for (const leg of legs) {
      const occupancyStart = Date.parse(leg.enter_range.fast);
      // Findings are evaluated at whole forecast hours, including the ceiling
      // hour that contains the slow ETA. Keep attribution on that same grid.
      const occupancyEnd = Date.parse(leg.eta_range.slow) + HOUR;
      const nearby = system.track.filter((point) => {
        const time = Date.parse(point.valid_time);
        return (
          time >= occupancyStart - 3 * HOUR &&
          time <= occupancyEnd + 3 * HOUR &&
          haversineNm(point.lat, point.lon, leg.sample_point.lat, leg.sample_point.lon) <=
            (system.kind === 'low' ? 420 : 300)
        );
      });
      if (!nearby.length) continue;
      const start = Math.max(
        occupancyStart,
        Math.min(...nearby.map((point) => Date.parse(point.valid_time))) - 3 * HOUR,
      );
      const end = Math.min(
        occupancyEnd,
        Math.max(...nearby.map((point) => Date.parse(point.valid_time))) + 3 * HOUR,
      );
      const attributed = evidence.filter((item) => {
        if (item.leg_id !== leg.leg_id || !item.valid_time) return false;
        const time = Date.parse(item.valid_time);
        return time >= start && time <= end;
      });
      if (!attributed.length) continue;
      const strongest = [...attributed].sort(evidenceMateriality)[0]!;
      const pressure = nearby.reduce((best, point) =>
        system.kind === 'low'
          ? point.center_hpa < best.center_hpa ? point : best
          : point.center_hpa > best.center_hpa ? point : best,
      );
      const limitLabel = `your ${strongest.limit} ${strongest.units ?? ''} limit`.replace(/\s+/g, ' ').trim();
      const fractionText = strongest.member_fraction
        ? `${phraseExceedance(strongest.member_fraction, limitLabel)} (${hazardNoun(strongest.rule_id)})`
        : typeof strongest.value === 'number' && typeof strongest.limit === 'number'
          ? plainValueVsLimit(strongest.rule_id, strongest.value, strongest.limit, strongest.units)
          : `${String(strongest.value)} ${strongest.units ?? ''}`.trim();
      causal.push({
        event_id: `CE${causal.length + 1}`,
        name: `${system.kind === 'low' ? 'Low' : 'High'} ${system.system_id}`,
        kind: system.kind,
        system_id: system.system_id,
        route_intersection: {
          leg_id: leg.leg_id,
          window_start: new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          window_end: new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          eta_sensitivity: round1(
            (Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / HOUR,
          ),
        },
        consequence: {
          register_plain: `${fractionText.charAt(0).toUpperCase()}${fractionText.slice(1)} while ${system.kind === 'low' ? 'the low' : 'the high'} crosses ${leg.name}.`,
          register_pro: `${system.system_id} (${Math.round(pressure.center_hpa)} hPa) is within the conservative route-attribution radius during ${new Date(start).toISOString()}–${new Date(end).toISOString()}; only same-leg evidence inside that window is attributed.`,
          evidence_ids: attributed.map((item) => item.evidence_id),
        },
      });
    }
  }
  return causal;
}

function evidenceMateriality(a: Evidence, b: Evidence): number {
  const ratio = (item: Evidence) => {
    if (item.member_fraction) return item.member_fraction.exceed / item.member_fraction.total;
    return evidenceLimitRatio(item) ?? 0;
  };
  return ratio(b) - ratio(a);
}

export function deriveOperationalEvents(
  gates: ReturnType<typeof assessGates>,
  events: FindingsEvent[],
  evidence: Evidence[],
  legs: LegFinding[],
): CausalEvent[] {
  const out: CausalEvent[] = [];
  for (const gate of gates) {
    const refs = evidence.filter((item) => item.rule_id === 'T-GATE-01' && item.leg_id === gate.leg_id);
    const leg = legs.find((item) => item.leg_id === gate.leg_id);
    out.push({
      event_id: '',
      event_key: `gate:${gate.gate_id}`,
      name: gate.name,
      kind: 'gate',
      route_intersection: {
        leg_id: gate.leg_id,
        window_start: gate.transit.from,
        window_end: gate.transit.to,
        eta_sensitivity: leg ? round1((Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / 3600_000) : 0,
      },
      consequence: {
        register_plain: `${gate.name} is ${gate.status}; ${gate.rule_text}.`,
        register_pro: `Named gate ${gate.gate_id} evaluated against ${gate.reference_port} tide timing.`,
        evidence_ids: refs.map((item) => item.evidence_id),
      },
    });
  }
  for (const event of events.filter((item) => item.kind === 'wind_against_current' && item.leg_id && item.window)) {
    const leg = legs.find((item) => item.leg_id === event.leg_id);
    out.push({
      event_id: '',
      event_key: `wind-against-current:${event.leg_id}`,
      name: `Wind against current · ${leg?.name ?? event.leg_id}`,
      kind: 'wind_against_current',
      route_intersection: { leg_id: event.leg_id!, window_start: event.window!.from, window_end: event.window!.to, eta_sensitivity: leg ? round1((Date.parse(leg.eta_range.slow) - Date.parse(leg.eta_range.fast)) / 3600_000) : 0 },
      consequence: { register_plain: `Wind opposes the current at ${leg?.name ?? event.leg_id}, increasing the risk of short, steep seas.`, register_pro: 'Course-relative wind and sampled surface-current vectors oppose within the route occupancy window.', evidence_ids: event.refs },
    });
  }
  for (const warning of evidence.filter((item) => item.rule_id === RULES.AUTHORITY && item.bulletin_ref)) {
    const zones = warning.bulletin_ref!.zone_ids;
    out.push({
      event_id: '',
      event_key: `warning:${zones.join('+')}:${warning.bulletin_ref!.valid_from}`,
      name: `${zones.join(' / ')} marine warning`,
      kind: 'front',
      consequence: { register_plain: `${warning.value} covers a crossed marine zone.`, register_pro: `Bulletin source ${warning.bulletin_ref!.source}; valid ${warning.bulletin_ref!.valid_from}–${warning.bulletin_ref!.valid_to}.`, evidence_ids: [warning.evidence_id] },
    });
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
