/**
 * Tidal gates (brief §5): named passages where transit must be timed against
 * HW/slack at a reference port ("slack at the Raz ≈ HW Brest −0h30").
 * v0: the gate rule defines one favorable transit window per HW cycle; the
 * boat's ETA range at the gate is compared against it. Direction nuance and
 * height-dependent hazards come later. Synthetic tide sources are badged
 * emulated everywhere downstream.
 */

import { haversineNm } from '../geo.js';
import { parseUtc, toIso, type LegSchedule } from '../eta.js';
import type { Leg } from '../types.js';

export interface TidesDoc {
  schema_version: number;
  generated_at: string;
  source: { mode: 'live' | 'fixture' | 'synthetic'; constituents?: string[]; note?: string };
  ports: Array<{
    port_id: string;
    name: string;
    lat?: number;
    lon?: number;
    events: Array<{ kind: 'HW' | 'LW'; time: string; height_m: number }>;
  }>;
}

export interface GateDef {
  gate_id: string;
  name: string;
  lat: number;
  lon: number;
  reference_port: string;
  favorable_sw_going?: { from_hw_h: number; to_hw_h: number };
  slack_offset_h?: number;
  note?: string;
  verified?: boolean;
}

export interface GateAssessment {
  gate_id: string;
  name: string;
  leg_id: string;
  distance_nm: number;
  reference_port: string;
  /** boat's possible transit interval at the gate (fast..slow scenarios) */
  transit: { from: string; to: string };
  /** favorable windows overlapping the transit day */
  favorable: Array<{ from: string; to: string }>;
  status: 'ok' | 'marginal' | 'conflict';
  rule_text: string;
}

const GATE_RELEVANT_NM = 6;
const SLACK_HALF_WIDTH_H = 0.75;

export function assessGates(
  gates: GateDef[],
  tides: TidesDoc,
  legs: Leg[],
  schedules: LegSchedule[],
): GateAssessment[] {
  const out: GateAssessment[] = [];

  for (const gate of gates) {
    // nearest leg + along-leg fraction (sampled every ~10% of the leg)
    let best: { leg: Leg; schedule: LegSchedule; dist: number; frac: number } | null = null;
    legs.forEach((leg, i) => {
      for (let f = 0; f <= 1; f += 0.1) {
        const lat = leg.from.lat + (leg.to.lat - leg.from.lat) * f;
        const lon = leg.from.lon + (leg.to.lon - leg.from.lon) * f;
        const dist = haversineNm(gate.lat, gate.lon, lat, lon);
        if (!best || dist < best.dist) best = { leg, schedule: schedules[i]!, dist, frac: f };
      }
    });
    if (!best || (best as { dist: number }).dist > GATE_RELEVANT_NM) continue;
    const b = best as { leg: Leg; schedule: LegSchedule; dist: number; frac: number };

    const port = tides.ports.find((p) => p.port_id === gate.reference_port);
    if (!port) continue;

    // transit interval: fast scenario earliest .. slow scenario latest at the gate fraction
    const enterFast = parseUtc(b.schedule.enter.fast);
    const exitFast = parseUtc(b.schedule.exit.fast);
    const enterSlow = parseUtc(b.schedule.enter.slow);
    const exitSlow = parseUtc(b.schedule.exit.slow);
    const transitFrom = enterFast + (exitFast - enterFast) * b.frac;
    const transitTo = enterSlow + (exitSlow - enterSlow) * b.frac;

    // favorable windows from each HW at the reference port
    const favorable: Array<{ fromMs: number; toMs: number }> = [];
    let ruleText: string;
    const hwEvents = port.events.filter((e) => e.kind === 'HW');
    if (gate.slack_offset_h !== undefined) {
      ruleText = `slack ≈ HW ${port.name} ${fmtOffset(gate.slack_offset_h)} (±45 min)`;
      for (const hw of hwEvents) {
        const center = parseUtc(hw.time) + gate.slack_offset_h * 3600_000;
        favorable.push({
          fromMs: center - SLACK_HALF_WIDTH_H * 3600_000,
          toMs: center + SLACK_HALF_WIDTH_H * 3600_000,
        });
      }
    } else if (gate.favorable_sw_going) {
      const { from_hw_h, to_hw_h } = gate.favorable_sw_going;
      ruleText = `favorable stream HW ${port.name} ${fmtOffset(from_hw_h)} to ${fmtOffset(to_hw_h)}`;
      for (const hw of hwEvents) {
        favorable.push({
          fromMs: parseUtc(hw.time) + from_hw_h * 3600_000,
          toMs: parseUtc(hw.time) + to_hw_h * 3600_000,
        });
      }
    } else {
      continue;
    }

    // overlap classification across the transit interval
    const overlaps = favorable
      .map((w) => ({
        from: Math.max(w.fromMs, transitFrom),
        to: Math.min(w.toMs, transitTo),
      }))
      .filter((o) => o.to > o.from);
    const transitSpan = Math.max(1, transitTo - transitFrom);
    const covered = overlaps.reduce((sum, o) => sum + (o.to - o.from), 0) / transitSpan;
    const status: GateAssessment['status'] = covered >= 0.9 ? 'ok' : covered > 0 ? 'marginal' : 'conflict';

    out.push({
      gate_id: gate.gate_id,
      name: gate.name,
      leg_id: b.leg.leg_id,
      distance_nm: Math.round(b.dist * 10) / 10,
      reference_port: port.name,
      transit: { from: toIso(transitFrom), to: toIso(transitTo) },
      favorable: favorable
        .filter((w) => w.toMs > transitFrom - 12 * 3600_000 && w.fromMs < transitTo + 12 * 3600_000)
        .map((w) => ({ from: toIso(w.fromMs), to: toIso(w.toMs) })),
      status,
      rule_text: ruleText + (gates.find((g) => g.gate_id === gate.gate_id)?.verified ? '' : '. Timing rule unverified (pilot-book approximation)'),
    });
  }
  return out;
}

function fmtOffset(hours: number): string {
  const sign = hours < 0 ? '−' : '+';
  const abs = Math.abs(hours);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `${sign}${h}h${m ? String(m).padStart(2, '0') : ''}`;
}
