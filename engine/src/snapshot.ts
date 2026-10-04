/**
 * Immutable snapshots: every analysis is recorded write-once with
 * everything needed to re-render it later; findings, briefing, plume, and
 * frozen copies of mutable inputs. Store interface keeps the core browser-safe
 * (filesystem storage for the CLI; dev HTTP writes or IndexedDB in the viewer).
 */

import { validDecisionMessageFields } from './briefingMessages.js';
import { canonicalJson, contentHash } from './hash.js';
import type { Briefing } from './briefing.js';
import type { EnsemblePointForecast, HazardPointForecast } from './forecast/types.js';
import type { Findings, Route } from './types.js';

export interface SnapshotStore {
  /** true if any artifact already exists for this snapshot id */
  exists(snapshotId: string): Promise<boolean>;
  /** Read immutable artifacts to verify a completed exact retry. */
  read?(snapshotId: string, filename: string): Promise<string | null>;
  /** Complete manifests only; used to allocate creation order within an intent. */
  list?(): Promise<Array<Record<string, unknown>>>;
  /** write one artifact (relative filename inside the snapshot dir) */
  write(snapshotId: string, filename: string, content: string): Promise<void>;
}

export interface PlumeLeg {
  leg_id: string;
  times: string[];
  gust_limit_kt: number;
  /** [member][timeIdx], rounded 0.1 kt */
  gust_members: Array<Array<number | null>>;
  wind_members: Array<Array<number | null>>;
  /** per deterministic model: sustained wind series aligned to `deterministic_times` */
  deterministic?: Record<string, Array<number | null>>;
  deterministic_times?: string[];
}

export interface Plume {
  schema_version: number;
  snapshot_id: string;
  model: string | null;
  legs: PlumeLeg[];
}

export function buildPlume(
  findings: Findings,
  legEnsembles: EnsemblePointForecast[] | undefined,
  gustLimitKt: number,
  multiModelByLeg?: Record<string, HazardPointForecast[]>,
): Plume {
  const legs: PlumeLeg[] = [];
  if (legEnsembles) {
    findings.legs.forEach((leg, i) => {
      const ensemble = legEnsembles[i];
      if (!ensemble) return;
      const plumeLeg: PlumeLeg = {
        leg_id: leg.leg_id,
        times: ensemble.times,
        gust_limit_kt: gustLimitKt,
        gust_members: ensemble.gust_kt_members.map((s) => s.map(round1)),
        wind_members: ensemble.wind_kt_members.map((s) => s.map(round1)),
      };
      if (multiModelByLeg) {
        const deterministic: Record<string, Array<number | null>> = {};
        let times: string[] | undefined;
        for (const [model, forecasts] of Object.entries(multiModelByLeg)) {
          const fc = forecasts[i];
          if (!fc) continue;
          deterministic[model] = fc.wind_kt.map(round1);
          times = times ?? fc.times;
        }
        if (times) {
          plumeLeg.deterministic = deterministic;
          plumeLeg.deterministic_times = times;
        }
      }
      legs.push(plumeLeg);
    });
  }
  const ensembleInput = findings.inputs.forecast_tiles.find((m) => m.layer === 'ensemble');
  return {
    schema_version: 1,
    snapshot_id: findings.snapshot_id,
    model: (ensembleInput?.model as string) ?? null,
    legs,
  };
}

export interface SnapshotExtras {
  decisionInputs?: Record<string, unknown>;
  route: Route;
  plume?: Plume;
  warnings?: unknown;
  synoptic?: unknown;
  tides?: unknown;
}

