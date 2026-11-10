// Shared page metadata and static fallback translations (title/description/OG/Twitter/
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

export const GRIB_COPY = {
  en: {
    ...COPY.en,
    title: 'Free GRIB files: wind, waves and currents | Passage',
    description: 'Download free GRIB2 files for wind, waves and currents. Choose your sailing area and forecast period in Passage.',
  },
  fr: {
    ...COPY.fr,
    title: 'Fichiers GRIB gratuits : vent, vagues et courants | Passage',
    description: 'Téléchargez gratuitement des fichiers GRIB2 de vent, vagues et courants. Choisissez votre zone de navigation et la période de prévision dans Passage.',
  },
};

export const PRIVACY_COPY = {
  en: {
    ...COPY.en,
    title: 'Privacy policy | Passage',
    description: 'What Passage does with personal data: no accounts or ads, routes and briefings kept in your browser, first-party usage counts and the services your browser contacts.',
  },
  fr: {
    ...COPY.fr,
    title: 'Politique de confidentialité | Passage',
    description: 'Ce que Passage fait des données personnelles : ni comptes ni publicité, routes et briefings conservés dans votre navigateur, mesure d’usage propriétaire et services contactés par votre navigateur.',
  },
};

// Pages with their own crawlable URL and complete document title.
const STANDALONE_COPY = { grib: GRIB_COPY, privacy: PRIVACY_COPY };
export const pageCopy = (page) => STANDALONE_COPY[page] ?? COPY;
// In-app pages (same URL, hash-routed) each name themselves in the tab, after the
// brand. The planner keeps the product title that index.html and the French
// prerender ship, so crawlers and the hydrated page agree on the front door.
const APP_TITLES = {
  passages: { en: 'My passages', fr: 'Mes traversées' },
  briefing: { en: 'Passage briefing', fr: 'Briefing de traversée' },
  example: { en: 'Example passage', fr: 'Exemple de traversée' },
  about: { en: 'About the data', fr: 'À propos des données' },
};
const TITLE_BRAND = { en: 'Passage by DeepRegatta', fr: 'Passage par DeepRegatta' };

/** `detail` ({ route, departure }) names a loaded passage on the briefing page;
 * both are display strings already localised by the caller. */
export const documentTitle = (language, page, detail = null) => {
  const code = language === 'fr' ? 'fr' : 'en';
  if (page in STANDALONE_COPY) return pageCopy(page)[code].title;
  const own = APP_TITLES[page];
  if (!own) return `${COPY[code].title} | DeepRegatta`;
  const name = page === 'briefing' && detail?.route
    ? `${detail.route}${detail.departure ? (code === 'fr' ? `, départ le ${detail.departure}` : `, departing ${detail.departure}`) : ''}`
    : own[code];
  return `${name} · ${TITLE_BRAND[code]}`;
};

