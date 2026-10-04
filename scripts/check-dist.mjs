#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const dist = new URL('../viewer/dist/', import.meta.url);
const headers = readFileSync(new URL('_headers', dist), 'utf8');
const redirects = readFileSync(new URL('_redirects', dist), 'utf8');
const sitemap = readFileSync(new URL('sitemap.xml', dist), 'utf8');
for (const path of ['/grib', '/fr/grib']) {
  // A directory index makes Pages redirect the slashless canonical to /.
  assert.ok(!existsSync(new URL(`${path.slice(1)}/index.html`, dist)),
    `${path} must use an HTML file, not a directory index`);
  assert.ok(redirects.split('\n').some((line) => line.trim() === `${path}/ ${path} 308`),
    `${path}/ must redirect to its slashless canonical`);
  for (const served of [path, `${path}.html`]) {
    assert.ok(headers.includes(`${served}\n  Cache-Control: public, max-age=0, must-revalidate, no-transform`),
      `${served} must keep the HTML cache/no-transform policy`);
  }
  const canonical = `https://passage.deepregatta.com${path}`;
  const html = readFileSync(new URL(`${path.slice(1)}.html`, dist), 'utf8');
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}"`));
  assert.ok(html.includes(`property="og:url" content="${canonical}"`));
  assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
  for (const [language, target] of [['en', '/grib'], ['fr', '/fr/grib'], ['x-default', '/grib']]) {
    assert.ok(html.includes(`hreflang="${language}" href="https://passage.deepregatta.com${target}"`));
  }
}

// Check the emitted HTML, including the French entry, after Pages packaging.
for (const entry of ['index.html', 'fr/index.html', 'grib.html', 'fr/grib.html']) {
  const html = readFileSync(new URL(entry, dist), 'utf8');
  const preloads = (html.match(/<link\b[^>]*>/gi) ?? []).filter((tag) =>
    /\brel\s*=\s*["']modulepreload["']/i.test(tag));
  const eagerVendors = preloads.filter((tag) => /vendor-(?:echarts|leaflet)[^"']*\.js/i.test(tag));
  assert.equal(eagerVendors.length, 0,
    `${entry} must not preload lazy chart/map vendors:\n${eagerVendors.join('\n')}`);
  assert.ok(preloads.some((tag) => /vendor-react[^"']*\.js/i.test(tag)),
    `${entry} must preload vendor-react`);
  console.log(`${entry}: React preloaded; chart/map vendors stay lazy`);
}
