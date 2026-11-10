import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY, GRIB_COPY, NO_JS_COPY, ORIGIN, PRIVACY_COPY } from '../src/metadata.js';
import { renderFrenchHtml, renderGribHtml, renderPrivacyHtml } from '../scripts/prerender-fr.mjs';
import { gribInfoTexts } from '../src/gribContent.js';
import { privacyTexts } from '../src/privacyContent.js';
import { translateText } from '../src/i18n.js';

// The transform runs on dist/index.html; Vite keeps the head markup of the
// source page intact, so the committed index.html is a faithful stand-in.
const sourceHtml = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');

describe('crawlable GRIB HTML', () => {
  it.each(['en', 'fr'])('serves route-specific %s metadata and body without JavaScript', (language) => {
    const html = renderGribHtml(sourceHtml, language);
    const page = new DOMParser().parseFromString(html, 'text/html');
    const path = language === 'fr' ? '/fr/grib' : '/grib';
    expect(page.title).toBe(GRIB_COPY[language].title);
    expect(page.documentElement.lang).toBe(language);
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
      expect(page.querySelector(selector).content).toBe(GRIB_COPY[language].description);
    }
    expect(page.querySelector('meta[property="og:title"]').content).toBe(page.title);
    expect(page.querySelector('meta[property="og:url"]').content).toBe(`${ORIGIN}${path}`);
    expect(page.querySelector('link[rel="canonical"]').href).toBe(`${ORIGIN}${path}`);
    expect(page.querySelector('main').textContent).toContain(GRIB_COPY[language].description);
    expect(page.querySelector('main').textContent).toContain(language === 'fr' ? 'pas pour la navigation' : 'not for navigation');
    for (const [code, target] of [['en', '/grib'], ['fr', '/fr/grib'], ['x-default', '/grib']]) {
      expect(page.querySelector(`link[hreflang="${code}"]`).href).toBe(`${ORIGIN}${target}`);
    }
    expect(page.querySelector('body > script').outerHTML).toBe(new DOMParser().parseFromString(sourceHtml, 'text/html').querySelector('body > script').outerHTML);
    const sitemap = readFileSync(resolve(import.meta.dirname, '../public/sitemap.xml'), 'utf8');
    expect(sitemap).toContain(`<loc>${ORIGIN}${path}</loc>`);
  });
});

describe('crawlable GRIB information', () => {
  const mainOf = (language) => new DOMParser().parseFromString(renderGribHtml(sourceHtml, language), 'text/html').querySelector('main');

  it.each(['en', 'fr'])('puts the whole %s information section in <main>, after the heading and notice', (language) => {
    const main = mainOf(language);
    expect(main.querySelectorAll('h1')).toHaveLength(1);
    const body = main.textContent;
    for (const english of gribInfoTexts()) expect(body).toContain(translateText(english, language));
    // the tool-first order: h1, intro and notice come before the information
    const headings = [...main.querySelectorAll('h1, h2')].map((node) => node.textContent);
    expect(headings[0]).toBe(language === 'fr' ? 'Télécharger des fichiers GRIB' : 'Download GRIB files');
    expect(headings).toHaveLength(8);
    expect(main.querySelector('a[href$="privacy"]').getAttribute('href')).toBe(language === 'fr' ? '/fr/privacy' : '/privacy');
  });

  it('states the models, what the files hold and omit, and each program honestly in English', () => {
    const body = mainOf('en').textContent;
    for (const text of ['ECMWF: the default when the centre of your box is in Europe', 'AROME (Météo-France), optional', 'ICON-EU (DWD), optional',
      'GFS-Wave (NOAA/NCEP) is the only wave model', 'IBI (Copernicus Marine)', 'GLO12', 'No pressure or isobars, rain, temperature',
      'Wind + currents file', 'Adrena: read the wind and currents files', 'OpenCPN (GRIB plugin)', 'It drops swell and the primary wave period and direction',
      'XyGrib: choose File > Open. Not yet tested in the application', 'qtVlm: load the wind file in one GRIB slot', 'Not for navigation',
      'refused with “Choose a smaller area for this regional model.”', 'Forecast data for planning, not for navigation.']) {
      expect(body).toContain(text);
    }
  });

  it('states the same facts in French without English leftovers', () => {
    const body = mainOf('fr').textContent;
    for (const text of ['ECMWF : choix par défaut', 'Fichier vent + courants', 'Pas encore testé dans l’application', 'Ni pression ni isobares',
      'la houle', 'Politique de confidentialité', 'pas pour la navigation']) {
      expect(body).toContain(text);
    }
    for (const english of ['Which models are used', 'What is not in the files', 'Not yet tested', 'Opening the files in your software', 'Draw a smaller box']) {
      expect(body).not.toContain(english);
    }
  });

  it('is longer than the old two-sentence body, by a wide margin', () => {
    for (const language of ['en', 'fr']) expect(mainOf(language).textContent.length).toBeGreaterThan(6000);
  });
});

