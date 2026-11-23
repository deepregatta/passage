import { evidenceById } from '../lib/evidenceSelectors.js';
import { create } from 'zustand';
import { initialPage, pageHash, standalonePage, validSnapshotId } from '../lib/routes.js';
import { IMPORT_MARKER, localSnapshots, fetchSnapshotJson, snapshotTombstones } from '../lib/localSnapshots.js';
import { openCheckMemory } from '../lib/openCheckMemory.js';
import { preparedRun } from '../lib/preparedRun.js';
import { getInitialLanguage, getLanguageFromPath, LANGUAGE_STORAGE_KEY } from '../i18n.js';
import { usePlayback } from './playbackStore.js';
import { recoverProfileDraft, saveProfileDraft } from '../lib/profileDraft.js';
import { initialSelection, needsRecordedProfile } from '../lib/governing.js';

// IndexedDB and shared prepared-run reads may finish after navigation. Only the
// current open (including example manifest discovery) may publish its result.
let openSequence = 0;
const emptySnapshot = {
  snapshotId: null, snapshotSource: null, findings: null, briefing: null, plume: null, snapshot: null,
  warnings: null, synoptic: null, route: null, measurementAttempt: null, checkProfile: null, imported: false,
  selectedEvidenceId: null, selectedLegId: null, inspectorOpen: false,
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export const useApp = create((set, get) => ({
  language: getInitialLanguage(),
  page: initialPage(), // plan a passage unless the URL deep-links elsewhere
  // where the passage page scrolls once its briefing is on screen (story when null)
  passageSection: null,
  plannerArea: null,
  setPlannerArea: (plannerArea) => set({ plannerArea }),
  manifest: null,
  manifestError: null,
  // the ids of the checks Passage serves, hidden ones included, once this page has
  // read the served catalogue (null until then): an import refuses them
  servedIds: null,

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
  // the limits the open check recorded (its decision-inputs.json), when its verdict
  // sentence needs them; never the sailor's draft, which may have changed since
  checkProfile: null,
  // the open check was imported from a file (its imported.json marker; lib/checkImport.js)
  imported: false,
  loadError: null,
  loading: false,

  selectedEvidenceId: null,
  inspectorOpen: false,
  selectedLegId: null,

  providers: null,
  profileDefaults: null,
  // the sailor's editable limits: the header chip, the limits drawer and every
  // new check read the same draft; frozen briefings keep the limits they used
  limits: null,
  limitsPersisted: true,
  limitsOpen: false,

  nowMs: Date.now(),

  setPage: (page, writeHistory = true) => {
    if (page !== get().page) {
      openSequence += 1;
      set({ loading: false });
    }
    const hash = pageHash(page, get().snapshotSource === 'served' ? get().snapshotId : null);
    if (writeHistory && typeof location !== 'undefined' && hash && location.hash !== `#${hash}`) {
      const url = new URL(location.href);
      const standalone = standalonePage();
      if (standalone && page !== standalone) {
        url.pathname = getLanguageFromPath(location.pathname) === 'fr' ? '/fr/' : '/';
        url.searchParams.delete('area');
      }
      url.hash = hash;
      history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
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
      const url = new URL(location.href);
      // Keep an inbound override in step with the switcher's explicit choice,
      // so reloading cannot restore the campaign link's previous language.
      if (url.searchParams.has('lang')) url.searchParams.set('lang', language);
      const onFrenchPath = getLanguageFromPath(location.pathname) === 'fr';
      if ((language === 'fr') !== onFrenchPath) {
        const standalone = standalonePage();
        url.pathname = standalone ? `${language === 'fr' ? '/fr' : ''}/${standalone}` : (language === 'fr' ? '/fr/' : '/');
      }
      if (url.href !== location.href) {
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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
    const servedIds = served instanceof Error ? get().servedIds
      : new Set((served.snapshots ?? []).map((s) => s?.snapshot_id).filter((id) => typeof id === 'string'));
    const servedSnapshots = (served instanceof Error ? [] : served.snapshots ?? []).filter(
      (s) => !hidden.has(s.snapshot_id),
    );
    const localIds = new Set(local.map((s) => s.snapshot_id));
    // local briefings first (newest first), then the served list in its own order
    const snapshots = [...local, ...servedSnapshots.filter((s) => !localIds.has(s.snapshot_id))];
    set({
      manifest: { ...(served instanceof Error ? {} : served), snapshots },
      manifestError: null,
      servedIds,
    });
  },

  setPassageSection: (passageSection) => set({ passageSection }),
  openLimits: () => { void get().ensureLimits(); set({ limitsOpen: true }); },
  closeLimits: () => set({ limitsOpen: false }),
  ensureLimits: async () => {
    if (get().limits) return;
    if (!get().profileDefaults) await get().loadConfig();
    const defaults = get().profileDefaults;
    if (defaults && !get().limits) set({ limits: recoverProfileDraft(defaults) });
  },
  updateLimit: (path, value) => {
    const next = structuredClone(get().limits);
    let obj = next;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = value;
    const limitsPersisted = saveProfileDraft(next);
    set({ limits: next, limitsPersisted });
  },

  loadConfig: async () => {
    try {
      const [providers, profileDefaults] = await Promise.all([
        fetchJson('/data/config/providers.json'),
        fetchJson('/data/config/profiles/default-limits.json'),
      ]);
      set({ providers, profileDefaults });
    } catch {
      // config is optional; the limits drawer shows a loading note when absent
    }
  },

  // source: 'served' (a link or the example: read from /data/snapshots/),
  // 'local' (known to be saved in this browser) or null (saved here if it exists)
  openSnapshot: async (snapshotId, measurementAttempt = null, targetPage = 'briefing', source = null) => {
    const sequence = ++openSequence;
    usePlayback.getState().reset();
    set({ ...emptySnapshot, loading: true, loadError: null, snapshotId, measurementAttempt });
    try {
      if (!validSnapshotId(snapshotId)) throw new Error('Invalid check identifier');
      const snapshotSource = source === 'served' || targetPage === 'example'
        ? 'served' : source === 'local' || await localSnapshots.exists(snapshotId) ? 'local' : 'served';
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
      // A `within` margin ("Closest to your limits") needs the limits this check used:
      // read them from the check's own record, only when the sentence needs them. A check
      // without that record (a legacy check) has no margin line; the draft never stands in.
      const checkProfile = needsRecordedProfile(findings)
        ? await file('decision-inputs.json').then((inputs) => inputs?.profile ?? null).catch(() => null)
        : null;
      if (sequence !== openSequence) return;
      // a browser-saved check imported from a file carries a marker the page names it by
      const imported = snapshotSource === 'local' && await localSnapshots.has(snapshotId, IMPORT_MARKER);
      if (sequence !== openSequence) return;
      // start on the claim and leg the verdict sentence names, not the verdict driver
      // (the driver ranks by ratio and can be another leg, hour and count)
      const selection = initialSelection(findings, checkProfile);
      set({
        snapshotSource,
        checkProfile,
        findings,
        briefing,
        plume,
        snapshot,
        warnings,
        synoptic,
        route,
        imported,
        loading: false,
        page: targetPage,
        ...selection,
        nowMs: Date.now(),
      });
      if (typeof location !== 'undefined') {
        const hash = pageHash(targetPage, snapshotSource === 'served' ? snapshotId : null);
        history.replaceState(null, '', `${location.pathname}${location.search}#${hash}`);
      }
      // a served check is named by the URL; a browser-saved one is remembered per tab
      if (snapshotSource === 'local' && targetPage === 'briefing') openCheckMemory.remember(snapshotId);
      else openCheckMemory.forget();
    } catch (error) {
      if (sequence !== openSequence) return;
      openCheckMemory.forget(snapshotId);
      set({ loadError: source === 'served' ? 'This shared analysis is unavailable.' : error.message, loading: false });
    }
  },

  // A reload (or a restored tab) on the passage page reopens the browser-saved
  // check this tab had open, from its saved copy: never a recompute or a newer
  // check. Gone from this browser: the page stays empty, without an error.
  restoreOpenCheck: async () => {
    const snapshotId = openCheckMemory.read();
    if (!validSnapshotId(snapshotId) || get().snapshotId || get().loading) return;
    const sequence = ++openSequence;
    set({ loading: true, loadError: null });
    const saved = await localSnapshots.exists(snapshotId);
    if (sequence !== openSequence) return;
    if (!saved) {
      openCheckMemory.forget(snapshotId);
      set({ loading: false });
      return;
    }
    await get().openSnapshot(snapshotId, null, 'briefing', 'local');
  },

  deleteSnapshot: async (snapshotId) => {
    const deletedLocally = await localSnapshots.remove(snapshotId);
    openCheckMemory.forget(snapshotId);
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
