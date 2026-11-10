import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { getInitialLanguage, translateText } from '../src/i18n.js';
import { standalonePage, parseRoute, pageHash } from '../src/lib/routes.js';
import { PRIVACY_BLOCKS, privacyHtml, privacyTexts } from '../src/privacyContent.js';

const text = () => privacyTexts().join('\n');

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  history.replaceState(null, '', '/');
  document.documentElement.lang = 'en';
});

describe('privacy route', () => {
  it.each([
    ['/privacy', 'privacy'], ['/privacy/', 'privacy'], ['/fr/privacy', 'privacy'], ['/grib', 'grib'], ['/fr/grib', 'grib'],
    ['/', null], ['/fr/', null], ['/privacy/extra', null], ['/privacyx', null],
  ])('recognises %s as the standalone page %s', (path, page) => {
    expect(standalonePage(path)).toBe(page);
  });

  it('keeps a hash route for the privacy page too', () => {
    expect(parseRoute('#privacy').page).toBe('privacy');
    expect(pageHash('privacy')).toBe('privacy');
  });

  it('opens in English on /privacy whatever the saved language, and in French on /fr/privacy', () => {
    localStorage.setItem('passage-language', 'fr');
    history.replaceState(null, '', '/privacy');
    expect(getInitialLanguage()).toBe('en');
    history.replaceState(null, '', '/fr/privacy');
    expect(getInitialLanguage()).toBe('fr');
  });

  it('renders the English policy at /privacy, with the controller, contact and full-policy link', async () => {
    history.replaceState(null, '', '/privacy');
    useApp.setState({ language: 'en', page: 'privacy' });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy policy' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'In short', 'Who is responsible', 'What your browser sends when you use Passage', 'Usage measurement',
      'Feedback form', 'What stays in your browser', 'Who receives data', 'Your rights',
    ]);
    const article = screen.getByRole('article');
    expect(article.textContent).toContain('Davi Silva de Vasconcellos, operating DeepRegatta');
    expect(article.textContent).toContain('Paris, France');
    expect(within(article).getAllByRole('link', { name: 'contact@deepregatta.com' })[0].getAttribute('href')).toBe('mailto:contact@deepregatta.com');
    expect(within(article).getByRole('link', { name: 'Read the full DeepRegatta privacy policy' }).getAttribute('href')).toBe('https://deepregatta.com/privacy');
  });

  it('renders the same policy in French through the i18n catalogue', async () => {
    history.replaceState(null, '', '/fr/privacy');
    useApp.setState({ language: 'fr', page: 'privacy' });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Politique de confidentialité' })).toBeTruthy();
    const article = screen.getByRole('article');
    expect(article.textContent).toContain('Le responsable du traitement est Davi Silva de Vasconcellos, exploitant DeepRegatta.');
    expect(article.textContent).not.toContain('What your browser sends');
    expect(within(article).getByRole('link', { name: 'Lire la politique de confidentialité complète de DeepRegatta' }).getAttribute('href')).toBe('https://deepregatta.com/fr/privacy');
  });

  it('links the footer Privacy entry to the matching language page', async () => {
    history.replaceState(null, '', '/#plan');
    useApp.setState({ language: 'en', page: 'planner' });
    const { unmount } = render(<App />);
    expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
    unmount();
    useApp.setState({ language: 'fr', page: 'planner' });
    render(<App />);
    expect(screen.getByRole('link', { name: 'Confidentialité' }).getAttribute('href')).toBe('/fr/privacy');
  });
});

describe('privacy copy', () => {
  it('has a French translation for every English string', () => {
    for (const english of privacyTexts()) expect(translateText(english, 'fr'), english).not.toBe(english);
  });

  it('stays free of the internal codename and of storage the app does not use', () => {
    expect(text().toLowerCase()).not.toContain('deepweather');
    expect(text()).not.toMatch(/cookie banner|google analytics|advertis\w+ cookie/i);
  });

  it('names every third-party host the Content-Security-Policy lets the browser reach', () => {
    const headers = readFileSync(resolve(import.meta.dirname, '../public/_headers'), 'utf8');
    const csp = headers.match(/Content-Security-Policy: (.*)/)[1];
    // The CSP still allows Cloudflare Web Analytics, but no beacon is shipped
    // (scripts/build-pages.mjs); adding one needs this page and the CSP to agree.
    const unused = new Set(['cloudflareinsights.com', 'static.cloudflareinsights.com']);
    const hosts = [...new Set([...csp.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((match) => match[1]))].filter((host) => !unused.has(host));
    expect(hosts.sort()).toEqual(['forecast.deepregatta.com', 'oscar.deepregatta.com', 'tile.openstreetmap.org', 'tiles.openseamap.org']);
    for (const host of hosts) expect(text(), host).toContain(host);
  });

  it('renders the same body as static HTML (the prerender source) in both languages', () => {
    for (const language of ['en', 'fr']) {
      const page = new DOMParser().parseFromString(`<main>${privacyHtml(language, translateText)}</main>`, 'text/html');
      expect(page.querySelectorAll('h1')).toHaveLength(1);
      expect(page.querySelectorAll('h2')).toHaveLength(PRIVACY_BLOCKS.filter((block) => block.type === 'h2').length);
      const link = page.querySelector('a[href^="https://deepregatta.com"]');
      expect(link.getAttribute('href')).toBe(language === 'fr' ? 'https://deepregatta.com/fr/privacy' : 'https://deepregatta.com/privacy');
    }
  });
});
