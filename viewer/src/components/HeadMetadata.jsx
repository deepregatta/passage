import { useEffect } from 'react';
import { COPY, GRIB_COPY, SHARE_IMAGE, ogLocale, pageUrl, softwareApplication } from '../metadata.js';

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
    const metadata = (page === 'grib' ? GRIB_COPY : COPY)[language === 'fr' ? 'fr' : 'en'];
    const url = pageUrl(language, page);
    document.title = page === 'grib' ? metadata.title : `${metadata.title} | DeepRegatta`;
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
    const structuredData = document.getElementById('passage-structured-data');
    if (structuredData) {
      structuredData.textContent = JSON.stringify(softwareApplication(language, page));
    }
  }, [language, page]);

  return null;
}
