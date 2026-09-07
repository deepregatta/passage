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
      <section className="px-4 sm:px-6 py-4 border-b border-ink/30 bg-paper" aria-label="Example briefing">
        <h1 className="font-chart text-2xl">Example briefing</h1>
        <p className="mt-1 font-instrument text-sm">Synthetic / emulated example. Not a live forecast or a safety decision.</p>
        <p className="mt-1 text-sm text-ink-soft">First: inspect the warning and its bulletin. Official information and skipper judgement remain authoritative.</p>
        <a href="#plan/planner" className="inline-flex min-h-11 items-center underline underline-offset-4 text-sm">Plan my own passage</a>
      </section>
      {error ? <div role="alert" className="p-6">
        <p>The example could not be loaded. Try again or return to the planner.</p>
        <button type="button" onClick={() => void loadExample()} className="min-h-11 underline">Try again</button>
      </div> : loading || !findings ? <p role="status" className="p-6">Loading example briefing…</p> : <Briefing />}
    </div>
  );
}
