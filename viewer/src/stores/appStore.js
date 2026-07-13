import { create } from 'zustand';
import { initialPage } from '../lib/routes.js';
import { localSnapshots, fetchSnapshotJson } from '../lib/localSnapshots.js';
import { preparedRun } from '../lib/preparedRun.js';

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export const useApp = create((set, get) => ({
  page: initialPage(), // stage 01 (plan a passage) unless the URL deep-links elsewhere
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
    // static manifest (demo + committed snapshots) merged with briefings the
    // browser persisted locally on static hosting; local entries win on id
    const [served, local] = await Promise.all([
      fetchJson('/data/snapshots/manifest.json').catch((error) => error),
      localSnapshots.list(),
    ]);
    if (served instanceof Error && local.length === 0) {
      set({ manifestError: served.message });
      return;
    }
    const servedSnapshots = served instanceof Error ? [] : served.snapshots ?? [];
    const localIds = new Set(local.map((s) => s.snapshot_id));
    // local briefings first (newest first), then the served list in its own order
    const snapshots = [...local, ...servedSnapshots.filter((s) => !localIds.has(s.snapshot_id))];
    set({
      manifest: { ...(served instanceof Error ? {} : served), snapshots },
      manifestError: null,
    });
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
      await preparedRun(); // settle the runs/… base before chart <img> URLs render
      const file = (name) => fetchSnapshotJson(snapshotId, name);
      const [snapshot, findings, briefing, plume, warnings, synoptic, route] = await Promise.all([
        file('snapshot.json').catch(() => null),
        file('findings.json'),
        file('briefing.json'),
        file('plume.json').catch(() => null),
        file('warnings.json').catch(() => null),
        file('synoptic.json').catch(() => null),
        file('route.json').catch(() => null),
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

  deleteSnapshot: async (snapshotId) => {
    const deletedLocally = await localSnapshots.remove(snapshotId);
    if (!deletedLocally) {
      const res = await fetch(`/data/snapshots/${snapshotId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Could not delete: ${await res.text()}`);
    }
    const closingOpen = get().snapshotId === snapshotId;
    if (closingOpen) {
      set({ snapshotId: null, findings: null, briefing: null, plume: null, snapshot: null, warnings: null, synoptic: null, route: null });
    }
    await get().loadManifest();
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
