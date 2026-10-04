#!/usr/bin/env node

// Serve viewer/dist the way Cloudflare Pages does: GET/HEAD only (anything
// else answers 405), SPA fallback for extension-less paths, genuine 404s for
// missing data artifacts. Use it to verify static-hosting behavior that the
// dev middleware masks (e.g. snapshot persistence falling back to the
// browser). Build first: npm run build:pages (uses the public forecast host).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'dist');
const port = Number(process.env.PORT ?? 8788);
// The packaged rules are exact-path redirects. Keep the local build check
// faithful to Pages, including the complete campaign/area query string.
const redirects = (await readFile(join(root, '_redirects'), 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return ''; // Unit guards also import this before a build.
  throw error;
})).split('\n')
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split(/\s+/));
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.gz': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }
  let pathname;
  let url;
  try {
    url = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const redirect = redirects.find(([source]) => source === pathname);
  if (redirect) {
    res.writeHead(Number(redirect[2] ?? 302), { Location: `${redirect[1]}${url.search}` }).end();
    return;
  }
  // Pages resolves directory requests to their index.html (e.g. /fr/)
  let file = normalize(join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body;
    try {
      body = await readFile(file);
    } catch {
      if (extname(pathname)) throw new Error('not found');
      try {
        file = join(root, `${pathname}.html`);
        body = await readFile(file);
      } catch {
        try {
          file = join(root, pathname, 'index.html');
          body = await readFile(file);
        } catch {
          file = join(root, 'index.html');
          body = await readFile(file);
        }
      }
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Pages-like static server for ${root} on http://localhost:${port}`));
