import { useEffect, useRef, useState } from 'react';
import { palette, rgba } from '../lib/palette.js';

export const SECTION_IDS = ['story', 'route', 'evidence', 'changes', 'outcome'];

export const FADE_PX = 32;
// Sections land at 112 px (scroll-mt-28) under the ~56 px header plus ~45 px tab bar from md up;
// below md the header scrolls away, so they land at 56 px (scroll-mt-14) under the tab bar alone.
const spyLine = () => (typeof matchMedia === 'function' && !matchMedia('(min-width: 768px)').matches ? 84 : 140);
const PIN_EVENT = 'passage-section-pin';

const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function scrollToSection(id) {
  window.dispatchEvent(new CustomEvent(PIN_EVENT, { detail: id }));
  document.querySelector(`[data-section="${id}"]`)?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/**
 * Horizontal-only: bring the tab fully inside the scrolling bar (centred, clear
 * of the edge fades). Never uses scrollIntoView, which would also move the page.
 */
export function revealTab(bar, tab, behavior = 'auto') {
  if (!bar || !tab) return;
  const left = tab.offsetLeft;
  const right = left + tab.offsetWidth;
  const view = bar.scrollLeft;
  if (left - FADE_PX >= view && right + FADE_PX <= view + bar.clientWidth) return;
  const max = Math.max(0, bar.scrollWidth - bar.clientWidth);
  const target = Math.min(max, Math.max(0, left - (bar.clientWidth - tab.offsetWidth) / 2));
  if (typeof bar.scrollTo === 'function') bar.scrollTo({ left: target, behavior });
  else bar.scrollLeft = target;
}

/** Paper-coloured edge fade that says "this bar scrolls". */
export function fadeStyle(side) {
  return { background: `linear-gradient(to ${side}, ${palette.paper.DEFAULT}, ${rgba(palette.paper.DEFAULT, 0)})`, width: FADE_PX };
}

/** Active section (scroll-spy), keeping its tab on screen, and the bar's overflow edges. */
export function useSectionNav() {
  const [active, setActive] = useState(SECTION_IDS[0]);
  const [edges, setEdges] = useState({ start: false, end: false });
  const barRef = useRef(null);
  const tabRefs = useRef({});
  const pinned = useRef(null);

  useEffect(() => {
    // the section whose top has passed under the sticky bars is the one being read;
    // at the very bottom, the last section is, however short it is.
    // After a tab click the clicked tab stays highlighted while the smooth scroll
    // passes the sections in between; the true position is read once it settles.
    let frame = null;
    let settle = null;
    const update = () => {
      frame = null;
      if (pinned.current) return;
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = SECTION_IDS[0];
      for (const id of SECTION_IDS) {
        const top = document.querySelector(`[data-section="${id}"]`)?.getBoundingClientRect().top;
        if (top !== undefined && (top <= spyLine() || bottom)) current = id;
      }
      setActive(current);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const release = (delay) => {
      clearTimeout(settle);
      settle = setTimeout(() => { pinned.current = null; schedule(); }, delay);
    };
    const onScroll = () => (pinned.current ? release(150) : schedule());
    const onPin = (event) => {
      pinned.current = event.detail;
      setActive(event.detail);
      release(600); // no scroll at all (already there): release anyway
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener(PIN_EVENT, onPin);
    schedule();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      window.removeEventListener(PIN_EVENT, onPin);
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, []);

  // keep the active tab on screen, whatever moved it (click, scroll-spy, deep link)
  useEffect(() => {
    revealTab(barRef.current, tabRefs.current[active], prefersReducedMotion() ? 'auto' : 'smooth');
  }, [active]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    const measure = () => {
      const start = bar.scrollLeft > 1;
      const end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    bar.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { bar.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, []);

  return { active, edges, barRef, tabRefs };
}
