import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY, ORIGIN } from '../src/metadata.js';
import { renderFrenchHtml } from '../scripts/prerender-fr.mjs';

// The transform runs on dist/index.html; Vite keeps the head markup of the
// source page intact, so the committed index.html is a faithful stand-in.
const sourceHtml = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');

describe('static EN head', () => {
  it('stays in sync with the shared metadata table', () => {
    expect(sourceHtml).toContain(`<title>${COPY.en.title} | DeepRegatta</title>`);
    expect(sourceHtml).toContain(COPY.en.description);
    expect(sourceHtml).toContain(COPY.en.imageAlt);
  });

  it('declares reciprocal hreflang alternates', () => {
    expect(sourceHtml).toContain(`<link rel="alternate" hreflang="en" href="${ORIGIN}/" />`);
    expect(sourceHtml).toContain(`<link rel="alternate" hreflang="fr" href="${ORIGIN}/fr/" />`);
    expect(sourceHtml).toContain(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`);
  });
});

describe('French prerender transform', () => {
  const html = renderFrenchHtml(sourceHtml);

  it('serves the French title, description and lang without JS', () => {
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain(`<title>${COPY.fr.title} | DeepRegatta</title>`);
    expect(html).toContain(COPY.fr.description);
    expect(html).not.toContain(COPY.en.title);
    expect(html).not.toContain(COPY.en.description);
  });

  it('points canonical, og:url and og:locale at the French page', () => {
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/fr/" />`);
    expect(html).toContain(`content="${ORIGIN}/fr/"`);
    expect(html).toContain('content="fr_FR"');
    expect(html).not.toContain('content="en_GB"');
  });

  it('localises the social card and structured data', () => {
    expect(html).toContain(COPY.fr.imageAlt);
    const structured = html.match(/<script id="passage-structured-data"[^>]*>\s*([\s\S]*?)\s*<\/script>/)[1];
    const data = JSON.parse(structured);
    expect(data.inLanguage).toBe('fr');
    expect(data.url).toBe(`${ORIGIN}/fr/`);
    expect(data.description).toBe(COPY.fr.description);
  });

  it('keeps both hreflang alternates so the pages stay reciprocal', () => {
    expect(html).toContain(`hreflang="en" href="${ORIGIN}/"`);
    expect(html).toContain(`hreflang="fr" href="${ORIGIN}/fr/"`);
    expect(html).toContain(`hreflang="x-default" href="${ORIGIN}/"`);
  });

  it('introduces no internal codename in user-facing markup', () => {
    expect(html.toLowerCase()).not.toContain('deepweather');
  });

  it('fails loudly when the built HTML no longer matches expectations', () => {
    expect(() => renderFrenchHtml('<html lang="en"><head></head></html>')).toThrow(/expected exactly one match/);
  });
});
