import { useEffect } from 'react';

const ORIGIN = 'https://passage.deepregatta.com';
const IMAGE = `${ORIGIN}/share/default.png`;

const COPY = {
  en: {
    title: 'Passage — Explainable passage-weather planning',
    description: 'Plan sailing passages with live weather routing, explainable forecast risk, departure-window comparisons, and route-specific briefings from DeepRegatta.',
    imageAlt: 'Passage weather-planning share card from DeepRegatta',
  },
  fr: {
    title: 'Passage — Planification météo explicable',
    description: 'Planifiez vos traversées avec routage météo, analyse explicable des risques, comparaison des départs et briefings adaptés à votre route avec DeepRegatta.',
    imageAlt: 'Carte de partage Passage pour la planification météo par DeepRegatta',
  },
};

function softwareApplication(language, description) {
  const isFrench = language === 'fr';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Passage',
    applicationCategory: 'WeatherApplication',
    operatingSystem: 'Web',
    url: `${ORIGIN}/${isFrench ? '?lang=fr' : ''}`,
    description,
    inLanguage: isFrench ? 'fr' : 'en',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'EUR',
    },
    publisher: {
      '@type': 'Organization',
      name: 'DeepRegatta',
      url: 'https://deepregatta.com/',
    },
  };
}

function setMeta(selector, attributes, content) {
  let element = document.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

export function HeadMetadata({ language }) {
  useEffect(() => {
    const metadata = COPY[language === 'fr' ? 'fr' : 'en'];
    document.title = `${metadata.title} | DeepRegatta`;
    document.documentElement.lang = language;
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', `${ORIGIN}/`);
    setMeta('meta[name="description"]', { name: 'description' }, metadata.description);
    setMeta('meta[property="og:title"]', { property: 'og:title' }, metadata.title);
    setMeta('meta[property="og:description"]', { property: 'og:description' }, metadata.description);
    setMeta('meta[property="og:url"]', { property: 'og:url' }, `${ORIGIN}/`);
    setMeta('meta[property="og:image"]', { property: 'og:image' }, IMAGE);
    setMeta('meta[property="og:image:alt"]', { property: 'og:image:alt' }, metadata.imageAlt);
    setMeta('meta[property="og:locale"]', { property: 'og:locale' }, language === 'fr' ? 'fr_FR' : 'en_GB');
    setMeta('meta[name="twitter:title"]', { name: 'twitter:title' }, metadata.title);
    setMeta('meta[name="twitter:description"]', { name: 'twitter:description' }, metadata.description);
    setMeta('meta[name="twitter:image"]', { name: 'twitter:image' }, IMAGE);
    const structuredData = document.getElementById('passage-structured-data');
    if (structuredData) {
      structuredData.textContent = JSON.stringify(
        softwareApplication(language, metadata.description)
      );
    }
  }, [language]);

  return null;
}
