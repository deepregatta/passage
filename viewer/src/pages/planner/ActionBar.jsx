import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { reserveBarSpace } from './reserveBarSpace.js';

/**
 * The phone's primary action, pinned above the bottom navigation so Compute and
 * Check stay in reach however far the form is scrolled. It repeats the form's
 * own button and status, so it is hidden from assistive technology and the tab
 * order (the form's controls and their live regions are the accessible ones;
 * a second live region here would announce every message twice).
 * It sticks to the bottom of the viewport inside the page and scrolls away with
 * it, which leaves the footer reachable.
 * It is shown wherever the form is one column under the map (below 1024 px).
 * While it is on the page the document keeps scroll padding for the space it
 * (and, on a phone, the bottom navigation) takes, so a control reached by
 * keyboard or focus is scrolled clear of it instead of ending up underneath.
 */
export default function ActionBar({ label, status, failed, disabled, onClick }) {
  const bar = useRef(null);
  useEffect(() => reserveBarSpace(bar.current), []);
  return (
    <div
      ref={bar}
      aria-hidden="true"
      data-testid="planner-action-bar"
      className="lg:hidden sticky bottom-16 md:bottom-0 z-30 -mx-3 sm:-mx-5 mt-4 bg-paper/95 border-t border-ink/30 shadow-panel md:pb-[env(safe-area-inset-bottom)]"
    >
      <div className="px-3 sm:px-5 py-2 flex items-center gap-3">
        <p className={clsx('min-w-0 flex-1 text-[13px] leading-snug', failed ? 'text-verdict-exceeds' : 'text-ink-soft')}>{status}</p>
        <button
          type="button"
          tabIndex={-1}
          onClick={onClick}
          disabled={disabled}
          className="shrink-0 min-h-11 px-4 bg-ink text-paper font-medium text-[15px] rounded-sm hover:bg-ink-deep disabled:opacity-40"
        >
          {label}
        </button>
      </div>
    </div>
  );
}
