/** Hash routes — shared by the store (initial page) and App (sync).
 * A passage's evidence, changes and outcome are sections of one page, so their
 * paths only choose where that page scrolls to. */
const ROUTES = {
  'plan': { page: 'planner' },
  'plan/grib': { page: 'grib' },
  'passages': { page: 'passages' },
  'passage': { page: 'briefing' },
  'passage/evidence': { page: 'briefing', section: 'evidence' },
  'passage/changes': { page: 'briefing', section: 'changes' },
  'passage/outcome': { page: 'briefing', section: 'outcome' },
  'about': { page: 'about' },
  'example': { page: 'example' },
  // Retired Plan / Brief / Watch / Verify stage links keep opening the same
  // content for shared and bookmarked URLs; navigation writes the paths above.
  'plan/planner': { page: 'planner' },
  'plan/limits': { page: 'planner', limits: true },
  'plan/briefings': { page: 'passages' },
  'brief/briefings': { page: 'passages' },
  'brief/story': { page: 'briefing' },
  'brief/evidence': { page: 'briefing', section: 'evidence' },
  'watch/changes': { page: 'briefing', section: 'changes' },
  'verify/case-study': { page: 'briefing', section: 'outcome' },
  'verify/record': { page: 'about' },
};

const CANONICAL = {
  planner: 'plan',
  grib: 'plan/grib',
  passages: 'passages',
  briefing: 'passage',
  about: 'about',
  example: 'example',
};

export function initialPage() {
  if (typeof location === 'undefined') return 'planner';
  return locationRoute().page ?? 'planner';
}

export function isGribPath(pathname = globalThis.location?.pathname ?? '') {
  return /^\/(?:fr\/)?grib\/?$/.test(pathname);
}

export function locationRoute() {
  const route = parseRoute(location.hash);
  return !location.hash && isGribPath() ? { ...route, page: 'grib' } : route;
}

// A shared URL names a served artifact directory, never an arbitrary URL/path.
export function validSnapshotId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id);
}

export function parseRoute(hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const route = ROUTES[path] ?? {};
  return {
    page: route.page,
    section: route.section ?? null,
    limits: route.limits === true,
    snapshotId: route.page === 'briefing' ? new URLSearchParams(query).get('snapshot') : null,
  };
}

export function pageHash(page, snapshotId = null) {
  const path = CANONICAL[page] ?? CANONICAL.planner;
  return page === 'briefing' && validSnapshotId(snapshotId)
    ? `${path}?snapshot=${encodeURIComponent(snapshotId)}` : path;
}

export function analysisShareUrl(snapshotId, href) {
  if (!validSnapshotId(snapshotId)) return null;
  const url = new URL(href);
  url.search = '';
  url.hash = pageHash('briefing', snapshotId);
  return url.href;
}
