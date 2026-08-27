/* Vendored from coachregatta viewer2/src/lib/analytics.js, 2026-07-17.
 * Adapted for passage: beacons to the fleet collector on
 * oscar.deepregatta.com. Fire-and-forget: analytics must never affect the
 * app. Event taxonomy and funnel definitions: oscar/docs/measurement.md. */

const PRODUCT = 'passage';
const COLLECTOR = 'https://oscar.deepregatta.com/api/event';

const VISITOR_KEY = 'dr.vid';
const SESSION_KEY = 'dr.sid';
const SESSION_STARTED_KEY = 'dr.sid.started';
const PRODUCT_OPEN_KEY = 'dr.product_open';
const UTM_FIRST_KEY = 'dr.utm.first';
const UTM_SESSION_KEY = 'dr.utm.session';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

// Only production traffic reaches the collector; dev servers stay silent.
const LIVE =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'deepregatta.com' ||
    window.location.hostname.endsWith('.deepregatta.com'));

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function getStoredId(storage, key) {
  try {
    let id = storage.getItem(key);
    if (!id) {
      id = randomId();
      storage.setItem(key, id);
    }
    return id;
  } catch {
    return null;
  }
}

function readJsonItem(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Capture campaign parameters on arrival: last-touch for this session,
// first-touch forever. Keep the landing URL intact so a campaign redirect can
// be independently verified after the SPA has settled.
function captureUtm() {
  try {
    const url = new URL(window.location.href);
    const found = {};
    for (const key of UTM_KEYS) {
      const value = url.searchParams.get(key);
      if (value) found[key] = value.slice(0, 100);
    }
    if (Object.keys(found).length === 0) return;

    try {
      window.sessionStorage.setItem(UTM_SESSION_KEY, JSON.stringify(found));
      if (!window.localStorage.getItem(UTM_FIRST_KEY)) {
        window.localStorage.setItem(UTM_FIRST_KEY, JSON.stringify(found));
      }
    } catch {
      /* ignore */
    }

  } catch {
    /* ignore */
  }
}

function getUtm() {
  try {
    const session = readJsonItem(window.sessionStorage, UTM_SESSION_KEY);
    if (session) return session;
    const first = readJsonItem(window.localStorage, UTM_FIRST_KEY);
    return first ? { ...first, utm_first_touch: true } : {};
  } catch {
    return {};
  }
}

function referrerHost() {
  try {
    return document.referrer ? new URL(document.referrer).hostname : null;
  } catch {
    return null;
  }
}

function send(payload) {
  if (!LIVE) return;
  try {
    // text/plain keeps the cross-origin beacon preflight-free; the collector
    // parses the body as JSON regardless of content type.
    const body = JSON.stringify(payload);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(COLLECTOR, new Blob([body], { type: 'text/plain' }));
      return;
    }
    fetch(COLLECTOR, {
      body,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true,
      method: 'POST',
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function track(event, props = {}) {
  try {
    if (typeof window === 'undefined') return;

    captureUtm();

    let visitorExisted = false;
    try {
      visitorExisted = Boolean(window.localStorage.getItem(VISITOR_KEY));
    } catch {
      /* ignore */
    }
    const visitorId = getStoredId(window.localStorage, VISITOR_KEY);
    const sessionId = getStoredId(window.sessionStorage, SESSION_KEY);
    const utm = getUtm();

    try {
      if (!window.sessionStorage.getItem(SESSION_STARTED_KEY)) {
        window.sessionStorage.setItem(SESSION_STARTED_KEY, '1');
        const referrer = referrerHost();
        send({
          event: 'session_start',
          props: {
            new_visitor: !visitorExisted,
            product: PRODUCT,
            ...(referrer ? { referrer } : {}),
            ...utm,
          },
          session_id: sessionId,
          visitor_id: visitorId,
        });
      }

      // product_open: this session crossed into the product from another
      // DeepRegatta property or arrived on a campaign link.
      if (!window.sessionStorage.getItem(PRODUCT_OPEN_KEY)) {
        const referrer = referrerHost();
        const internalReferrer =
          referrer &&
          referrer !== window.location.hostname &&
          (referrer === 'deepregatta.com' ||
            referrer.endsWith('.deepregatta.com'));
        const hasCampaign = Boolean(
          readJsonItem(window.sessionStorage, UTM_SESSION_KEY)
        );
        if (internalReferrer || hasCampaign) {
          window.sessionStorage.setItem(PRODUCT_OPEN_KEY, '1');
          send({
            event: 'product_open',
            props: {
              product: PRODUCT,
              ...(referrer ? { referrer } : {}),
              ...utm,
            },
            session_id: sessionId,
            visitor_id: visitorId,
          });
        }
      }
    } catch {
      /* ignore */
    }

    send({
      event,
      props: { product: PRODUCT, ...props },
      session_id: sessionId,
      visitor_id: visitorId,
    });
  } catch {
    /* analytics must never throw */
  }
}

// Appends the visitor's campaign parameters to a cross-product link so
// attribution survives the subdomain hop (each subdomain has its own
// localStorage). The receiving client preserves those parameters so the
// original campaign destination remains inspectable throughout navigation.
export function withUtm(href) {
  try {
    const utm = getUtm();
    delete utm.utm_first_touch;
    if (Object.keys(utm).length === 0) return href;
    const url = new URL(href, window.location.href);
    for (const [key, value] of Object.entries(utm)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, String(value));
    }
    return url.toString();
  } catch {
    return href;
  }
}
