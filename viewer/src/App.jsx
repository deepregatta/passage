import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useApp } from './stores/appStore.js';
import Shell from './components/Shell.jsx';
import { locationRoute, pageHash } from './lib/routes.js';
import { track } from './lib/analytics.js';
import { LocalizedDocument } from './i18n.js';
import { HeadMetadata } from './components/HeadMetadata.jsx';
import PageErrorBoundary from './components/PageErrorBoundary.jsx';
import InspectorErrorBoundary from './components/InspectorErrorBoundary.jsx';

const PAGES = {
  example: lazy(() => import('./pages/Example.jsx')),
  passages: lazy(() => import('./pages/Passages.jsx')),
  planner: lazy(() => import('./pages/Planner.jsx')),
  grib: lazy(() => import('./pages/Grib.jsx')),
  briefing: lazy(() => import('./pages/Briefing.jsx')),
  about: lazy(() => import('./pages/About.jsx')),
  privacy: lazy(() => import('./pages/Privacy.jsx')),
};
const EvidenceInspector = lazy(() => import('./components/EvidenceInspector.jsx'));
// An inspector that could not be shown is closed with nothing selected, so it cannot throw again.
const closeFailedInspector = () => useApp.setState({ inspectorOpen: false, selectedEvidenceId: null });
const LimitsDrawer = lazy(() => import('./components/LimitsDrawer.jsx'));

export default function App() {
  const page = useApp((state) => state.page);
  const setPage = useApp((state) => state.setPage);
  const language = useApp((state) => state.language);
  const limitsOpen = useApp((state) => state.limitsOpen);
  const snapshotId = useApp((state) => state.snapshotId);
  const inspectorOpen = useApp((state) => state.inspectorOpen);
  const Page = PAGES[page] ?? PAGES.planner;
  // Each navigation (the header, the footer, a link or the browser's back and
  // forward) counts, so the page error boundary resets even on the same page.
  const [navigation, setNavigation] = useState(0);
  const navigate = useCallback((target) => {
    setNavigation((count) => count + 1);
    setPage(target);
  }, [setPage]);

  useEffect(() => {
    const sync = (event) => {
      if (event) setNavigation((count) => count + 1);
      const { page: target, snapshotId, section, limits } = locationRoute();
      if (target) {
        setPage(target, false);
        const state = useApp.getState();
        if (section) state.setPassageSection(section);
        if (limits) state.openLimits();
        if (snapshotId !== null && (state.snapshotId !== snapshotId || state.snapshotSource !== 'served')) {
          void state.openSnapshot(snapshotId, null, 'briefing', 'served');
        } else if (target === 'briefing' && snapshotId === null) {
          void state.restoreOpenCheck();
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
      <Shell page={page} onNavigate={navigate}>
        {/* A render error in the page stays in the page area; a new page, navigation or
            check starts afresh. */}
        <PageErrorBoundary resetKey={[page, snapshotId, navigation].join()} onNavigate={navigate}>
          {/* Dispose the old page's imperative map even if the next page suspends. */}
          <Suspense key={page} fallback={<div className="p-8 font-instrument text-ink-soft">Loading your passage…</div>}>
            <Page />
          </Suspense>
        </PageErrorBoundary>
        {/* The inspector is on every page and keeps its state across them: its errors close it, apart from the page's. */}
        <InspectorErrorBoundary open={inspectorOpen} page={page} onError={closeFailedInspector}>
          <Suspense fallback={null}><EvidenceInspector /></Suspense>
        </InspectorErrorBoundary>
        {limitsOpen && <Suspense fallback={null}><LimitsDrawer /></Suspense>}
      </Shell>
    </>
  );
}
