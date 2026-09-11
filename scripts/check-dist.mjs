#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Check the emitted HTML, including the French entry, after Pages packaging.
for (const entry of ['index.html', 'fr/index.html']) {
  const html = readFileSync(new URL(`../viewer/dist/${entry}`, import.meta.url), 'utf8');
  const preloads = (html.match(/<link\b[^>]*>/gi) ?? []).filter((tag) =>
    /\brel\s*=\s*["']modulepreload["']/i.test(tag));
  const eagerVendors = preloads.filter((tag) => /vendor-(?:echarts|leaflet)[^"']*\.js/i.test(tag));
  assert.equal(eagerVendors.length, 0,
    `${entry} must not preload lazy chart/map vendors:\n${eagerVendors.join('\n')}`);
  assert.ok(preloads.some((tag) => /vendor-react[^"']*\.js/i.test(tag)),
    `${entry} must preload vendor-react`);
  console.log(`${entry}: React preloaded; chart/map vendors stay lazy`);
}
