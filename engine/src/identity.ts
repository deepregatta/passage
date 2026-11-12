/** Versioned browser-safe identities. Clocks describe creation, never intent. */
import { parseUtc, toIso } from './eta.js';
import { contentHash } from './hash.js';
import type { AssembleOptions } from './findings/options.js';
import type { TileRequestMeta } from './forecast/types.js';
import type { Route } from './types.js';

export const IDENTITY_VERSION = 2;
// Bump alongside any change to evaluation/rendering semantics affecting saved results.
export const ENGINE_SEMANTICS = 'passage-audit-3';

export function routeRevision(route: Route, departureUtc: string): string {
  const { passage_id: _intent, ...content } = route;
  return contentHash({ route: content, departureUtc: toIso(parseUtc(departureUtc)) });
}

// A departure scan only ranks its candidates' findings: it never shows or saves
// them, and a candidate the skipper opens is checked afresh. Hashing their
// decision inputs was most of a scan's time, so a scan marks its audit options.
// The mark is on that exact object: a copy, or any other caller, keeps the identity.
const withoutIdentity = new WeakSet<object>();

/** Audit these exact options without the saved identity (no decision inputs, decision hash or snapshot id). */
export function withoutSavedIdentity<T extends object>(options: T): T {
  withoutIdentity.add(options);
  return options;
}

export function skipsSavedIdentity(options: object): boolean {
  return withoutIdentity.has(options);
}

/** Archive exactly this JSON before the manifest; equality protects hash collisions. */
export function decisionInputs(options: AssembleOptions): Record<string, unknown> {
  const { nowMs: _clock, requestMeta, ensembleMeta, marineMeta, multiModel, ...inputs } = options;
  const stableMeta = (meta: TileRequestMeta) => {
    const { fetched_at: _retrievalClock, cached_tiles: _cacheStats, ...stable } = meta;
    return stable;
  };
  // Tile mosaics are built locally on each read. Their creation/retrieval clocks
  // and raw provenance digest change with cache warmth, although samples do not.
  let current = {};
  const tileCurrent = inputs.currentProvenance?.current_source === 'tiles';
  if (tileCurrent && inputs.currentGrid) {
    const { generated_at: _mosaicClock, source, ...grid } = inputs.currentGrid;
    const { fetched_at: _gridClock, ...gridSource } = source;
    const stableGrid = { ...grid, source: gridSource };
    current = { currentGrid: stableGrid, currentProvenance: { ...inputs.currentProvenance, content_digest: contentHash(stableGrid) } };
  }
  return {
    identity_version: IDENTITY_VERSION,
    engine_semantics: ENGINE_SEMANTICS,
    ...inputs,
    ...current,
    departureUtc: toIso(parseUtc(inputs.departureUtc)),
    requestMeta: requestMeta.map(stableMeta),
    ...(ensembleMeta ? { ensembleMeta: stableMeta(ensembleMeta) } : {}),
    ...(marineMeta ? { marineMeta: stableMeta(marineMeta) } : {}),
    ...(multiModel ? { multiModel: { ...multiModel, meta: multiModel.meta.map(stableMeta) } } : {}),
  };
}
