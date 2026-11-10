// Passage privacy page copy, shared by the React page (pages/Privacy.jsx) and the
// build-time prerender (scripts/prerender-fr.mjs) so a non-JS fetch of /privacy
// and /fr/privacy sees exactly the text the app renders. DOM-free for Node.
//
// English is the source: every string below is a key in the i18n.js catalogue
// (see the "Privacy page" block there). Each block is a single text node so the
// runtime localiser and translateText() agree. Keep it in step with what the
// code actually does; re-audit when analytics events, storage keys or third-party
// hosts change.
//
// Controller details are copied verbatim from the DeepRegatta privacy policy
// (landing/privacy.html, §1); the full policy remains the umbrella notice.

export const CONTACT_EMAIL = 'contact@deepregatta.com';
const FULL_POLICY_URL = { en: 'https://deepregatta.com/privacy', fr: 'https://deepregatta.com/fr/privacy' };
export const fullPolicyUrl = (language) => FULL_POLICY_URL[language === 'fr' ? 'fr' : 'en'];

// Block types: h1, h2, p, ul (items), contact (text + mailto link), link (text + full-policy link).
export const PRIVACY_BLOCKS = [
  { type: 'h1', text: 'Privacy policy' },
  { type: 'p', text: 'This page describes what Passage (passage.deepregatta.com) does with personal data. It is read together with the full DeepRegatta privacy policy, which covers all our products.' },
  { type: 'p', text: 'Last updated: 10 November 2026' },

  { type: 'h2', text: 'In short' },
  { type: 'ul', items: [
    'Passage has no accounts and no advertising, and it uses no third-party analytics or tracking services.',
    'Your routes, limits, boat settings and saved briefings are worked out and kept in your browser. DeepRegatta does not receive them, except the route name and briefing identifier that go with a feedback message if you send one.',
    'Passage counts visits with first-party usage events, described below.',
  ] },

  { type: 'h2', text: 'Who is responsible' },
  { type: 'p', text: 'The data controller is Davi Silva de Vasconcellos, operating DeepRegatta.' },
  { type: 'p', text: 'Address: Paris, France. Full postal address available upon legitimate request by email.' },
  { type: 'contact', text: 'Contact for privacy matters:' },

  { type: 'h2', text: 'What your browser sends when you use Passage' },
  { type: 'ul', items: [
    'Hosting: Passage is served by Cloudflare. Like any web host, Cloudflare receives ordinary request data (your IP address, browser and device information, the time and the address requested) to deliver the pages and keep the service secure.',
    'Forecast data: forecast tiles come from forecast.deepregatta.com, our storage on Cloudflare. A request can show roughly which area you are viewing, but not your route, limits or briefings.',
    'Map tiles: the base map comes from OpenStreetMap’s tile servers (tile.openstreetmap.org) and the sea marks from OpenSeaMap (tiles.openseamap.org). These independent services receive your IP address, browser information and the tiles you view, with the Passage site address as the referrer. We do not control their logs.',
    'Boat polars: when you open the boat search or compute a route, your browser asks Passage’s own server function (/api/polars) for the boat list or one boat’s data, so your IP address and the boat you chose reach that function. To prevent bulk copying, it counts requests per IP address (per /64 network for IPv6) over a sliding minute in a short-lived counter that is deleted after a quiet minute. Passage’s code does not write your address to its logs.',
    'Fonts and scripts load from passage.deepregatta.com itself; no font or script provider is contacted.',
  ] },

  { type: 'h2', text: 'Usage measurement' },
  { type: 'p', text: 'While you use Passage it sends a few usage events to DeepRegatta’s own event endpoint (on oscar.deepregatta.com), which stores them in our database (Supabase). Each event carries:' },
  { type: 'ul', items: [
    'a random visitor identifier and a random session identifier, created in your browser and unrelated to your name, email address or any advertising network;',
    'the event name and product, with a few details of that action: the Passage page viewed, a check started, a briefing or the example opened (with its verdict state), an analysis link shared, a GRIB file prepared (which datasets, time window and size band) or a GRIB next step chosen;',
    'whether you are a new visitor, the campaign tags (utm_) of the link that brought you, if any, and the domain, not the full address, of the page you came from.',
  ] },
  { type: 'p', text: 'Events never contain your route, coordinates, limits, boat or briefing content, and no IP address is stored with them. To limit abuse, the endpoint uses a keyed hash (HMAC) of your IP address, not the address itself, to cap how many events one source can send.' },
  { type: 'p', text: 'Legal basis: our legitimate interest in measuring and improving Passage by first-party means (GDPR Article 6(1)(f)). You can object at any time by email, and you can reset the identifiers by clearing this site’s data in your browser.' },

  { type: 'h2', text: 'Feedback form' },
  { type: 'p', text: 'If you send feedback, we receive your message, the category you chose, your language, the address of the page you were on, whether your device is mobile or desktop, your browser’s user-agent string and, if a briefing is open, its identifier and route name. The form has no email field, so we can reply only if you put contact details in your message.' },
  { type: 'p', text: 'Messages are stored in our database (Supabase), and the same IP-hash limit as above applies. Legal basis: our legitimate interest in handling feedback and fixing data issues (GDPR Article 6(1)(f)).' },

  { type: 'h2', text: 'What stays in your browser' },
  { type: 'p', text: 'Passage sets no cookies. It uses your browser’s local storage, session storage and IndexedDB for the items below. This data stays on your device until you delete it or clear this site’s data.' },
  { type: 'ul', items: [
    'Language choice, saved only if you use the language switcher.',
    'Planner draft: route, boat, speeds and departure time.',
    'Your personal limits.',
    'GRIB files page choices: last area, period and models.',
    'The demo briefings you have hidden.',
    'Briefings you save in this browser (IndexedDB).',
    'A cache of forecast tiles so they load faster (IndexedDB).',
    'The usage-measurement identifiers and campaign tags described above: the visitor identifier and first campaign tags stay in local storage; the session identifier, current campaign tags and a few session flags are in session storage and clear when the tab closes.',
  ] },

  { type: 'h2', text: 'Who receives data' },
  { type: 'p', text: 'Cloudflare (hosting, forecast storage and server functions), Supabase (usage events and feedback) and the OpenStreetMap and OpenSeaMap tile services. We do not sell personal data and do not share it with advertising networks. Some of these providers process data outside the EEA; the safeguards are described in the full policy.' },

  { type: 'h2', text: 'Your rights' },
  { type: 'p', text: 'You can ask us for a copy of your personal data, or to correct, erase or restrict it, or to hand it over in a portable format, and you can object to processing based on our legitimate interests. You can also complain to your data protection authority, for example the CNIL in France.' },
  { type: 'p', text: 'Because Passage keeps your routes and briefings only in your browser, we cannot see or erase them for you; delete them in Passage or through your browser’s site-data settings.' },
  { type: 'contact', text: 'To exercise these rights, email' },
  { type: 'link', text: 'Read the full DeepRegatta privacy policy' },
];

/** Every English string on the page, in order (for translation checks). */
export function privacyTexts() {
  return PRIVACY_BLOCKS.flatMap((block) => (block.type === 'ul' ? block.items : [block.text]));
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page body as static HTML for a language; `translate` is translateText. */
export function privacyHtml(language, translate) {
  const t = (text) => escapeHtml(translate(text, language));
  return PRIVACY_BLOCKS.map((block) => {
    switch (block.type) {
      case 'h1': return `<h1>${t(block.text)}</h1>`;
      case 'h2': return `<h2>${t(block.text)}</h2>`;
      case 'p': return `<p>${t(block.text)}</p>`;
      case 'ul': return `<ul>${block.items.map((item) => `<li>${t(item)}</li>`).join('')}</ul>`;
      case 'contact': return `<p>${t(block.text)} <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>`;
      case 'link': return `<p><a href="${fullPolicyUrl(language)}">${t(block.text)}</a></p>`;
      default: throw new Error(`privacy: unknown block type ${block.type}`);
    }
  }).join('');
}
