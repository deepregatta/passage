// passage-polar-limiter: per-client rate limits for Passage's /api/polars
// (deep-polars decision 11). Pages Functions reach this Worker through the
// POLAR_LIMITER service binding; it has no public route. docs/boat-polars.md.
//
// POST {kind: 'boat' | 'index', key} -> {allowed}. Each kind and client has
// one Durable Object holding a 60 s sliding window of its allowed requests,
// so the count is exact. (Cloudflare's Rate Limiting binding was tried first:
// it is approximate by design and let 126 boat reads a minute through.)

export const LIMITS = Object.freeze({ boat: 30, index: 10 });
export const WINDOW_MS = 60_000;

/** One client's window for one kind: the times of its allowed requests. */
export class ClientWindow {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const limit = Number(new URL(request.url).searchParams.get('limit'));
    const now = Date.now();
    const hits = ((await this.storage.get('hits')) ?? []).filter((t) => now - t < WINDOW_MS);
    const allowed = hits.length < limit;
    if (allowed) {
      hits.push(now);
      await this.storage.put('hits', hits);
    }
    // A quiet minute empties the window; the alarm then deletes it.
    await this.storage.setAlarm(now + WINDOW_MS);
    return Response.json({ allowed });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const limit = LIMITS[body?.kind];
    if (!limit || typeof body.key !== 'string' || !body.key) return new Response(null, { status: 400 });
    const counter = env.CLIENT_WINDOWS.get(env.CLIENT_WINDOWS.idFromName(`${body.kind}:${body.key}`));
    const { allowed } = await (await counter.fetch(`https://client-window/?limit=${limit}`)).json();
    return Response.json({ allowed: allowed === true });
  },
};
