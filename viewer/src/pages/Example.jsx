import { useEffect } from 'react';
import { useApp } from '../stores/appStore.js';
import Briefing from './Briefing.jsx';

/** Durable, reloadable entry to the served example. Never runs the planner. */
export default function Example() {
  const loadExample = useApp((s) => s.loadExample);
  const loading = useApp((s) => s.loading);
  const error = useApp((s) => s.loadError);
  const findings = useApp((s) => s.findings);
  useEffect(() => { void loadExample(); }, [loadExample]);
  return (
    <div>
      <section className="px-4 sm:px-6 py-2 border-b border-ink/30 bg-paper flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Example briefing">
        <h2 className="font-instrument font-semibold uppercase tracking-wider text-sm">Example briefing</h2>
        <p className="font-instrument text-sm">Synthetic / emulated example. Not a live forecast or a safety decision.</p>
        <a href="#plan" className="inline-flex min-h-11 items-center underline underline-offset-4 text-sm text-event sm:ml-auto">Plan my own passage</a>
      </section>
      {error ? <div role="alert" className="p-6">
        <p>The example could not be loaded. Try again or return to the planner.</p>
        <button type="button" onClick={() => void loadExample()} className="min-h-11 underline">Try again</button>
      </div> : loading || !findings ? <p role="status" className="p-6">Loading example briefing…</p> : <Briefing />}
    </div>
  );
}
