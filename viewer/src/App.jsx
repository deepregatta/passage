import { lazy, Suspense, useEffect } from 'react';
import { useApp } from './stores/appStore.js';
import Shell from './components/Shell.jsx';
import { parseRoute, pageHash } from './lib/routes.js';
import { track } from './lib/analytics.js';
import { LocalizedDocument } from './i18n.js';
import { HeadMetadata } from './components/HeadMetadata.jsx';

const PAGES = {
  example: lazy(() => import('./pages/Example.jsx')),
  snapshots: lazy(() => import('./pages/Snapshots.jsx')),
  planner: lazy(() => import('./pages/Planner.jsx')),
  briefing: lazy(() => import('./pages/Briefing.jsx')),
  evidence: lazy(() => import('./pages/Evidence.jsx')),
  changes: lazy(() => import('./pages/Changes.jsx')),
  verification: lazy(() => import('./pages/Verification.jsx')),
  caseStudy: lazy(() => import('./pages/CaseStudy.jsx')),
  settings: lazy(() => import('./pages/Settings.jsx')),
};
const EvidenceInspector = lazy(() => import('./components/EvidenceInspector.jsx'));

export default function App() {
  const page = useApp((state) => state.page);
  const setPage = useApp((state) => state.setPage);
  const language = useApp((state) => state.language);
  const Page = PAGES[page] ?? PAGES.snapshots;

  useEffect(() => {
    const sync = () => {
      const { page: target, snapshotId } = parseRoute(location.hash);
      if (target) {
        setPage(target, false);
        const state = useApp.getState();
        if (snapshotId !== null && (state.snapshotId !== snapshotId || state.snapshotSource !== 'served')) {
          void state.openSnapshot(snapshotId, null, 'briefing', 'served');
        }
      } else {
        history.replaceState(null, '', `${location.pathname}${location.search}#${pageHash(useApp.getState().page)}`);
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [setPage]);

  useEffect(() => {
    track('page_view', { page });
  }, [page]);

  return (
    <>
      <LocalizedDocument language={language} />
      <HeadMetadata language={language} />
      <Shell page={page} onNavigate={setPage}>
        {/* Dispose the old page's imperative map even if the next page suspends. */}
        <Suspense key={page} fallback={<div className="p-8 font-instrument text-ink-soft">Loading passage instruments…</div>}>
          <Page />
        </Suspense>
        <Suspense fallback={null}><EvidenceInspector /></Suspense>
      </Shell>
    </>
  );
}
