import { lazy, Suspense, useEffect } from 'react';
import { useApp } from './stores/appStore.js';
import Shell from './components/Shell.jsx';
import { HASH_PAGE, PAGE_HASH } from './lib/routes.js';
import { LocalizedDocument } from './i18n.js';
import { HeadMetadata } from './components/HeadMetadata.jsx';

const PAGES = {
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
      const target = HASH_PAGE[location.hash.slice(1)];
      if (target) setPage(target);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [setPage]);

  useEffect(() => {
    const hash = PAGE_HASH[page] ?? PAGE_HASH.planner;
    if (location.hash.slice(1) !== hash) history.replaceState(null, '', `#${hash}`);
  }, [page]);

  return (
    <>
      <LocalizedDocument language={language} />
      <HeadMetadata language={language} />
      <Shell page={page} onNavigate={setPage}>
        <Suspense fallback={<div className="p-8 font-instrument text-ink-soft">Loading passage instruments…</div>}>
          <Page />
        </Suspense>
        <Suspense fallback={null}><EvidenceInspector /></Suspense>
      </Shell>
    </>
  );
}
