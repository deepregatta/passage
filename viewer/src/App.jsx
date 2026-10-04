import { lazy, Suspense, useEffect } from 'react';
import { useApp } from './stores/appStore.js';
import Shell from './components/Shell.jsx';
import { locationRoute, pageHash } from './lib/routes.js';
import { track } from './lib/analytics.js';
import { LocalizedDocument } from './i18n.js';
import { HeadMetadata } from './components/HeadMetadata.jsx';

const PAGES = {
  example: lazy(() => import('./pages/Example.jsx')),
  passages: lazy(() => import('./pages/Passages.jsx')),
  planner: lazy(() => import('./pages/Planner.jsx')),
  grib: lazy(() => import('./pages/Grib.jsx')),
  briefing: lazy(() => import('./pages/Briefing.jsx')),
  about: lazy(() => import('./pages/About.jsx')),
};
const EvidenceInspector = lazy(() => import('./components/EvidenceInspector.jsx'));
const LimitsDrawer = lazy(() => import('./components/LimitsDrawer.jsx'));

export default function App() {
  const page = useApp((state) => state.page);
  const setPage = useApp((state) => state.setPage);
  const language = useApp((state) => state.language);
  const limitsOpen = useApp((state) => state.limitsOpen);
  const Page = PAGES[page] ?? PAGES.planner;

  useEffect(() => {
    const sync = () => {
      const { page: target, snapshotId, section, limits } = locationRoute();
      if (target) {
        setPage(target, false);
        const state = useApp.getState();
        if (section) state.setPassageSection(section);
        if (limits) state.openLimits();
        if (snapshotId !== null && (state.snapshotId !== snapshotId || state.snapshotSource !== 'served')) {
          void state.openSnapshot(snapshotId, null, 'briefing', 'served');
        }
      } else {
        history.replaceState(null, '', `${location.pathname}${location.search}#${pageHash(useApp.getState().page)}`);
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [setPage]);

  useEffect(() => {
    track('page_view', { page });
  }, [page]);

  return (
    <>
      <LocalizedDocument language={language} />
      <HeadMetadata language={language} page={page} />
      <Shell page={page} onNavigate={setPage}>
        {/* Dispose the old page's imperative map even if the next page suspends. */}
        <Suspense key={page} fallback={<div className="p-8 font-instrument text-ink-soft">Loading passage instruments…</div>}>
          <Page />
        </Suspense>
        <Suspense fallback={null}><EvidenceInspector /></Suspense>
        {limitsOpen && <Suspense fallback={null}><LimitsDrawer /></Suspense>}
      </Shell>
    </>
  );
}
