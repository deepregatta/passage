/** stage/subview deep links — shared by the store (initial page) and App (sync) */
export const HASH_PAGE = {
  'plan/planner': 'planner',
  'plan/briefings': 'snapshots',
  'plan/limits': 'settings',
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
  return HASH_PAGE[location.hash.slice(1)] ?? 'planner';
}
