# Boat polars

Passage is a public repository and a public site, and polar data never goes
into either, nor into a log ([deep-polars](https://github.com/deepregatta/deep-polars)
decisions 2, 7 and 11). The browser gets the boat list and one boat's polar at
request time from a Pages Function that reads the private release.

## What is public

| Surface | Public | Holds polar data |
|---|---|---|
| This repository and its published branch/tag history | yes | no: rewritten 2026-10-11; old GitHub views await purge ([below](#history)) |
| The Pages build (`viewer/dist`) | yes | no: `npm run build:pages` fails if any comes back |
| `GET /api/polars` | yes, rate limited | no: picker fields only (id, label, kind, variant, aliases, builder, length, year, source) |
| `GET /api/polars/<id>` | yes, rate limited | one boat's release entry, for the router in the browser |

A rate limit slows a scraper; it does not stop one that rotates addresses. At
30 boats a minute one address can copy the 3,401-boat release in about two
hours.

## Request path

[`functions/api/polars/`](../functions/api/polars/) routes to
[`server/polars.mjs`](../server/polars.mjs):

1. **Limit.** Every request is counted first, per client: its
   `CF-Connecting-IP`, IPv6 grouped by /64. Over the limit is `429` with
   `Retry-After: 60`, before anything is read.
2. **Read.** The function reads `releases/<version>/index.json` and
   `releases/<version>/boats/<id>.json` from `deepregatta/deep-polars` at the
   pinned commit through the GitHub contents API, with the
   `DEEP_POLARS_TOKEN` secret.
3. **Check.** `index.json` must match the pinned SHA-256; each boat file must
   match its SHA-256 in that index. A mismatch is `502` and nothing is served.
   Ids outside the index are `404` without a boat read.
4. **Cache.** Verified files are kept in the isolate and in Cloudflare's cache
   under a key derived from the secret, and re-checked when read back. The
   browser may keep a response for an hour (`private`).

Missing configuration fails closed with `503`: no token, no limiter binding, or
a limiter or GitHub error. Logs carry a status, a reason and a path, never a
body.

The engine's [`polarFromRelease`](../engine/src/routing/deepPolars.ts) converts
the entry to the router's `speeds_kt[tws][twa]` shape. Passage keeps its
interpolation: fixed angle rows only (best-VMG rows unused), rows and columns
with no speed dropped, no-go below the first stated angle at each wind speed,
gaps interpolated, the last stated speed held past the edge. On 2026-10-11,
for all 3,250 ORC boats, the converted 2026.2 entries matched Passage's former
published polars cell for cell (checked locally; the data is not committed).

## Pin

[`server/deepPolarsPin.mjs`](../server/deepPolarsPin.mjs) and the `releases`
entry of [`contracts/shared-contracts.lock.json`](../contracts/shared-contracts.lock.json)
record release **2026.2** at deep-polars commit `1d1e72e`, with `index.json`
SHA-256 `d9fffe0e…436795e`. `npm run test:functions` fails if they disagree.
A version, a commit and a digest are not polar data. Move to a new release
deliberately: update both, then check the boat list and a routed passage.

## Rate limit

Pages Functions cannot hold Cloudflare's Rate Limiting binding, and a zone rule
would not cover `*.pages.dev`. The [`passage-polar-limiter`](../workers/polar-limiter/)
Worker holds two limits, **30 boat reads** and **10 boat-list reads per client
per 60 s**, and has no public route. Its counts are per Cloudflare location and
approximate. Deploy it by hand after a change, with credentials that can edit
Workers scripts. A `CLOUDFLARE_API_TOKEN` in the environment overrides
`wrangler login`; if that token lacks Workers permissions the deploy fails with
"No access to the specified resource", so leave it out for this command:

```bash
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy --config workers/polar-limiter/wrangler.toml
```

## Configuration (Davi)

In the Pages project `passage`, production (and preview if wanted):

- **Secret** `DEEP_POLARS_TOKEN`: a fine-grained GitHub token, repository
  `deepregatta/deep-polars` only, **Contents: read-only**. Davi creates and
  sets it; agents never see or type it.
- **Service binding** `POLAR_LIMITER` → Worker `passage-polar-limiter`.

Both are dashboard settings: a Pages `wrangler.toml` would take over the
project's build variables (`VITE_*`). A new deployment picks them up.

## Local development

`.dev.vars` at the repository root is gitignored:

```text
DEEP_POLARS_TOKEN=<the read-only token>
POLAR_RATE_LIMIT=off
```

`POLAR_RATE_LIMIT=off` is for local development only; it is the one way to run
without the limiter binding. Build, then start the `pages-functions` launch
configuration (`wrangler pages dev viewer/dist` on port 8789). The Vite dev
server proxies `/api` to it. Without it the planner reports boat polars
unavailable. Tests never read the release: they use invented entries.

## Guard

`npm run check:polars` (in `npm test`) and `npm run build:pages` fail if polar
data comes back; see [Testing](testing.md#no-polar-data).

## History

Polar files were published from 2026-07-12 to 2026-10-11:
`viewer/public/data/polars/` (3,250 boats and an index), `config/polars/`
(two ORC extracts, served under `/data/config/polars/`) and a 20-certificate
ORC test sample. On 2026-10-11 they were removed from the tree and the 345
Pages deployments that served them were deleted. The two public cache prefixes,
`passage.deepregatta.com/data/polars/` and
`passage.deepregatta.com/data/config/polars/`, were purged in Cloudflare.

The Git history rewrite was force-pushed on 2026-10-11. GitHub's published
`main` branch and `review-2026-09-07-baseline` tag were checked: neither retains
history for the three removed paths. At that check the repository had no forks
or pull requests.

Old commit objects still resolved through GitHub's API after the rewrite.
GitHub Support ticket **4846801**, submitted on 2026-10-11, requests removal of
cached old commit/blob views and server-side garbage collection. **That purge
is pending GitHub's confirmation.** A rewritten branch or tag does not prove
that old GitHub views, existing clones or downloaded copies have been erased.

The pre-rewrite backup and commit map are retained outside this checkout in
`~/projects/deepregatta/backups/`. The backup contains polar data and must never
be pushed or uploaded. The local `feat/forecast-tiles` branch also retains the
old paths; do not push it or merge its old history into the rewritten branch.
