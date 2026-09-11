import { lazy, Suspense } from 'react';

const ECharts = lazy(() => import('./EChartsCore.jsx'));
export default function EChartsLazy(props) {
  return <Suspense fallback={<div className="h-full min-h-64 grid place-items-center font-instrument text-sm text-ink-soft">Drawing forecast…</div>}><ECharts {...props} /></Suspense>;
}
