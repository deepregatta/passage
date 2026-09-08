import { useEffect, useRef } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtTime } from '../lib/format.js';

export function isEmulatedWarning(evidence, warnings) {
  return evidence?.source_kind === 'emulated' || warnings?.source?.mode === 'synthetic';
}

export default function BulletinPanel({ evidence, onClose }) {
  const warnings = useApp((state) => state.warnings);
  const emulated = isEmulatedWarning(evidence, warnings);
  const closeRef = useRef(null);
  const ref = evidence?.bulletin_ref;
  const bulletins = warnings?.bulletins?.filter(
    (item) => !ref?.zone_ids?.length || ref.zone_ids.includes(item.zone_id),
  ) ?? [];

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ageHours = ref?.issued_at ? Math.max(0, (Date.now() - Date.parse(ref.issued_at)) / 3600_000) : null;
  return (
    <div className="fixed inset-0 z-[70] bg-ink-deep/40 flex justify-end" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="h-full w-[32rem] max-w-full bg-paper border-l border-ink/40 overflow-y-auto p-5" role="dialog" aria-modal="true" aria-labelledby="bulletin-title">
        <div className="flex justify-between gap-4 border-b border-ink/30 pb-3">
          <div>
            <p className="eyebrow">{emulated ? 'Emulated bulletin' : 'Source bulletin'}</p>
            <h2 id="bulletin-title" className="font-story text-2xl">{ref?.source ?? evidence?.model ?? 'Marine bulletin'}</h2>
            {emulated && <span className="stamp-emulated">EMULATED WARNING SCENARIO</span>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 min-w-11" aria-label="Close bulletin">✕</button>
        </div>
        {emulated && <p className="mt-4 font-instrument text-sm">Emulated bulletin. Do not use for a real passage decision.</p>}
        {ref && (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 py-4 font-instrument text-sm border-b hairline">
            <dt className="eyebrow">Issued</dt><dd className="font-mono">{fmtTime(ref.issued_at)} UTC{ageHours != null ? ` · ${Math.round(ageHours)} h old` : ''}</dd>
            <dt className="eyebrow">Valid</dt><dd className="font-mono">{fmtTime(ref.valid_from)} → {fmtTime(ref.valid_to)} UTC</dd>
            <dt className="eyebrow">Zones</dt><dd>{ref.zone_ids.join(', ')}</dd>
          </dl>
        )}
        {bulletins.length ? bulletins.map((bulletin) => (
          <article key={`${bulletin.zone_id}-${bulletin.valid_from}`} className="py-5 border-b hairline last:border-0">
            <p className="eyebrow">{bulletin.zone_name ?? bulletin.zone_id} · {bulletin.kind}</p>
            <pre className="mt-3 whitespace-pre-wrap font-mono text-[12px] leading-relaxed bg-white/40 border hairline p-4">{bulletin.raw_text}</pre>
          </article>
        )) : (
          <div className="my-6 border border-dashed hairline p-5 font-instrument text-sm text-ink-soft">
            Bulletin text not archived for this legacy snapshot. Use the source and validity details above to find the authority record.
          </div>
        )}
      </aside>
    </div>
  );
}
