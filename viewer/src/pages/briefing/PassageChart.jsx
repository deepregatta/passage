import { useState } from 'react';
import clsx from 'clsx';
import RouteMap from '../../components/lazy/LeafletLazy.jsx';
import SynopticHero from '../../components/SynopticHero.jsx';

const VIEWS = [['pressure', 'Pressure chart'], ['map', 'Route map']];

/** One chart for the passage: the pressure pattern behind the forecast, or the
 * route on a map. Both follow the same time cursor. */
export default function PassageChart({ hasSynoptic }) {
  const [view, setView] = useState('pressure');
  if (!hasSynoptic) {
    return (
      <div>
        <p className="font-instrument text-xs text-ink-soft border-l-4 border-line pl-3 py-1 mb-2">
          No synoptic chart was archived with this briefing, so here is your passage
          chart. New briefings show the pressure pattern behind your forecast.
        </p>
        <RouteMap height={430} />
      </div>
    );
  }
  return (
    <div>
      <div role="group" aria-label="Chart view" className="inline-flex mb-2 border border-ink/40 rounded-sm font-instrument text-xs" data-print-hide>
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view === id}
            onClick={() => setView(id)}
            className={clsx('min-h-9 px-3', view === id ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'pressure' ? <SynopticHero /> : <RouteMap height={430} />}
    </div>
  );
}
