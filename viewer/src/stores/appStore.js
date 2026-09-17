import { evidenceById } from '../lib/evidenceSelectors.js';
import { create } from 'zustand';
import { initialPage, pageHash, validSnapshotId } from '../lib/routes.js';
import { localSnapshots, fetchSnapshotJson, snapshotTombstones } from '../lib/localSnapshots.js';
import { preparedRun } from '../lib/preparedRun.js';
import { getInitialLanguage, getLanguageFromPath, LANGUAGE_STORAGE_KEY } from '../i18n.js';
import { usePlayback } from './playbackStore.js';

// IndexedDB and shared prepared-run reads may finish after navigation. Only the
// current open (including example manifest discovery) may publish its result.
let openSequence = 0;
const emptySnapshot = {
  snapshotId: null, snapshotSource: null, findings: null, briefing: null, plume: null, snapshot: null,
  warnings: null, synoptic: null, route: null, measurementAttempt: null,
  selectedEvidenceId: null, selectedLegId: null, inspectorOpen: false,
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export const useApp = create((set, get) => ({
  language: getInitialLanguage(),
  page: initialPage(), // stage 01 (plan a passage) unless the URL deep-links elsewhere
  manifest: null,
  manifestError: null,

  measurementAttempt: null,
  snapshotId: null,
  snapshotSource: null,
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

  setPage: (page, writeHistory = true) => {
    if (page !== get().page) {
      openSequence += 1;
      set({ loading: false });
    }
    const hash = pageHash(page, get().snapshotSource === 'served' ? get().snapshotId : null);
    if (writeHistory && typeof location !== 'undefined' && hash && location.hash !== `#${hash}`) {
      history.pushState(null, '', `${location.pathname}${location.search}#${hash}`);
    }
    set({ page });
  },

  // The public example is resolved from the served manifest, even when a
  // returning visitor has hidden it from My briefings. No planner or forecast run.
  loadExample: async () => {
    const sequence = ++openSequence;
    usePlayback.getState().reset();
    set({ ...emptySnapshot, loading: true, loadError: null });
    try {
      const served = await fetchJson('/data/snapshots/manifest.json');
      if (sequence !== openSequence) return;
      const example = served.snapshots?.find((item) => item.demo === true);
      if (!example) throw new Error('Example unavailable');
      set({ manifest: { ...(get().manifest ?? served), snapshots: [example,
        ...(get().manifest?.snapshots ?? []).filter((item) => item.snapshot_id !== example.snapshot_id)] } });
      await get().openSnapshot(example.snapshot_id, null, 'example', 'served');
    } catch (error) {
      if (sequence !== openSequence) return;
      set({ loadError: error.message, loading: false });
    }
  },
  setLanguage: (language) => {
    if (language !== 'en' && language !== 'fr') return;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The selection still applies for this session when storage is blocked.
    }
    // /fr/ is the crawlable French URL: keep the path in step with the
    // language so the served head, client head and content always agree.
    if (typeof location !== 'undefined') {
      const onFrenchPath = getLanguageFromPath(location.pathname) === 'fr';
      if ((language === 'fr') !== onFrenchPath) {
        history.replaceState(null, '', `${language === 'fr' ? '/fr/' : '/'}${location.search}${location.hash}`);
      }
    }
    set({ language });
  },

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
    const hidden = snapshotTombstones.all();
    const servedSnapshots = (served instanceof Error ? [] : served.snapshots ?? []).filter(
      (s) => !hidden.has(s.snapshot_id),
    );
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

  openSnapshot: async (snapshotId, measurementAttempt = null, targetPage = 'briefing', source = null) => {
    const sequence = ++openSequence;
    usePlayback.getState().reset();
    set({ ...emptySnapshot, loading: true, loadError: null, snapshotId, measurementAttempt });
    try {
      if (!validSnapshotId(snapshotId)) throw new Error('Invalid snapshot identifier');
      const snapshotSource = source === 'served' || targetPage === 'example'
        ? 'served' : await localSnapshots.exists(snapshotId) ? 'local' : 'served';
      if (targetPage !== 'example') await preparedRun(); // live/saved runs only
      if (sequence !== openSequence) return;
      const file = source === 'served' || targetPage === 'example'
        ? (name) => fetchJson(`/data/snapshots/${snapshotId}/${name}`)
        : (name) => fetchSnapshotJson(snapshotId, name);
      const [snapshot, findings, briefing, plume, warnings, synoptic, route] = await Promise.all([
        file('snapshot.json').catch(() => null),
        file('findings.json'),
        file('briefing.json'),
        file('plume.json').catch(() => null),
        file('warnings.json').catch(() => null),
        file('synoptic.json').catch(() => null),
        file('route.json').catch(() => null),
      ]);
      if (sequence !== openSequence) return;
      const worstLeg =
        findings.evidence.find((e) => e.evidence_id === findings.verdict.driver_evidence_id)
          ?.leg_id ?? findings.legs[0]?.leg_id;
      set({
        snapshotSource,
        findings,
        briefing,
        plume,
        snapshot,
        warnings,
        synoptic,
        route,
        loading: false,
        page: targetPage,
        selectedLegId: worstLeg ?? null,
        selectedEvidenceId: findings.verdict.driver_evidence_id ??
          findings.evidence.find((item) => item.member_fraction)?.evidence_id ?? null,
        nowMs: Date.now(),
      });
      if (typeof location !== 'undefined') {
        const hash = pageHash(targetPage, snapshotSource === 'served' ? snapshotId : null);
        history.replaceState(null, '', `${location.pathname}${location.search}#${hash}`);
      }
    } catch (error) {
      if (sequence !== openSequence) return;
      set({ loadError: source === 'served' ? 'This shared analysis is unavailable.' : error.message, loading: false });
    }
  },

  deleteSnapshot: async (snapshotId) => {
    const deletedLocally = await localSnapshots.remove(snapshotId);
    if (!deletedLocally) {
      if (import.meta.env.DEV) {
        // dev middleware deletes the repo files (fixture mode refuses: read-only)
        const res = await fetch(`/data/snapshots/${snapshotId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Could not delete: ${await res.text()}`);
      } else {
        // static hosting: baked-in demo snapshots can't be removed server-side —
        // hide them in this browser instead
        snapshotTombstones.add(snapshotId);
      }
    }
    const closingOpen = get().snapshotId === snapshotId;
    if (closingOpen) {
      openSequence += 1;
      usePlayback.getState().reset();
      set({ ...emptySnapshot, loading: false, loadError: null });
    }
    await get().loadManifest();
  },

  selectEvidence: (evidenceId) => set({ selectedEvidenceId: evidenceId }),
  openEvidence: (evidenceId) => set({ selectedEvidenceId: evidenceId, inspectorOpen: true }),
  closeInspector: () => set({ inspectorOpen: false }),
  selectLeg: (legId) => set({ selectedLegId: legId }),

  evidenceById: (evidenceId) => evidenceById(get().findings, evidenceId),
}));
