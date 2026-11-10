import { useEffect } from 'react';
import { SHARE_IMAGE, documentTitle, ogLocale, pageCopy, pageUrl, structuredData } from '../metadata.js';

function setMeta(selector, attributes, content) {
  let element = document.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

export function HeadMetadata({ language, page }) {
  useEffect(() => {
    const metadata = pageCopy(page)[language === 'fr' ? 'fr' : 'en'];
    const url = pageUrl(language, page);
    document.title = documentTitle(language, page);
    document.documentElement.lang = language;
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
    for (const code of ['en', 'fr', 'x-default']) {
      document.querySelector(`link[rel="alternate"][hreflang="${code}"]`)
        ?.setAttribute('href', pageUrl(code === 'fr' ? 'fr' : 'en', page));
    }
    setMeta('meta[name="description"]', { name: 'description' }, metadata.description);
    setMeta('meta[property="og:title"]', { property: 'og:title' }, metadata.title);
    setMeta('meta[property="og:description"]', { property: 'og:description' }, metadata.description);
    setMeta('meta[property="og:url"]', { property: 'og:url' }, url);
    setMeta('meta[property="og:image"]', { property: 'og:image' }, SHARE_IMAGE);
    setMeta('meta[property="og:image:alt"]', { property: 'og:image:alt' }, metadata.imageAlt);
    setMeta('meta[property="og:locale"]', { property: 'og:locale' }, ogLocale(language));
    setMeta('meta[name="twitter:title"]', { name: 'twitter:title' }, metadata.title);
    setMeta('meta[name="twitter:description"]', { name: 'twitter:description' }, metadata.description);
    setMeta('meta[name="twitter:image"]', { name: 'twitter:image' }, SHARE_IMAGE);
    const jsonLd = document.getElementById('passage-structured-data');
    if (jsonLd) {
      jsonLd.textContent = JSON.stringify(structuredData(language, page));
    }
  }, [language, page]);

  return null;
}
