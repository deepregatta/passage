/** stage/subview deep links — shared by the store (initial page) and App (sync) */
export const HASH_PAGE = {
  'example': 'example',
  'plan/planner': 'planner',
  // Keep existing shared/bookmarked links working; new navigation writes the
  // canonical Brief-menu location below.
  'plan/briefings': 'snapshots',
  'plan/limits': 'settings',
  'brief/briefings': 'snapshots',
  'brief/story': 'briefing',
  'brief/evidence': 'evidence',
  'watch/changes': 'changes',
  'verify/record': 'verification',
  'verify/case-study': 'caseStudy',
};

export const PAGE_HASH = Object.fromEntries(
  Object.entries(HASH_PAGE).map(([hash, page]) => [page, hash]),
);

export function initialPage() {
  if (typeof location === 'undefined') return 'planner';
  return parseRoute(location.hash).page ?? 'planner';
}

// A shared URL names a served artifact directory, never an arbitrary URL/path.
export function validSnapshotId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id);
}

export function parseRoute(hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const page = HASH_PAGE[path];
  return { page, snapshotId: page === 'briefing' ? new URLSearchParams(query).get('snapshot') : null };
}

export function pageHash(page, snapshotId = null) {
  const path = PAGE_HASH[page] ?? PAGE_HASH.planner;
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
