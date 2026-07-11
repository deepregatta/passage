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
  loadError: null,
  loading: false,

  inspectorEvidenceId: null,
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
    set({ loading: true, loadError: null, snapshotId, inspectorEvidenceId: null });
    try {
      const base = `/data/snapshots/${snapshotId}`;
      const [findings, briefing, plume] = await Promise.all([
        fetchJson(`${base}/findings.json`),
        fetchJson(`${base}/briefing.json`),
        fetchJson(`${base}/plume.json`).catch(() => null),
      ]);
      const worstLeg =
        findings.evidence.find((e) => e.evidence_id === findings.verdict.driver_evidence_id)
          ?.leg_id ?? findings.legs[0]?.leg_id;
      set({
        findings,
        briefing,
        plume,
        loading: false,
        page: 'briefing',
        selectedLegId: worstLeg ?? null,
        nowMs: Date.now(),
      });
    } catch (error) {
      set({ loadError: error.message, loading: false });
    }
  },

  openEvidence: (evidenceId) => set({ inspectorEvidenceId: evidenceId }),
  closeInspector: () => set({ inspectorEvidenceId: null }),
  selectLeg: (legId) => set({ selectedLegId: legId }),

  evidenceById: (evidenceId) => {
    const { findings } = get();
    return findings?.evidence.find((e) => e.evidence_id === evidenceId) ?? null;
  },
}));
