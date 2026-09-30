import { useEffect, useRef } from 'react';
import { withUtm } from '../lib/analytics.js';
import clsx from 'clsx';
import { useApp } from '../stores/appStore.js';
import FooterActions from './FooterActions.jsx';

// Two places: plan a new passage, or return to the passages already checked.
// A passage's briefing, evidence, changes and outcome live on its own page.
const PLACES = [
  { id: 'plan', label: 'Plan', pages: ['planner', 'grib'], target: 'planner' },
  { id: 'passages', label: 'My passages', pages: ['passages', 'briefing', 'example'], target: 'passages' },
];

export default function Shell({ page, onNavigate, children }) {
  const mainRef = useRef(null);
  const language = useApp((state) => state.language);
  const setLanguage = useApp((state) => state.setLanguage);
  const openLimits = useApp((state) => state.openLimits);
  const limitsOpen = useApp((state) => state.limitsOpen);
  const active = PLACES.find((place) => place.pages.includes(page));
  return (
    <div className="min-h-screen bg-paper pb-16 md:pb-0 flex flex-col">
      <a href="#main-content" onClick={(event) => {
        // The fragment belongs to the application router, not in-page navigation.
        event.preventDefault();
        mainRef.current?.focus();
      }} className="sr-only focus:not-sr-only fixed left-3 top-3 z-[100] bg-paper border border-ink px-3 py-2">Skip to briefing content</a>
      <header className="sticky top-0 z-30 bg-ink-deep text-paper border-b border-paper/20">
        <div className="h-14 px-3 sm:px-5 flex items-center gap-4">
          <button type="button" onClick={() => onNavigate('planner')} className="min-h-11 flex items-center gap-2" aria-label="Passage home">
            <CompassMark />
            <span className="hidden sm:inline font-instrument tracking-[0.08em]"><span className="font-semibold">Passage</span> <span className="text-paper/60 text-xs">by DeepRegatta</span></span>
          </button>
          <nav aria-label="Main navigation" className="hidden md:flex self-stretch flex-1 justify-center">
            {PLACES.map((place) => <PlaceButton key={place.id} place={place} active={active?.id === place.id} onClick={() => onNavigate(place.target)} />)}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <LimitsChip onClick={openLimits} expanded={limitsOpen} />
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
      </header>
      <main ref={mainRef} id="main-content" tabIndex={-1} className="min-w-0 flex-1">{children}</main>
      <SiteFooter onNavigate={onNavigate} />
      <nav aria-label="Main navigation" className="md:hidden fixed bottom-0 inset-x-0 h-16 z-40 bg-ink-deep text-paper grid grid-cols-3 border-t border-paper/20">
        {PLACES.map((place) => <PlaceButton key={place.id} place={place} active={active?.id === place.id} onClick={() => onNavigate(place.target)} mobile />)}
        <button type="button" onClick={openLimits} aria-expanded={limitsOpen} className={clsx('relative min-h-11 flex flex-col items-center justify-center font-instrument uppercase tracking-[0.12em] text-[11px]', limitsOpen ? 'text-white' : 'text-paper/60')}>
          Limits
          {limitsOpen && <span className="absolute bg-event top-0 inset-x-3 h-0.5" />}
        </button>
      </nav>
    </div>
  );
}

/** The limits every new check uses, always in view and one click from editing. */
function LimitsChip({ onClick, expanded }) {
  const limits = useApp((state) => state.limits);
  const ensureLimits = useApp((state) => state.ensureLimits);
  useEffect(() => { void ensureLimits(); }, [ensureLimits]);
  const sustained = limits ? Math.min(...['upwind', 'reach', 'downwind'].map((key) => limits.max_sustained_kt[key] ?? limits.max_sustained_kt.default)) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label="Edit my limits"
      className="hidden md:flex min-h-9 items-center gap-2 border border-paper/35 rounded-sm px-2.5 text-paper/90 hover:border-paper hover:text-paper"
    >
      <span className="font-instrument text-[11px] uppercase tracking-[0.14em] text-paper/60">Limits</span>
      {limits && (
        <span className="font-mono text-[11px] whitespace-nowrap" title="Wind / gust limits">
          {`${sustained} / ${limits.max_gust_kt} kt`}
          <span className="hidden xl:inline">{` · ${limits.max_wave_height_m} m`}</span>
        </span>
      )}
      <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" className="opacity-70"><path d="M8.5 1.5l2 2L4 10H2V8z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
    </button>
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
    <footer className="mt-12 border-t border-ink/25 bg-paper-deep/55 print:hidden" aria-label="DeepRegatta information">
      <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        <div className="mb-4 border-b hairline pb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <button type="button" onClick={() => onNavigate('about')} className="font-instrument text-sm text-event underline-offset-4 hover:underline">
            About the data
          </button>
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

function PlaceButton({ place, active, onClick, mobile = false }) {
  return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={clsx('relative min-h-11 font-instrument uppercase tracking-[0.12em] transition-colors', mobile ? 'flex flex-col items-center justify-center text-[11px]' : 'px-8 text-xs', active ? 'text-white' : 'text-paper/60 hover:text-paper')}>
    {place.label}{active && <span className={clsx('absolute bg-event', mobile ? 'top-0 inset-x-3 h-0.5' : 'bottom-0 inset-x-5 h-0.5')} />}
  </button>;
}

function CompassMark() {
  return <img src="/brand/mark-reversed.svg" alt="" width="28" height="28" aria-hidden />;
}
