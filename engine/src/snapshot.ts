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
import { expectedPointIndex } from './auditSampling.js';
import { parseUtc } from './eta.js';
import { pointTimeIndex } from './findings/points.js';

export interface SnapshotStore {
  /** true if any artifact already exists for this snapshot id */
  exists(snapshotId: string): Promise<boolean>;
  /** Read immutable artifacts to verify a completed exact retry. */
  read?(snapshotId: string, filename: string): Promise<string | null>;
  /** Complete manifests only; used to allocate creation order within an intent. */
  list?(): Promise<Array<Record<string, unknown>>>;
  /** write one artifact (relative filename inside the snapshot dir) */
  write(snapshotId: string, filename: string, content: string): Promise<void>;
  /**
   * Optional: write every artifact of one new snapshot, in order with the
   * manifest last, as a single all-or-nothing operation. When it rejects, the
   * store must hold no artifact for `snapshotId` that this call added, and it
   * must still refuse to replace an existing artifact (write-once). Without it,
   * `writeSnapshot` calls `write` once per file.
   */
  writeAll?(snapshotId: string, files: SnapshotFile[]): Promise<void>;
}

/**
 * The write-once refusal: artifacts already exist for this snapshot id and
 * cannot be reopened as an exact retry (an unfinished earlier save, a legacy or
 * conflicting record, or a complete one the store could not read back). Nothing
 * is written. Callers tell it apart by class or `name`, never by message text.
 */
export class SnapshotExistsError extends Error {
  constructor(
    readonly snapshotId: string,
    message = `Snapshot ${snapshotId} is incomplete, legacy or conflicting. Snapshots are write-once.`,
  ) {
    super(message);
    this.name = 'SnapshotExistsError';
  }
}

/** One artifact of a snapshot: a relative filename inside the snapshot dir and its text. */
export interface SnapshotFile {
  filename: string;
  content: string;
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

/**
 * The ensemble plume and the deterministic model lines per leg, from the
 * per-sample-point forecasts the audit read (index-aligned with every leg's
 * `sample_points`, in order; one per leg for findings without them). A chart
 * shows the passage on its expected timing, so each leg's series follows the
 * boat's expected position: at each time, the sample point the boat is at on
 * the nominal timing (clamped to the leg; auditSampling.expectedPointIndex),
 * never the worst of the points.
 */
export function buildPlume(
  findings: Findings,
  pointEnsembles: EnsemblePointForecast[] | undefined,
  gustLimitKt: number,
  multiModelByPoint?: Record<string, HazardPointForecast[]>,
): Plume {
  const legs: PlumeLeg[] = [];
  if (pointEnsembles) {
    let offset = 0;
    findings.legs.forEach((leg) => {
      const n = leg.sample_points?.length || 1;
      const at = offset;
      offset += n;
      const ensembles = pointEnsembles.slice(at, at + n);
      const ensemble = ensembles[0];
      if (!ensemble) return;
      const follow = expectedFollower(leg, n, ensemble.times);
      const followMembers = (pick: (fc: EnsemblePointForecast) => Array<Array<number | null>>) =>
        pick(ensemble).map((_, m) => follow(ensembles, (fc, t) => pick(fc)[m]?.[t] ?? null).map(round1));
      const plumeLeg: PlumeLeg = {
        leg_id: leg.leg_id,
        times: ensemble.times,
        gust_limit_kt: gustLimitKt,
        gust_members: followMembers((fc) => fc.gust_kt_members),
        wind_members: followMembers((fc) => fc.wind_kt_members),
      };
      if (multiModelByPoint) {
        const deterministic: Record<string, Array<number | null>> = {};
        let times: string[] | undefined;
        for (const [model, forecasts] of Object.entries(multiModelByPoint)) {
          const own = forecasts.slice(at, at + n);
          const fc = own[0];
          if (!fc) continue;
          deterministic[model] = expectedFollower(leg, n, fc.times)(own, (f, t) => f.wind_kt[t] ?? null).map(round1);
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

/**
 * A series on `times` that, at each time, takes the value of the leg's sample
 * point the boat is at on the nominal timing. `pick(forecast, index)` reads one
 * point's value at its own index of that time.
 */
function expectedFollower(leg: Findings['legs'][number], n: number, times: string[]) {
  const nominal = { enterMs: utcOrNaN(leg.enter_range?.nominal), exitMs: utcOrNaN(leg.eta_range?.nominal) };
  const timesMs = times.map(utcOrNaN);
  const which = timesMs.map((t) => (Number.isFinite(nominal.enterMs) && Number.isFinite(nominal.exitMs) ? expectedPointIndex(n, nominal, t) : 0));
  return <F extends { times: string[] }>(forecasts: readonly F[], pick: (forecast: F, index: number) => number | null) => {
    const index = pointTimeIndex(forecasts);
    return timesMs.map((t, j) => {
      const k = which[j]!;
      const forecast = forecasts[k];
      const at = forecast ? index(k, t) : undefined;
      return forecast && at !== undefined ? pick(forecast, at) : null;
    });
  };
}

function utcOrNaN(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  try {
    return parseUtc(iso);
  } catch {
    return Number.NaN;
  }
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
    throw new SnapshotExistsError(id);
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
  // Every file is built before anything is written, so a store with writeAll
  // can save the whole check or nothing.
  const files: SnapshotFile[] = [];
  if (extras.decisionInputs) {
    artifacts.decision_inputs = 'decision-inputs.json';
    // Compact: this file holds the whole frozen grid, and indentation was over
    // half its size. No identity reads its text: decision_hash and snapshot_id
    // hash the value, and an exact retry compares canonical JSON of the parsed
    // file, so indented files saved earlier still reopen.
    files.push({ filename: 'decision-inputs.json', content: JSON.stringify(extras.decisionInputs) });
  }
  files.push({ filename: 'findings.json', content: stringify(findings) });
  files.push({ filename: 'briefing.json', content: stringify(briefing) });
  files.push({ filename: 'route.json', content: stringify(extras.route) });
  if (extras.plume) {
    artifacts.plume = 'plume.json';
    files.push({ filename: 'plume.json', content: stringify(extras.plume) });
  }
  if (extras.warnings !== undefined) {
    artifacts.warnings = 'warnings.json';
    files.push({ filename: 'warnings.json', content: stringify(extras.warnings) });
  }
  if (extras.synoptic !== undefined) {
    artifacts.synoptic = 'synoptic.json';
    files.push({ filename: 'synoptic.json', content: stringify(extras.synoptic) });
  }
  if (extras.tides !== undefined) {
    artifacts.tides = 'tides.json';
    files.push({ filename: 'tides.json', content: stringify(extras.tides) });
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
  files.push({ filename: 'snapshot.json', content: stringify(manifest) });
  if (store.writeAll) await store.writeAll(id, files);
  else for (const file of files) await store.write(id, file.filename, file.content);
  return { snapshot_id: id, manifest };
}

const stringify = (v: unknown) => JSON.stringify(v, null, 2);
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
