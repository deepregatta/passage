import { useEffect, useState } from 'react';
import clsx from 'clsx';

export const SECTIONS = [
  ['story', 'Story'],
  ['route', 'Along the route'],
  ['evidence', 'Evidence'],
  ['changes', 'What changed'],
  ['outcome', 'How it turned out'],
];

export function scrollToSection(id) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelector(`[data-section="${id}"]`)?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** One passage, one page: the sections are places on it, not separate views. */
export default function SectionNav() {
  const [active, setActive] = useState('story');
  useEffect(() => {
    // the section whose top has passed under the sticky bars is the one being read;
    // at the very bottom, the last section is, however short it is
    let frame = null;
    const update = () => {
      frame = null;
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const top = document.querySelector(`[data-section="${id}"]`)?.getBoundingClientRect().top;
        if (top !== undefined && (top <= 140 || bottom)) current = id;
      }
      setActive(current);
    };
    const onScroll = () => { if (frame === null) frame = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <nav aria-label="Passage sections" data-print-hide className="sticky top-14 z-20 bg-paper/95 border-b hairline">
      <div className="max-w-[1600px] mx-auto px-3 sm:px-5 flex gap-1 overflow-x-auto">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => { setActive(id); scrollToSection(id); }}
            aria-current={active === id ? 'location' : undefined}
            className={clsx('min-h-11 px-3 font-instrument text-sm border-b-2 whitespace-nowrap', active === id ? 'border-event text-ink' : 'border-transparent text-ink-soft hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
