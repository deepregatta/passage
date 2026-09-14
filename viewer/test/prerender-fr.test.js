import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY, NO_JS_COPY, ORIGIN } from '../src/metadata.js';
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

  it('translates the complete static body, including the planning-aid caveat', () => {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const source = new DOMParser().parseFromString(sourceHtml, 'text/html');
    const main = page.querySelector('#root > main');
    expect(main.querySelector('h1').textContent).toBe('Passage par DeepRegatta');
    expect([...main.querySelectorAll('h2')].map(node => node.textContent)).toEqual([
      'Comment fonctionne une analyse de traversée',
      'Essayez avec une route exemple',
      'Ce que Passage est — et ce qu’il n’est pas',
    ]);
    expect(main.querySelectorAll('ol > li')).toHaveLength(5);
    expect([...main.querySelectorAll('h1, h2, p, li')].map(node => node.textContent.trim())).toEqual(
      NO_JS_COPY.map(({ fr }) => fr),
    );
    expect(main.textContent).toContain('Il ne remplace ni les prévisions à jour, ni les avertissements maritimes officiels, ni le jugement du chef de bord.');
    for (const node of source.querySelectorAll('main h1, main h2, main p, main li')) {
      expect(main.textContent.replace(/\s+/g, ' ')).not.toContain(node.textContent.replace(/\s+/g, ' ').trim());
    }
    // Preserve the mount point, semantic structure and application scripts.
    expect([...main.querySelectorAll('*')].map(node => node.tagName)).toEqual(
      [...source.querySelectorAll('main *')].map(node => node.tagName),
    );
    expect(page.querySelectorAll('#root')).toHaveLength(1);
    expect(page.querySelector('body > script').outerHTML).toBe(source.querySelector('body > script').outerHTML);
  });

  it.each([
    ['missing', sourceHtml.replace(/<main>[\s\S]*?<\/main>/, '')],
    ['duplicate', sourceHtml.replace('</main>', '</main><main>Duplicate</main>')],
    ['new text', sourceHtml.replace('</main>', '<p>A newly added sentence.</p></main>')],
    ['changed text', sourceHtml.replace('How a passage audit works', 'How the audit works')],
    ['missing text', sourceHtml.replace('<h2>How a passage audit works</h2>', '')],
    ['duplicate text', sourceHtml.replace('</main>', '<h2>How a passage audit works</h2></main>')],
  ])('rejects an incomplete translation when the static body has %s', (_name, input) => {
    expect(() => renderFrenchHtml(input)).toThrow(/prerender-fr:/);
  });

  it('accepts whitespace compaction by the build without changing the translation', () => {
    const compact = sourceHtml.replace(/\s+/g, ' ');
    const page = new DOMParser().parseFromString(renderFrenchHtml(compact), 'text/html');
    expect([...page.querySelectorAll('main h1, main h2, main p, main li')].map(node => node.textContent.trim())).toEqual(
      NO_JS_COPY.map(({ fr }) => fr),
    );
  });

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
