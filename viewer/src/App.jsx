import { useApp } from './stores/appStore.js';
import Snapshots from './pages/Snapshots.jsx';
import Planner from './pages/Planner.jsx';
import Briefing from './pages/Briefing.jsx';
import Evidence from './pages/Evidence.jsx';
import Changes from './pages/Changes.jsx';
import Verification from './pages/Verification.jsx';
import Settings from './pages/Settings.jsx';
import EvidenceInspector from './components/EvidenceInspector.jsx';
import clsx from 'clsx';

// minimal line icons, 18px, stroke inherits currentColor
const ICONS = {
  planner: 'M3 15 L8 4 L13 15 M5.2 11 H10.8', // dividers
  snapshots: 'M4 3 H14 V15 H4 Z M6.5 6.5 H11.5 M6.5 9 H11.5 M6.5 11.5 H9.5', // log book
  briefing: 'M9 3 C6 5 4 5 3 4.5 V14 C4 14.5 6 14.5 9 12.5 C12 14.5 14 14.5 15 14 V4.5 C14 5 12 5 9 3 Z M9 3 V12.5', // chart book
  evidence: 'M4 14 L4 9 M8 14 L8 5 M12 14 L12 7 M15 14 L2 14', // bars
  changes: 'M4 6 H12 M10 3.5 L13 6 L10 8.5 M14 12 H6 M8 9.5 L5 12 L8 14.5', // exchange
  verification: 'M9 2.5 L11 4.5 L14 4.8 L14.2 7.8 L16 10 L14.2 12.2 L14 15.2 L11 15.5 L9 17.5 L7 15.5 L4 15.2 L3.8 12.2 L2 10 L3.8 7.8 L4 4.8 L7 4.5 Z M6.5 10 L8.3 11.8 L11.8 8.3', // seal + check
  settings: 'M9 6.5 A2.5 2.5 0 1 0 9 11.5 A2.5 2.5 0 1 0 9 6.5 M9 2 V4 M9 14 V16 M2 9 H4 M14 9 H16 M4 4 L5.4 5.4 M12.6 12.6 L14 14 M14 4 L12.6 5.4 M5.4 12.6 L4 14',
};

const NAV = [
  { id: 'planner', label: 'Planner', ready: true },
  { id: 'snapshots', label: 'Analyses', ready: true },
  { id: 'briefing', label: 'Briefing', ready: true },
  { id: 'evidence', label: 'Evidence', ready: true },
  { id: 'changes', label: 'Changes', ready: true },
  { id: 'verification', label: 'Verification', ready: true },
  { id: 'settings', label: 'Settings', ready: true },
];

const PAGES = {
  snapshots: Snapshots,
  planner: Planner,
  briefing: Briefing,
  evidence: Evidence,
  changes: Changes,
  verification: Verification,
  settings: Settings,
};

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const snapshotId = useApp((s) => s.snapshotId);
  const Page = PAGES[page] ?? Snapshots;

  return (
    <div className="min-h-screen flex">
      <nav className="w-44 shrink-0 bg-ink-deep text-paper flex flex-col">
        <div className="px-4 py-5 flex items-center gap-2.5">
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden className="shrink-0 opacity-90">
            <circle cx="15" cy="15" r="13" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M15 3 L17 13 L15 15 L13 13 Z" fill="currentColor" />
            <path d="M15 27 L13 17 L15 15 L17 17 Z" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3 15 H7 M23 15 H27" stroke="currentColor" strokeWidth="1" />
          </svg>
          <div>
            <div className="font-chart text-lg tracking-wide leading-tight">deepweather</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] opacity-50">
              passage risk audit
            </div>
          </div>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.ready || (['briefing', 'evidence'].includes(item.id) && !snapshotId)}
            onClick={() => setPage(item.id)}
            className={clsx(
              'text-left px-4 py-2 font-sans text-sm transition-colors flex items-center gap-2.5',
              page === item.id
                ? 'bg-paper text-ink font-medium'
                : item.ready
                  ? 'text-paper/75 hover:text-paper hover:bg-white/5'
                  : 'text-paper/30 cursor-default',
            )}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0 opacity-80">
              <path d={ICONS[item.id]} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
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
