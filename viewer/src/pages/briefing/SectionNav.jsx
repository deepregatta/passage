import clsx from 'clsx';
import { fadeStyle, revealTab, scrollToSection, useSectionNav } from '../../hooks/useSectionNav.js';

export { revealTab, scrollToSection };

export const SECTIONS = [
  ['story', 'Story'],
  ['route', 'Along the route'],
  ['evidence', 'Evidence'],
  ['changes', 'What changed'],
  ['outcome', 'How it turned out'],
];

/** One passage, one page: the sections are places on it, not separate views. */
export default function SectionNav() {
  const { active, edges, barRef, tabRefs } = useSectionNav();
  return (
    <nav aria-label="Passage sections" data-print-hide className="sticky top-14 z-20 bg-paper border-b hairline">
      <div className="relative max-w-[1600px] mx-auto">
        <div ref={barRef} data-testid="section-tabs" className="relative px-3 sm:px-5 flex gap-1 overflow-x-auto">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              ref={(node) => { tabRefs.current[id] = node; }}
              type="button"
              onClick={() => scrollToSection(id)}
              aria-current={active === id ? 'location' : undefined}
              className={clsx('min-h-11 px-3 font-instrument text-sm border-b-2 whitespace-nowrap', active === id ? 'border-event text-ink' : 'border-transparent text-ink-soft hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </div>
        {edges.start && <span aria-hidden data-testid="tabs-fade-start" className="pointer-events-none absolute inset-y-0 left-0" style={fadeStyle('right')} />}
        {edges.end && <span aria-hidden data-testid="tabs-fade-end" className="pointer-events-none absolute inset-y-0 right-0" style={fadeStyle('left')} />}
      </div>
    </nav>
  );
}