describe('crawlable privacy HTML', () => {
  it.each(['en', 'fr'])('serves the %s policy text, head and hreflang without JavaScript', (language) => {
    const html = renderPrivacyHtml(sourceHtml, language);
    const page = new DOMParser().parseFromString(html, 'text/html');
    const path = language === 'fr' ? '/fr/privacy' : '/privacy';
    expect(page.title).toBe(PRIVACY_COPY[language].title);
    expect(page.documentElement.lang).toBe(language);
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      expect(page.querySelector(selector).content).toBe(PRIVACY_COPY[language].description);
    }
    expect(page.querySelector('meta[property="og:title"]').content).toBe(page.title);
    expect(page.querySelector('meta[property="og:url"]').content).toBe(`${ORIGIN}${path}`);
    expect(page.querySelector('meta[property="og:locale"]').content).toBe(language === 'fr' ? 'fr_FR' : 'en_GB');
    expect(page.querySelector('link[rel="canonical"]').href).toBe(`${ORIGIN}${path}`);
    for (const [code, target] of [['en', '/privacy'], ['fr', '/fr/privacy'], ['x-default', '/privacy']]) {
      expect(page.querySelector(`link[hreflang="${code}"]`).href).toBe(`${ORIGIN}${target}`);
    }
    const data = JSON.parse(page.querySelector('#passage-structured-data').textContent);
    expect(data).toMatchObject({ '@type': 'WebPage', url: `${ORIGIN}${path}`, inLanguage: language });
    // The whole notice is in <main>, every block in the page's language.
    const main = page.querySelector('main');
    expect(main.querySelectorAll('h1')).toHaveLength(1);
    const body = main.textContent;
    for (const english of privacyTexts()) expect(body).toContain(translateText(english, language));
    expect(body).toContain(language === 'fr' ? 'Le responsable du traitement est Davi Silva de Vasconcellos' : 'The data controller is Davi Silva de Vasconcellos');
    expect(body).toContain('contact@deepregatta.com');
    expect(body).toContain('tile.openstreetmap.org');
    expect(body).not.toContain('Passage audits the weather along your intended route');
    expect(page.querySelector('body > script').outerHTML).toBe(new DOMParser().parseFromString(sourceHtml, 'text/html').querySelector('body > script').outerHTML);
    expect(readFileSync(resolve(import.meta.dirname, '../public/sitemap.xml'), 'utf8')).toContain(`<loc>${ORIGIN}${path}</loc>`);
  });

  it('keeps English out of the French page', () => {
    const body = new DOMParser().parseFromString(renderPrivacyHtml(sourceHtml, 'fr'), 'text/html').querySelector('main').textContent;
    for (const english of ['What your browser sends', 'Usage measurement', 'Your rights', 'Feedback form', 'Passage sets no cookies']) {
      expect(body).not.toContain(english);
    }
  });

  it('fails the build when the built HTML no longer matches expectations', () => {
    expect(() => renderPrivacyHtml('<html lang="en"><head></head></html>', 'en')).toThrow(/prerender-fr:/);
  });
});

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
