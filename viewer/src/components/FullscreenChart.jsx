import { useEffect } from 'react';

/** Full-viewport dialog. Its height is the dynamic viewport (100dvh, with
 * 100vh as the fallback), the header keeps its own height and the content area
 * takes the rest; a chart inside fills it and re-measures itself when the
 * viewport changes (phone toolbars, orientation). */
export default function FullscreenChart({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed left-0 right-0 top-0 h-screen z-[80] bg-paper p-3 sm:p-6 flex flex-col overflow-y-auto" style={{ height: '100dvh' }} role="dialog" aria-modal="true" aria-label={title}>
    <div className="flex justify-between items-center mb-3 border-b border-ink/40 pb-2 shrink-0"><h2 className="font-instrument uppercase tracking-wider">{title}</h2><button type="button" onClick={onClose} className="min-w-11 min-h-11" aria-label="Close full-screen chart">✕</button></div>
    <div className="flex-1 flex flex-col">{children}</div>
  </div>;
}
