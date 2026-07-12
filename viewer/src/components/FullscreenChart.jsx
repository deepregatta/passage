import { useEffect } from 'react';

export default function FullscreenChart({ open, title, onClose, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-[80] bg-paper p-3 sm:p-6 overflow-auto" role="dialog" aria-modal="true" aria-label={title}>
    <div className="flex justify-between items-center mb-3 border-b border-ink/40 pb-2"><h2 className="font-instrument uppercase tracking-wider">{title}</h2><button type="button" onClick={onClose} className="min-w-11 min-h-11" aria-label="Close full-screen chart">✕</button></div>{children}
  </div>;
}
