// /api/polars and /api/polars/<id>: read the pinned deep-polars release from
// the private repository at request time, so this public site never ships a
// polar file (deep-polars decisions 2, 7 and 11). docs/boat-polars.md.
//
// - Every file is checked before it is served: index.json against the pinned
//   SHA-256, each boats/<id>.json against its SHA-256 in that index.
// - Each client (IP address, IPv6 by /64) is rate limited through the
//   passage-polar-limiter Worker before anything is read.
// - Nothing here logs a response body; logs carry a status, reason and path.
//
// Environment: DEEP_POLARS_TOKEN (encrypted secret, fine-grained read-only
// token for deepregatta/deep-polars), POLAR_LIMITER (service binding to
// passage-polar-limiter). POLAR_RATE_LIMIT=off disables the limiter for local
// development only (.dev.vars).

import { DEEP_POLARS } from './deepPolarsPin.mjs';

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BOAT_CACHE_ENTRIES = 256;
const ok = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };

class Refusal extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...ok, 'Cache-Control': 'no-store', ...headers } });
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The client a limit applies to: its address, or its /64 for IPv6. */
export function clientKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // IPv4, or IPv4-mapped IPv6
  if (!ip.includes(':')) return ip || 'unknown';
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

async function admit(env, kind, request) {
  if (!env.POLAR_LIMITER) {
    if (env.POLAR_RATE_LIMIT === 'off') return;
    throw new Refusal(503, 'Boat polars are not configured on this deployment');
  }
  let allowed;
  try {
    const response = await env.POLAR_LIMITER.fetch('https://passage-polar-limiter/limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key: clientKey(request) }),
    });
    if (!response.ok) throw new Error(`limiter HTTP ${response.status}`);
    allowed = (await response.json()).allowed === true;
  } catch (error) {
    console.warn(`polars: 503 rate limiter unavailable (${error.message})`);
    throw new Refusal(503, 'Boat polars are unavailable right now');
  }
  if (!allowed) throw new Refusal(429, 'Too many boat polar requests', { 'Retry-After': '60' });
}

async function fetchVerified(pin, env, ctx, path, expectedSha256) {
  const token = env.DEEP_POLARS_TOKEN;
  if (!token) throw new Refusal(503, 'Boat polars are not configured on this deployment');

  // The cache key includes the secret token, so it cannot be guessed.
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const key = cache && new Request(`https://deep-polars.cache/${await sha256Hex(new TextEncoder().encode(`${token}\n${pin.commit}\n${path}`))}`);
  const cached = cache && await cache.match(key).catch(() => undefined);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await sha256Hex(bytes) === expectedSha256) return bytes;
  }

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${pin.repository}/contents/${path}?ref=${pin.commit}`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'passage-polars-function',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    console.warn(`polars: 503 release unreachable ${path} (${error.message})`);
    throw new Refusal(503, 'Boat polars are unavailable right now');
  }
  if (!response.ok) {
    console.warn(`polars: 503 release returned HTTP ${response.status} for ${path}`);
    throw new Refusal(503, 'Boat polars are unavailable right now');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256Hex(bytes) !== expectedSha256) {
    console.error(`polars: 502 integrity check failed for ${path}`);
    throw new Refusal(502, 'Boat polar failed its integrity check');
  }
  if (cache) {
    const put = cache.put(key, new Response(bytes, { headers: { 'Cache-Control': 'max-age=31536000' } })).catch(() => {});
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(put);
  }
  return bytes;
}

/**
 * Handlers for one pinned release, each with its own per-isolate caches:
 * the verified index (id -> SHA-256, and the picker list, which holds no
 * polar data) and up to BOAT_CACHE_ENTRIES verified boat files.
 */
export function polarHandlers(pin = DEEP_POLARS) {
  let releaseIndex = null;
  const boats = new Map();

  function loadIndex(env, ctx) {
    releaseIndex ??= (async () => {
      const bytes = await fetchVerified(pin, env, ctx, `releases/${pin.version}/index.json`, pin.indexSha256);
      const index = JSON.parse(new TextDecoder().decode(bytes));
      if (index.version !== pin.version) throw new Refusal(502, 'Boat polar index is not the pinned release');
      const digests = new Map(index.boats.map((boat) => [boat.id, boat.sha256]));
      const picker = JSON.stringify({
        version: index.version,
        polars: index.boats.map((boat) => ({
          polar_id: boat.id, label: boat.label, kind: boat.kind, variant_of: boat.variant_of,
          aliases: boat.aliases, builder: boat.builder, loa_m: boat.loa_m, year: boat.year, source: boat.source,
        })),
      });
      return { digests, picker };
    })();
    releaseIndex.catch(() => { releaseIndex = null; });
    return releaseIndex;
  }

  async function handleIndex(context) {
    const { request, env } = context;
    try {
      await admit(env, 'index', request);
      const { picker } = await loadIndex(env, context);
      return new Response(picker, { headers: { ...ok, 'Cache-Control': 'private, max-age=3600' } });
    } catch (error) {
      return refused(error);
    }
  }

  async function handleBoat(context) {
    const { request, env, params } = context;
    try {
      await admit(env, 'boat', request);
      const id = String(params?.id ?? '');
      if (!ID.test(id)) throw new Refusal(404, 'No such boat');
      const { digests } = await loadIndex(env, context);
      const expected = digests.get(id);
      if (!expected) throw new Refusal(404, 'No such boat');
      let bytes = boats.get(id);
      if (!bytes) {
        bytes = await fetchVerified(pin, env, context, `releases/${pin.version}/boats/${id}.json`, expected);
        if (boats.size >= BOAT_CACHE_ENTRIES) boats.delete(boats.keys().next().value);
        boats.set(id, bytes);
      }
      return new Response(bytes, {
        headers: { ...ok, 'Cache-Control': 'private, max-age=3600', 'X-Deep-Polars-Release': pin.version },
      });
    } catch (error) {
      return refused(error);
    }
  }

  return { handleIndex, handleBoat };
}

function refused(error) {
  if (error instanceof Refusal) return json(error.status, { error: error.message }, error.headers);
  console.error(`polars: 500 ${error?.name ?? 'Error'}`);
  return json(500, { error: 'Boat polars are unavailable right now' });
}

export const { handleIndex, handleBoat } = polarHandlers();
