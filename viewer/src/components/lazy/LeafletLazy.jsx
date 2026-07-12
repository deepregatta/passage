import { lazy, Suspense } from 'react';

const RouteMap = lazy(() => import('../RouteMap.jsx'));
export default function LeafletLazy(props) {
  return <Suspense fallback={<div className="min-h-72 grid place-items-center font-instrument text-sm text-ink-soft">Loading passage chart…</div>}><RouteMap {...props} /></Suspense>;
}
