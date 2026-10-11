// passage-polar-limiter: per-client rate limits for Passage's /api/polars
// (deep-polars decision 11). Pages Functions cannot hold a Rate Limiting
// binding, so the Pages project reaches this Worker through a service
// binding. It has no public route. docs/boat-polars.md.
//
// POST {kind: 'boat' | 'index', key} -> {allowed}. Counts are kept per
// Cloudflare location and are approximate, as the binding documents.

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const limiter = { boat: env.BOAT_READS, index: env.INDEX_READS }[body?.kind];
    if (!limiter || typeof body.key !== 'string' || !body.key) return new Response(null, { status: 400 });
    const { success } = await limiter.limit({ key: `${body.kind}:${body.key}` });
    return Response.json({ allowed: success });
  },
};
