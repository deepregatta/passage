import { withUtm } from '../lib/analytics.js';
import clsx from 'clsx';
import { useApp } from '../stores/appStore.js';
import FooterActions from './FooterActions.jsx';

const STAGES = [
  { id: 'plan', label: 'Plan', pages: ['planner', 'settings'], target: 'planner' },
  { id: 'brief', label: 'Brief', pages: ['snapshots', 'briefing', 'evidence'], target: 'briefing' },
  { id: 'watch', label: 'Watch', pages: ['changes'], target: 'changes' },
  { id: 'verify', label: 'Verify', pages: ['verification', 'caseStudy'], target: 'verification' },
];

const SUBVIEWS = {
  plan: [['planner', 'Passage'], ['settings', 'My limits']],
  brief: [['snapshots', 'My briefings'], ['briefing', 'Causal brief'], ['evidence', 'Evidence']],
  watch: [['changes', 'Changes']],
  verify: [['verification', 'Track record'], ['caseStudy', 'Case study']],
};

export default function Shell({ page, onNavigate, children }) {
  const snapshotId = useApp((state) => state.snapshotId);
  const language = useApp((state) => state.language);
  const setLanguage = useApp((state) => state.setLanguage);
  const active = STAGES.find((stage) => stage.pages.includes(page)) ?? STAGES[0];
  const navigateStage = (stage) => {
    if (stage.id === 'brief' && !snapshotId) onNavigate('snapshots');
    else onNavigate(stage.target);
  };
  return (
    <div className="min-h-screen bg-paper pb-16 md:pb-0 flex flex-col">
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
          <div className="ml-auto flex items-center gap-3">
            <div className="font-instrument text-[11px] text-paper/60 hidden lg:block">{snapshotId ? <span className="font-mono text-[10px]">SNAPSHOT {snapshotId.slice(-8)}</span> : 'no briefing open yet'}</div>
            <div className="flex rounded-sm border border-paper/35 p-0.5 font-mono text-[10px]" role="group" aria-label={language === 'fr' ? 'Choisir la langue' : 'Select language'}>
              {['en', 'fr'].map((code) => (
                <button
                  key={code}
                  type="button"
                  lang={code}
                  aria-pressed={language === code}
                  aria-label={code === 'fr' ? 'Français' : 'English'}
                  onClick={() => setLanguage(code)}
                  className={clsx('min-h-9 min-w-9 px-1.5 transition-colors', language === code ? 'bg-paper text-ink' : 'text-paper/65 hover:text-paper')}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
        <nav aria-label={`${active.label} views`} className="h-9 px-3 sm:px-5 flex items-end gap-1 bg-paper text-ink border-b hairline overflow-x-auto">
          {SUBVIEWS[active.id].map(([id, label]) => (
            <button key={id} type="button" onClick={() => onNavigate(id)} disabled={['briefing', 'evidence'].includes(id) && !snapshotId} className={clsx('min-h-9 px-3 font-instrument text-xs border-b-2 whitespace-nowrap', page === id ? 'border-event text-ink' : 'border-transparent text-ink-soft hover:text-ink', !snapshotId && ['briefing', 'evidence'].includes(id) && 'opacity-40')}>{label}</button>
          ))}
        </nav>
      </header>
      <main id="main-content" className="min-w-0 flex-1">{children}</main>
      <SiteFooter onNavigate={onNavigate} />
      <nav aria-label="Passage stages" className="md:hidden fixed bottom-0 inset-x-0 h-16 z-40 bg-ink-deep text-paper grid grid-cols-4 border-t border-paper/20">
        {STAGES.map((stage, index) => <StageButton key={stage.id} stage={stage} index={index} active={active.id === stage.id} onClick={() => navigateStage(stage)} mobile />)}
      </nav>
    </div>
  );
}

function SiteFooter({ onNavigate }) {
  const year = new Date().getFullYear();
  const links = [
    ['DeepRegatta', 'https://deepregatta.com'],
    ['Privacy', 'https://deepregatta.com/privacy'],
    ['Terms', 'https://deepregatta.com/terms'],
    ['Legal notice', 'https://deepregatta.com/legal'],
  ];

  return (
    <footer className="mt-12 border-t border-ink/25 bg-paper-deep/55" aria-label="DeepRegatta information">
      <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        <div className="mb-4 border-b hairline pb-4">
          <FooterActions onNavigate={onNavigate} />
        </div>
        <div className="flex flex-col gap-4 font-instrument text-sm text-ink-soft lg:flex-row lg:items-center lg:justify-between">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold uppercase tracking-[0.08em] text-ink">Passage</span>
            <span aria-hidden="true">·</span>
            <span>A DeepRegatta instrument for offshore sailors</span>
            <span aria-hidden="true">·</span>
            <span>© {year} DeepRegatta</span>
          </p>
          <nav aria-label="DeepRegatta legal and contact links" className="flex flex-wrap gap-x-5 gap-y-2">
            {links.map(([label, href]) => (
              <a key={href} href={withUtm(href)} className="text-event underline-offset-4 hover:underline">
                {label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}

function StageButton({ stage, index, active, onClick, mobile = false }) {
  return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={clsx('relative min-h-11 font-instrument uppercase tracking-[0.12em] transition-colors', mobile ? 'flex flex-col items-center justify-center text-[10px]' : 'px-8 text-xs', active ? 'text-white' : 'text-paper/55 hover:text-paper')}>
    <span className="font-mono text-[8px] opacity-60">0{index + 1}</span><span>{stage.label}</span>{active && <span className={clsx('absolute bg-event', mobile ? 'top-0 inset-x-3 h-0.5' : 'bottom-0 inset-x-5 h-0.5')} />}
  </button>;
}

function CompassMark() {
  return <img src="/brand/mark-reversed.svg" alt="" width="28" height="28" aria-hidden />;
}
