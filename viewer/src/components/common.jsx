import clsx from 'clsx';
import { useApp } from '../stores/appStore.js';
import { VERDICT } from '../lib/format.js';

/** Inline provenance link — the evidence chain. Dotted underline = has evidence. */
export function EvidenceLink({ evidenceId, children }) {
  const openEvidence = useApp((s) => s.openEvidence);
  return (
    <button type="button" className="evidence-link" onClick={() => openEvidence(evidenceId)}>
      {children}
    </button>
  );
}

export function VerdictChip({ state, small }) {
  const v = VERDICT[state] ?? VERDICT.insufficient;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 font-sans font-medium rounded-sm text-white',
        small ? 'text-[11px] px-2 py-0.5' : 'text-sm px-3 py-1',
      )}
      style={{ backgroundColor: v.hex }}
    >
      <span aria-hidden>{v.glyph}</span>
      {small ? v.label.split(' — ')[0] : v.label}
    </span>
  );
}

export function EmulatedStamp() {
  return <span className="stamp-emulated">emulated</span>;
}

export function SourceKindChip({ kind }) {
  if (kind === 'emulated') return <EmulatedStamp />;
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft border border-line px-1.5 py-0.5 rounded-sm">
      {kind}
    </span>
  );
}

export function Panel({ title, children, className, right }) {
  return (
    <section className={clsx('bg-white/40 border hairline rounded-sm shadow-panel', className)}>
      {title && (
        <header className="flex items-baseline justify-between px-4 pt-3 pb-2 border-b hairline">
          <h2 className="eyebrow">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
