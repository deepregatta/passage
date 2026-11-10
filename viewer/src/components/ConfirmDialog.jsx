import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** A modal confirmation for something that cannot be undone. Focus starts on
 * the safe choice (Cancel), stays inside while open, Escape cancels, and focus
 * goes back to the control that opened it. `heading` and `children` are rendered
 * as given: the caller composes them, including any name the sailor typed. */
export default function ConfirmDialog({ heading, headingProps, children, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const headingId = useId();
  const bodyId = useId();
  // The effect below must run once: re-running it would move focus and lose the opener.
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; });

  useEffect(() => {
    const returnFocus = document.activeElement;
    cancelRef.current?.focus();
    // The page behind the dialog must not scroll while it is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel.current(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (!dialogRef.current?.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-deep/40" onClick={onCancel} aria-hidden />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        className="relative w-full max-w-md bg-paper border border-ink/40 shadow-panel rounded-sm p-5 max-h-full overflow-y-auto"
      >
        <h2 id={headingId} className="font-chart text-2xl leading-tight break-words" {...headingProps}>{heading}</h2>
        <div id={bodyId} className="mt-3 space-y-2 font-sans text-sm text-ink">{children}</div>
        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="min-h-11 px-4 border hairline rounded-sm font-medium hover:border-ink-soft">
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className="min-h-11 px-4 rounded-sm font-medium bg-verdict-exceeds text-white hover:opacity-90">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