// Complete static fallback copy. English entries mirror index.html; the prerender
// rejects unknown, missing or repeated text so source edits cannot silently leak English.
export const NO_JS_COPY = [
  {
    en: "Passage by DeepRegatta",
    fr: "Passage par DeepRegatta",
  },
  {
    en: "Explainable weather planning for offshore sailing passages.",
    fr: "Une planification météo explicable pour les traversées au large.",
  },
  {
    en: "Passage audits the weather along your intended route before you commit to a departure. Instead of a single deterministic forecast, it shows you the conditions each leg is likely to meet, how much the forecast models disagree, and which assumptions the verdict depends on — so the go/no-go call stays yours, made with open eyes.",
    fr: "Passage analyse la météo le long de votre route prévue avant que vous ne décidiez de partir. Au-delà d’une seule prévision déterministe, il montre les conditions probables sur chaque tronçon, les désaccords entre modèles météo et les hypothèses dont dépend le verdict — afin que la décision de partir ou non reste la vôtre, en connaissance de cause.",
  },
  {
    en: "How a passage audit works",
    fr: "Comment fonctionne une analyse de traversée",
  },
  {
    en: "Enter or select a departure point and destination to sketch your route.",
    fr: "Saisissez ou sélectionnez un point de départ et une destination pour tracer votre route.",
  },
  {
    en: "Choose a departure time, or scan a window of candidate departures to compare them.",
    fr: "Choisissez une heure de départ, ou explorez une plage de départs possibles pour les comparer.",
  },
  {
    en: "Inspect wind, tide, and current along each leg, the ensemble spread across forecast models, and alternative timings for the same route.",
    fr: "Examinez le vent, la marée et le courant sur chaque tronçon, la dispersion des prévisions d’ensemble et d’autres horaires pour la même route.",
  },
  {
    en: "Review the briefing's uncertainty and assumptions: active warnings, where models diverge, and how recent forecasts have shifted.",
    fr: "Examinez les incertitudes et les hypothèses du briefing : avertissements en cours, divergences entre modèles et évolution des prévisions récentes.",
  },
  {
    en: "Save the briefing as a snapshot to keep the decision context — the forecast evidence as it stood when you made the call.",
    fr: "Enregistrez le briefing pour conserver le contexte de la décision — les éléments météo tels qu’ils étaient au moment de votre choix.",
  },
  {
    en: "Try it with an example route",
    fr: "Essayez avec une route exemple",
  },
  {
    en: "A ready-made briefing for a Cherbourg to Plymouth crossing is built in. Open it from My passages, where it is marked \"example\", to explore the full audit — route timeline, tidal gates, warnings, and forecast evidence — without entering any personal data or creating an account.",
    fr: "Un briefing prêt à consulter pour une traversée de Cherbourg à Plymouth est inclus. Ouvrez-le depuis « Mes traversées », où il est marqué « exemple », pour explorer l’analyse complète — chronologie de la route, passages de marée, avertissements et éléments météo — sans saisir de données personnelles ni créer de compte.",
  },
  {
    en: "What Passage is — and is not",
    fr: "Ce que Passage est — et ce qu’il n’est pas",
  },
  {
    en: "Passage is a planning aid. It does not replace a current forecast, official marine warnings, or the skipper's judgment. Official marine forecasts remain the authority of record; always check them before departure, and treat every Passage verdict as evidence for your decision, not the decision itself.",
    fr: "Passage est une aide à la planification. Il ne remplace ni les prévisions à jour, ni les avertissements maritimes officiels, ni le jugement du chef de bord. Les bulletins météo maritimes officiels font autorité ; consultez-les toujours avant le départ et considérez chaque verdict de Passage comme un élément pour éclairer votre décision, jamais comme la décision elle-même.",
  },
];

export function pageUrl(language, page) {
  if (page === 'grib' || page === 'privacy') return `${ORIGIN}${language === 'fr' ? '/fr' : ''}/${page}`;
  return language === 'fr' ? `${ORIGIN}/fr/` : `${ORIGIN}/`;
}

export function ogLocale(language) {
  return language === 'fr' ? 'fr_FR' : 'en_GB';
}

export function softwareApplication(language, page) {
  const isFrench = language === 'fr';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Passage',
    applicationCategory: 'WeatherApplication',
    operatingSystem: 'Web',
    url: pageUrl(language, page),
    description: pageCopy(page)[isFrench ? 'fr' : 'en'].description,
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

/** Head JSON-LD for a page: the application, or a WebPage for the privacy policy. */
export function structuredData(language, page) {
  if (page !== 'privacy') return softwareApplication(language, page);
  const isFrench = language === 'fr';
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: PRIVACY_COPY[isFrench ? 'fr' : 'en'].title,
    url: pageUrl(language, page),
    description: PRIVACY_COPY[isFrench ? 'fr' : 'en'].description,
    inLanguage: isFrench ? 'fr' : 'en',
    isPartOf: { '@type': 'WebSite', name: 'Passage', url: `${ORIGIN}/` },
    publisher: { '@type': 'Organization', name: 'DeepRegatta', url: 'https://deepregatta.com/' },
  };
}
