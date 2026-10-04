#!/usr/bin/env node
// Emits the French root and EN/FR GRIB entries with route-specific heads and bodies, so
// non-JS scrapers (link previews) and Google's English-Accept-Language crawler
// see the route's content without hydration. Strings come from src/metadata.js,
// which also supplies the client-side HeadMetadata.jsx component.
// Runs after `vite build` (wired into the viewer build script).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COPY, GRIB_COPY, NO_JS_COPY, ogLocale, pageUrl, softwareApplication } from '../src/metadata.js';
import { GRIB_EXPORT_NOTICE } from '@deepweather/engine';
import { translateText } from '../src/i18n.js';

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Every rewrite must land exactly once; anything else means the built HTML no
// longer looks like this script expects, and silently shipping a half-French
// page would be worse than failing the build. `replacement` is always a
// function so capture groups need no $n expansion.
function replaceOnce(html, pattern, replacement, what) {
  let count = 0;
  const next = html.replace(pattern, (...args) => {
    count += 1;
    return replacement(...args);
  });
  if (count !== 1) throw new Error(`prerender-fr: expected exactly one match for ${what}, got ${count}`);
  return next;
}

function setMetaContent(html, attribute, name, content) {
  return replaceOnce(
    html,
    new RegExp(`(<meta[^>]*${attribute}="${name}"[^>]*content=")[^"]*(")`),
    (_match, before, after) => `${before}${escapeHtml(content)}${after}`,
    `meta ${attribute}="${name}"`,
  );
}

export function renderFrenchHtml(html) {
  const fr = COPY.fr;
  const url = pageUrl('fr');
  let out = replaceOnce(html, /(<html[^>]*lang=")en(")/, (_match, before, after) => `${before}fr${after}`, 'html lang');
  out = replaceOnce(out, /<title>[^<]*<\/title>/, () => `<title>${escapeHtml(fr.title)} | DeepRegatta</title>`, 'title');
  out = replaceOnce(out, /(<link rel="canonical" href=")[^"]*(")/, (_match, before, after) => `${before}${url}${after}`, 'canonical');
  out = setMetaContent(out, 'name', 'description', fr.description);
  out = setMetaContent(out, 'property', 'og:title', fr.title);
  out = setMetaContent(out, 'property', 'og:description', fr.description);
  out = setMetaContent(out, 'property', 'og:url', url);
  out = setMetaContent(out, 'property', 'og:locale', ogLocale('fr'));
  out = setMetaContent(out, 'property', 'og:image:alt', fr.imageAlt);
  out = setMetaContent(out, 'name', 'twitter:title', fr.title);
  out = setMetaContent(out, 'name', 'twitter:description', fr.description);
  out = replaceOnce(
    out,
    /(<script id="passage-structured-data" type="application\/ld\+json">)[\s\S]*?(<\/script>)/,
    (_match, open, close) => `${open}\n      ${JSON.stringify(softwareApplication('fr'))}\n    ${close}`,
    'structured data',
  );
  out = replaceOnce(out, /(<main>)([\s\S]*?)(<\/main>)/g, (_match, open, body, close) => {
    const seen = new Set();
    const translated = `${open}${body}${close}`.replace(/>([^<]+)(?=<)/g, (_textMatch, text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) return `>${text}`;
      const copy = NO_JS_COPY.find(({ en }) => en === normalized || escapeHtml(en) === normalized);
      if (!copy) throw new Error(`prerender-fr: untranslated static body text: ${normalized}`);
      if (seen.has(copy)) throw new Error(`prerender-fr: duplicate static body text: ${normalized}`);
      seen.add(copy);
      return `>${text.replace(text.trim(), () => escapeHtml(copy.fr))}`;
    });
    if (seen.size !== NO_JS_COPY.length) {
      throw new Error(`prerender-fr: expected ${NO_JS_COPY.length} static body translations, got ${seen.size}`);
    }
    return translated;
  }, 'static main body');
  return out;
}

function main() {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  mkdirSync(join(dist, 'fr'), { recursive: true });
  writeFileSync(join(dist, 'fr', 'index.html'), renderFrenchHtml(html));
  for (const language of ['en', 'fr']) {
    // Pages serves *.html at the slashless URL; directory index.html would
    // redirect every canonical/campaign request to a trailing slash.
    const entry = language === 'fr' ? 'fr/grib.html' : 'grib.html';
    writeFileSync(join(dist, entry), renderGribHtml(html, language));
  }
  console.log('Prerendered French entry and EN/FR GRIB entries');
}

export function renderGribHtml(html, language) {
  const copy = GRIB_COPY[language];
  let out = language === 'fr' ? renderFrenchHtml(html) : html;
  out = replaceOnce(out, /<title>[^<]*<\/title>/, () => `<title>${escapeHtml(copy.title)}</title>`, 'GRIB title');
  for (const [attribute, name, content] of [
    ['name', 'description', copy.description],
    ['property', 'og:title', copy.title],
    ['property', 'og:description', copy.description],
    ['property', 'og:url', pageUrl(language, 'grib')],
    ['name', 'twitter:title', copy.title],
    ['name', 'twitter:description', copy.description],
  ]) out = setMetaContent(out, attribute, name, content);
  out = replaceOnce(out, /(<link rel="canonical" href=")[^"]*(")/,
    (_match, before, after) => `${before}${pageUrl(language, 'grib')}${after}`, 'GRIB canonical');
  for (const code of ['en', 'fr', 'x-default']) {
    out = replaceOnce(out, new RegExp(`(<link rel="alternate" hreflang="${code}" href=")[^"]*(")`),
      (_match, before, after) => `${before}${pageUrl(code === 'fr' ? 'fr' : 'en', 'grib')}${after}`, `GRIB alternate ${code}`);
  }
  out = replaceOnce(out, /(<script id="passage-structured-data" type="application\/ld\+json">)[\s\S]*?(<\/script>)/,
    (_match, before, after) => `${before}${JSON.stringify(softwareApplication(language, 'grib'))}${after}`, 'GRIB structured data');
  return replaceOnce(out, /<main>[\s\S]*?<\/main>/g, () =>
    `<main><h1>${escapeHtml(translateText('Download GRIB files', language))}</h1><p>${escapeHtml(copy.description)}</p><p>${escapeHtml(translateText(GRIB_EXPORT_NOTICE, language))}</p></main>`, 'GRIB static body');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