export async function writeSnapshot(
  store: SnapshotStore,
  findings: Findings,
  briefing: Briefing,
  extras: SnapshotExtras,
  nowMs: number,
): Promise<{ snapshot_id: string; manifest: Record<string, unknown> }> {
  const id = findings.snapshot_id;
  if (findings.identity_version === 2 && (!extras.decisionInputs || contentHash(extras.decisionInputs) !== findings.decision_hash ||
      canonicalJson(extras.decisionInputs.route) !== canonicalJson(extras.route))) {
    throw new Error('Snapshot decision inputs conflict with its identity.');
  }
  if (await store.exists(id)) {
    const manifestJson = await store.read?.(id, 'snapshot.json');
    const savedDecision = await store.read?.(id, 'decision-inputs.json');
    if (findings.identity_version === 2 && manifestJson && savedDecision && extras.decisionInputs) {
      const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
      if (manifest.identity_version === 2 && Number.isSafeInteger(manifest.check_sequence) && Number(manifest.check_sequence) > 0 && manifest.snapshot_id === id &&
          manifest.decision_hash === findings.decision_hash &&
          canonicalJson(JSON.parse(savedDecision)) === canonicalJson(extras.decisionInputs)) {
        // Manifest-last completion is required. Also refuse missing advertised files.
        const artifacts = manifest.artifacts as Record<string, string>;
        if (artifacts?.findings === 'findings.json' && artifacts.briefing === 'briefing.json' &&
            artifacts.route === 'route.json' && artifacts.decision_inputs === 'decision-inputs.json' && (await Promise.all(Object.values(artifacts).map(file => store.read!(id, file)))).every(file => file !== null)) {
          return { snapshot_id: id, manifest };
        }
      }
    }
    throw new Error(`Snapshot ${id} is incomplete, legacy or conflicting. Snapshots are write-once.`);
  }

  // New metadata must be valid before any artifact is written. Existing exact
  // retries above still reopen immutable originals, even after copy-only edits.
  if (briefing.sections.some(section => section.messages !== undefined &&
      (section.id !== 'decision' || !validDecisionMessageFields(section)))) {
    throw new Error('Invalid decision message metadata or canonical English fallback.');
  }

  const history = findings.passage_id ? (await store.list?.() ?? []).filter(item =>
    item.identity_version === 2 && item.passage_id === findings.passage_id) : [];
  const checkSequence = 1 + history.reduce((max, item) =>
    Number.isSafeInteger(item.check_sequence) ? Math.max(max, Number(item.check_sequence)) : max, 0);
  const artifacts: Record<string, unknown> = {
    findings: 'findings.json',
    briefing: 'briefing.json',
    route: 'route.json',
  };
  if (extras.decisionInputs) {
    artifacts.decision_inputs = 'decision-inputs.json';
    await store.write(id, 'decision-inputs.json', stringify(extras.decisionInputs));
  }
  await store.write(id, 'findings.json', stringify(findings));
  await store.write(id, 'briefing.json', stringify(briefing));
  await store.write(id, 'route.json', stringify(extras.route));
  if (extras.plume) {
    artifacts.plume = 'plume.json';
    await store.write(id, 'plume.json', stringify(extras.plume));
  }
  if (extras.warnings !== undefined) {
    artifacts.warnings = 'warnings.json';
    await store.write(id, 'warnings.json', stringify(extras.warnings));
  }
  if (extras.synoptic !== undefined) {
    artifacts.synoptic = 'synoptic.json';
    await store.write(id, 'synoptic.json', stringify(extras.synoptic));
  }
  if (extras.tides !== undefined) {
    artifacts.tides = 'tides.json';
    await store.write(id, 'tides.json', stringify(extras.tides));
  }

  const manifest = {
    schema_version: 1,
    snapshot_id: id,
    ...(findings.identity_version === 2 ? {
      identity_version: 2, passage_id: findings.passage_id, check_sequence: checkSequence,
      route_revision: findings.route_revision, decision_hash: findings.decision_hash,
    } : {}),
    created_at: new Date(nowMs).toISOString(),
    engine_version: findings.engine_version,
    route_id: findings.route_id,
    profile_id: findings.profile_id,
    departure_utc: findings.departure_utc,
    verdict_state: findings.verdict.state,
    artifacts,
    input_hashes: {
      route: findings.inputs.route_hash,
      profile: findings.inputs.profile_hash,
    },
  };
  // manifest written LAST; its presence marks the snapshot complete
  await store.write(id, 'snapshot.json', stringify(manifest));
  return { snapshot_id: id, manifest };
}

const stringify = (v: unknown) => JSON.stringify(v, null, 2);
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
