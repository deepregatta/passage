// Static server for the browser responsiveness measurement and for a phone:
// the production build of the viewer (output/perf/viewer-dist) plus the
// synthetic forecast files (output/perf/fixtures: /forecast/* and /api/polars/*).
// No product code, no network, nothing public. Prepare both with `npm run perf:prepare`.
//
//   npm run perf:serve                 http://127.0.0.1:5194/#plan
//   PASSAGE_PERF_PORT=5195 npm run perf:serve
//   PASSAGE_PERF_FIXTURES=fixtures-live npm run perf:serve     the real-clock files, for a phone
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../../../output/perf');
const dist = path.join(root, 'viewer-dist');
const fixtures = path.join(root, process.env.PASSAGE_PERF_FIXTURES ?? 'fixtures'); // fixtures-live for a phone
const config = path.resolve(root, '../../config'); // the committed limits defaults the planner reads from /data/config
const port = Number(process.env.PASSAGE_PERF_PORT ?? process.env.PASSAGE_E2E_PORT ?? 5194);
const host = process.env.PASSAGE_PERF_HOST ?? '127.0.0.1';

if (!existsSync(path.join(dist, 'index.html')) || !existsSync(path.join(fixtures, 'meta.json'))) {
  console.error('Missing output/perf/viewer-dist or output/perf/fixtures. Run: npm run perf:prepare');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.startsWith('/data/config/')) {
    const target = path.resolve(config, `./${clean.slice('/data/config/'.length)}`);
    return target.startsWith(config + path.sep) && existsSync(target) && statSync(target).isFile() ? target : null;
  }
  if (clean === '/probe.js') return path.join(import.meta.dirname, 'probe.js');
  const inFixtures = clean.startsWith('/forecast/') || clean.startsWith('/api/polars/') || clean === '/meta.json';
  const base = inFixtures ? fixtures : dist;
  const target = path.resolve(base, `.${clean === '/' ? '/index.html' : clean}`);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

http.createServer((req, res) => {
  const file = resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const isPolar = file.includes(`${path.sep}api${path.sep}polars${path.sep}`);
  res.writeHead(200, {
    'Content-Type': isPolar ? 'application/json' : TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, host, () => console.log(`perf server on http://${host}:${port}/#plan`));
