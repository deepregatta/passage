// Single source of truth for page metadata (title/description/OG/Twitter/
// structured data) in both languages. Consumed by three layers that must stay
// in sync: the static EN head in index.html (checked by test/prerender-fr.test.js),
// the client-side HeadMetadata component, and the build-time French prerender
// (scripts/prerender-fr.mjs). Keep this module DOM-free so Node can import it.

export const ORIGIN = 'https://passage.deepregatta.com';
export const SHARE_IMAGE = `${ORIGIN}/share/default.png`;

export const COPY = {
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

export function pageUrl(language) {
  return language === 'fr' ? `${ORIGIN}/fr/` : `${ORIGIN}/`;
}

export function ogLocale(language) {
  return language === 'fr' ? 'fr_FR' : 'en_GB';
}

export function softwareApplication(language) {
  const isFrench = language === 'fr';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Passage',
    applicationCategory: 'WeatherApplication',
    operatingSystem: 'Web',
    url: pageUrl(language),
    description: COPY[isFrench ? 'fr' : 'en'].description,
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
