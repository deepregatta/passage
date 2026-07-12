import { create } from 'zustand';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export const useApp = create((set, get) => ({
  page: 'snapshots', // snapshots | briefing | evidence | settings
  manifest: null,
  manifestError: null,

  snapshotId: null,
  findings: null,
  briefing: null,
  plume: null,
  snapshot: null,
  warnings: null,
  synoptic: null,
  route: null,
  loadError: null,
  loading: false,

  selectedEvidenceId: null,
  inspectorOpen: false,
  selectedLegId: null,

  providers: null,
  profileDefaults: null,

  nowMs: Date.now(),

  setPage: (page) => set({ page }),

  loadManifest: async () => {
    try {
      const manifest = await fetchJson('/data/snapshots/manifest.json');
      set({ manifest, manifestError: null });
    } catch (error) {
      set({ manifestError: error.message });
    }
  },

  loadConfig: async () => {
    try {
      const [providers, profileDefaults] = await Promise.all([
        fetchJson('/data/config/providers.json'),
        fetchJson('/data/config/profiles/default-limits.json'),
      ]);
      set({ providers, profileDefaults });
    } catch {
      // config view is optional; Settings shows a note when absent
    }
  },

  openSnapshot: async (snapshotId) => {
    set({ loading: true, loadError: null, snapshotId, inspectorOpen: false });
    try {
      const base = `/data/snapshots/${snapshotId}`;
      const [snapshot, findings, briefing, plume, warnings, synoptic, route] = await Promise.all([
        fetchJson(`${base}/snapshot.json`).catch(() => null),
        fetchJson(`${base}/findings.json`),
        fetchJson(`${base}/briefing.json`),
        fetchJson(`${base}/plume.json`).catch(() => null),
        fetchJson(`${base}/warnings.json`).catch(() => null),
        fetchJson(`${base}/synoptic.json`).catch(() => null),
        fetchJson(`${base}/route.json`).catch(() => null),
      ]);
      const worstLeg =
        findings.evidence.find((e) => e.evidence_id === findings.verdict.driver_evidence_id)
          ?.leg_id ?? findings.legs[0]?.leg_id;
      set({
        findings,
        briefing,
        plume,
        snapshot,
        warnings,
        synoptic,
        route,
        loading: false,
        page: 'briefing',
        selectedLegId: worstLeg ?? null,
        selectedEvidenceId: findings.verdict.driver_evidence_id ??
          findings.evidence.find((item) => item.member_fraction)?.evidence_id ?? null,
        nowMs: Date.now(),
      });
    } catch (error) {
      set({ loadError: error.message, loading: false });
    }
  },

  selectEvidence: (evidenceId) => set({ selectedEvidenceId: evidenceId }),
  openEvidence: (evidenceId) => set({ selectedEvidenceId: evidenceId, inspectorOpen: true }),
  closeInspector: () => set({ inspectorOpen: false }),
  selectLeg: (legId) => set({ selectedLegId: legId }),

  evidenceById: (evidenceId) => {
    const { findings } = get();
    return findings?.evidence.find((e) => e.evidence_id === evidenceId) ?? null;
  },
}));
