import clsx from 'clsx';
import { useApp } from '../stores/appStore.js';

const STAGES = [
  { id: 'plan', label: 'Plan', pages: ['planner', 'snapshots', 'settings'], target: 'planner' },
  { id: 'brief', label: 'Brief', pages: ['briefing', 'evidence'], target: 'briefing' },
  { id: 'watch', label: 'Watch', pages: ['changes'], target: 'changes' },
  { id: 'verify', label: 'Verify', pages: ['verification', 'caseStudy'], target: 'verification' },
];

const SUBVIEWS = {
  plan: [['planner', 'Passage'], ['snapshots', 'My briefings'], ['settings', 'My limits']],
  brief: [['briefing', 'Causal brief'], ['evidence', 'Evidence']],
  watch: [['changes', 'Changes']],
  verify: [['verification', 'Track record'], ['caseStudy', 'Case study']],
};

export default function Shell({ page, onNavigate, children }) {
  const snapshotId = useApp((state) => state.snapshotId);
  const active = STAGES.find((stage) => stage.pages.includes(page)) ?? STAGES[0];
  const navigateStage = (stage) => {
    if (stage.id === 'brief' && !snapshotId) onNavigate('snapshots');
    else onNavigate(stage.target);
  };
  return (
    <div className="min-h-screen bg-paper pb-16 md:pb-0">
      <a href="#main-content" className="sr-only focus:not-sr-only fixed left-3 top-3 z-[100] bg-paper border border-ink px-3 py-2">Skip to briefing content</a>
      <header className="sticky top-0 z-30 bg-ink-deep text-paper border-b border-paper/20">
        <div className="h-14 px-3 sm:px-5 flex items-center gap-4">
          <button type="button" onClick={() => onNavigate('snapshots')} className="min-h-11 flex items-center gap-2" aria-label="Passage home">
            <CompassMark />
            <span className="hidden sm:inline font-instrument tracking-[0.08em]"><span className="font-semibold">Passage</span> <span className="text-paper/60 text-xs">by DeepRegatta</span></span>
          </button>
          <nav aria-label="Passage stages" className="hidden md:flex self-stretch flex-1 justify-center">
            {STAGES.map((stage, index) => <StageButton key={stage.id} stage={stage} index={index} active={active.id === stage.id} onClick={() => navigateStage(stage)} />)}
          </nav>
          <div className="ml-auto font-instrument text-[11px] text-paper/60 hidden sm:block">{snapshotId ? <span className="font-mono text-[10px]">SNAPSHOT {snapshotId.slice(-8)}</span> : 'no briefing open yet'}</div>
        </div>
        <nav aria-label={`${active.label} views`} className="h-9 px-3 sm:px-5 flex items-end gap-1 bg-paper text-ink border-b hairline overflow-x-auto">
          {SUBVIEWS[active.id].map(([id, label]) => (
            <button key={id} type="button" onClick={() => onNavigate(id)} disabled={['briefing', 'evidence'].includes(id) && !snapshotId} className={clsx('min-h-9 px-3 font-instrument text-xs border-b-2 whitespace-nowrap', page === id ? 'border-event text-ink' : 'border-transparent text-ink-soft hover:text-ink', !snapshotId && ['briefing', 'evidence'].includes(id) && 'opacity-40')}>{label}</button>
          ))}
        </nav>
      </header>
      <main id="main-content" className="min-w-0">{children}</main>
      <nav aria-label="Passage stages" className="md:hidden fixed bottom-0 inset-x-0 h-16 z-40 bg-ink-deep text-paper grid grid-cols-4 border-t border-paper/20">
        {STAGES.map((stage, index) => <StageButton key={stage.id} stage={stage} index={index} active={active.id === stage.id} onClick={() => navigateStage(stage)} mobile />)}
      </nav>
    </div>
  );
}

function StageButton({ stage, index, active, onClick, mobile = false }) {
  return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={clsx('relative min-h-11 font-instrument uppercase tracking-[0.12em] transition-colors', mobile ? 'flex flex-col items-center justify-center text-[10px]' : 'px-8 text-xs', active ? 'text-white' : 'text-paper/55 hover:text-paper')}>
    <span className="font-mono text-[8px] opacity-60">0{index + 1}</span><span>{stage.label}</span>{active && <span className={clsx('absolute bg-event', mobile ? 'top-0 inset-x-3 h-0.5' : 'bottom-0 inset-x-5 h-0.5')} />}
  </button>;
}

function CompassMark() {
  return <svg width="28" height="28" viewBox="0 0 30 30" aria-hidden><circle cx="15" cy="15" r="13" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M15 3 L17 13 L15 15 L13 13 Z" fill="currentColor"/><path d="M15 27 L13 17 L15 15 L17 17 Z" fill="none" stroke="currentColor"/></svg>;
}
