// Canonical: oscar/viewer2/src/lib/analyticsClient.js, 2026-09-05; profile_id drop synced 2026-09-20.
// Vendored within the fleet; contract: campaign ops/product-measurement-v2.md.
export function createAnalytics({
  product,
  collector,
  prefix = 'dr',
  build = 'measurement-2-20260905.1',
}) {
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  const hosts = new Set([
    'deepregatta.com',
    'oscar.deepregatta.com',
    'retrace.deepregatta.com',
    'passage.deepregatta.com',
  ]);
  const memory = new Map();
  const once = new Set();
  const id = () =>
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  function read(area, key) {
    try {
      return window[area].getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  }
  function write(area, key, value) {
    memory.set(key, value);
    try {
      window[area].setItem(key, value);
    } catch {
      /* ephemeral fallback */
    }
  }
  function json(area, key) {
    try {
      return JSON.parse(read(area, key));
    } catch {
      return null;
    }
  }
  function capture() {
    const url = new URL(window.location.href);
    if (read('sessionStorage', 'dr.contract') !== '2') {
      write('sessionStorage', 'dr.contract', '2');
      write('sessionStorage', `${prefix}.sid`, id());
      write('sessionStorage', `${prefix}.sid.started`, '');
      write('sessionStorage', `${prefix}.product_open`, '');
    }
    const requested = url.searchParams.get('dr_traffic');
    if (
      ['qa', 'operator', 'audience'].includes(requested) &&
      requested !== read('sessionStorage', 'dr.traffic')
    ) {
      write('sessionStorage', 'dr.traffic', requested);
      write('sessionStorage', `${prefix}.sid`, id());
      write('sessionStorage', `${prefix}.sid.started`, '');
      write('sessionStorage', `${prefix}.product_open`, '');
      write('sessionStorage', 'dr.verification', '');
    }
    const label = url.searchParams.get('dr_verification');
    if (label && /^[a-zA-Z0-9_.-]{1,80}$/.test(label))
      write('sessionStorage', 'dr.verification', label);
    const found = {};
    for (const key of keys) {
      const value = url.searchParams.get(key);
      if (value) found[key] = value.slice(0, 100);
    }
    if (Object.keys(found).length) {
      const fallback = url.searchParams.get('dr_attribution') === 'first_touch';
      write(
        'sessionStorage',
        'dr.utm.session',
        JSON.stringify({
          ...found,
          ...(fallback ? { utm_first_touch: true } : {}),
        })
      );
      if (!read('localStorage', 'dr.utm.first'))
        write('localStorage', 'dr.utm.first', JSON.stringify(found));
    }
  }
  function context() {
    capture();
    const session = json('sessionStorage', 'dr.utm.session');
    const first = json('localStorage', 'dr.utm.first');
    const utm = session || (first ? { ...first, utm_first_touch: true } : {});
    const traffic = read('sessionStorage', 'dr.traffic') || 'audience';
    const verification = read('sessionStorage', 'dr.verification');
    return {
      ...utm,
      product,
      event_contract: '2',
      measurement_build: build,
      traffic_class: traffic,
      attribution_kind: utm.utm_first_touch
        ? 'first_touch'
        : Object.keys(utm).length
          ? 'session'
          : 'none',
      ...(traffic !== 'audience' && verification
        ? { verification_run: verification }
        : {}),
    };
  }
  function receipt(event, props, result) {
    if (props.traffic_class === 'audience') return;
    // Inspectable in the verification tab; deliberately omit identity and user props.
    const rows = (window.__drMeasurementHealth ||= []);
    rows.push({
      product,
      build,
      contract: '2',
      event,
      at: new Date().toISOString(),
      result,
    });
    if (rows.length > 100) rows.shift();
  }
  function send(payload) {
    if (!hosts.has(window.location.hostname)) return false;
    const url = typeof collector === 'function' ? collector() : collector;
    const body = JSON.stringify(payload);
    if (payload.props.traffic_class === 'audience') {
      try {
        if (
          navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))
        )
          return true;
      } catch {
        /* one fetch fallback when queueing fails */
      }
    }
    try {
      fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain' },
        keepalive: true,
      })
        .then((response) =>
          receipt(
            payload.event,
            payload.props,
            response.ok ? 'stored' : `http_${response.status}`
          )
        )
        .catch(() => receipt(payload.event, payload.props, 'network_failed'));
      return true;
    } catch {
      receipt(payload.event, payload.props, 'send_failed');
      return false;
    }
  }
  function track(event, props = {}) {
    try {
      if (typeof window === 'undefined') return;
      const common = context();
      const existed = Boolean(read('localStorage', `${prefix}.vid`));
      const visitor = read('localStorage', `${prefix}.vid`) || id();
      const session = read('sessionStorage', `${prefix}.sid`) || id();
      write('localStorage', `${prefix}.vid`, visitor);
      write('sessionStorage', `${prefix}.sid`, session);
      const base = { visitor_id: visitor, session_id: session };
      let referrer;
      try {
        referrer = document.referrer
          ? new URL(document.referrer).hostname
          : null;
      } catch {
        /* no referrer */
      }
      if (!read('sessionStorage', `${prefix}.sid.started`)) {
        if (
          send({
            ...base,
            event: 'session_start',
            props: {
              ...common,
              new_visitor: !existed,
              ...(referrer ? { referrer } : {}),
            },
          })
        )
          write('sessionStorage', `${prefix}.sid.started`, '1');
      }
      if (
        product !== 'landing' &&
        !read('sessionStorage', `${prefix}.product_open`) &&
        (common.attribution_kind === 'session' ||
          (hosts.has(referrer) && referrer !== window.location.hostname))
      ) {
        if (
          send({
            ...base,
            event: 'product_open',
            props: { ...common, ...(referrer ? { referrer } : {}) },
          })
        )
          write('sessionStorage', `${prefix}.product_open`, '1');
      }
      // The collector attributes events from a verified bearer token, which a
      // beacon cannot carry: a client profile id is dropped, never forwarded.
      const { race_id, ...rest } = props || {};
      delete rest.profile_id;
      send({
        ...base,
        event,
        race_id: race_id ?? null,
        props: { ...rest, ...common },
      });
    } catch {
      /* analytics never affects the application */
    }
  }
  function trackOnce(key, event, props = {}) {
    if (once.has(key)) return;
    once.add(key);
    track(event, props);
  }
  function withUtm(href) {
    try {
      const common = context();
      const url = new URL(href, window.location.href);
      if (!hosts.has(url.hostname) || url.protocol !== 'https:') return href;
      // An explicit destination tuple is authoritative as a whole.
      if (!keys.some((key) => url.searchParams.has(key))) {
        for (const key of keys)
          if (common[key]) url.searchParams.set(key, common[key]);
        if (common.attribution_kind === 'first_touch')
          url.searchParams.set('dr_attribution', 'first_touch');
      }
      if (common.traffic_class !== 'audience') {
        url.searchParams.set('dr_traffic', common.traffic_class);
        if (common.verification_run)
          url.searchParams.set('dr_verification', common.verification_run);
      }
      return url.toString() === new URL(href, window.location.href).toString()
        ? href
        : url.toString();
    } catch {
      return href;
    }
  }
  return { track, trackOnce, withUtm };
}
