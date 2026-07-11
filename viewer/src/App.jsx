import { useApp } from './stores/appStore.js';
import Snapshots from './pages/Snapshots.jsx';
import Briefing from './pages/Briefing.jsx';
import Evidence from './pages/Evidence.jsx';
import Settings from './pages/Settings.jsx';
import EvidenceInspector from './components/EvidenceInspector.jsx';
import clsx from 'clsx';

const NAV = [
  { id: 'snapshots', label: 'Analyses', ready: true },
  { id: 'planner', label: 'Planner', ready: false },
  { id: 'briefing', label: 'Briefing', ready: true },
  { id: 'evidence', label: 'Evidence', ready: true },
  { id: 'changes', label: 'Changes', ready: false },
  { id: 'verification', label: 'Verification', ready: false },
  { id: 'settings', label: 'Settings', ready: true },
];

const PAGES = { snapshots: Snapshots, briefing: Briefing, evidence: Evidence, settings: Settings };

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const snapshotId = useApp((s) => s.snapshotId);
  const Page = PAGES[page] ?? Snapshots;

  return (
    <div className="min-h-screen flex">
      <nav className="w-44 shrink-0 bg-ink-deep text-paper flex flex-col">
        <div className="px-4 py-5">
          <div className="font-chart text-xl tracking-wide">deepweather</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-50 mt-0.5">
            passage risk audit
          </div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.ready || (['briefing', 'evidence'].includes(item.id) && !snapshotId)}
            onClick={() => setPage(item.id)}
            className={clsx(
              'text-left px-4 py-2 font-sans text-sm transition-colors',
              page === item.id
                ? 'bg-paper text-ink font-medium'
                : item.ready
                  ? 'text-paper/75 hover:text-paper hover:bg-white/5'
                  : 'text-paper/30 cursor-default',
            )}
          >
            {item.label}
            {!item.ready && <span className="font-mono text-[9px] ml-1.5 opacity-60">soon</span>}
          </button>
        ))}
        <div className="mt-auto px-4 py-4 font-sans text-[11px] leading-relaxed text-paper/45">
          Decision aid — never says GO. Official marine forecasts remain the authority of record.
        </div>
      </nav>

      <main className="flex-1 min-w-0">
        <Page />
      </main>

      <EvidenceInspector />
    </div>
  );
}
