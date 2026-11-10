import { useEffect, useRef } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtAgeOld, fmtTextTime, fmtUtcClock } from '../lib/format.js';

export function isEmulatedWarning(evidence, warnings) {
  return evidence?.source_kind === 'emulated' || warnings?.source?.mode === 'synthetic';
}

// Bulletins are shown verbatim. UK sources (and the synthetic example) are in
// English, Météo-France in French; the feed carries no language field.
const ENGLISH_WORDS = /\b(?:the|and|or|of|for|in|later|expected|becoming|occasionally|veering|backing|gale|warning|wind|rough|moderate|good|poor|rain|showers|never|use)\b/gi;
const FRENCH_WORDS = /(?<![\p{L}])(?:le|la|les|et|ou|du|des|en|vent|mer|avis|coup|grand|frais|houle|agitée|forte|fraîchissant|fin|période|ouest)(?![\p{L}])/giu;

export function isEnglishBulletin(text) {
  const english = text?.match(ENGLISH_WORDS)?.length ?? 0;
  const french = text?.match(FRENCH_WORDS)?.length ?? 0;
  return english > french;
}

export default function BulletinPanel({ evidence, onClose }) {
  const warnings = useApp((state) => state.warnings);
  const language = useApp((state) => state.language);
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

  const ageMs = ref?.issued_at ? Math.max(0, Date.now() - Date.parse(ref.issued_at)) : null;
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
            <dt className="eyebrow">Issued</dt><dd className="font-mono">{fmtTextTime(ref.issued_at)} · {fmtUtcClock(ref.issued_at)}{ageMs != null ? ` · ${fmtAgeOld(ageMs)}` : ''}</dd>
            <dt className="eyebrow">Valid</dt><dd className="font-mono">{fmtTextTime(ref.valid_from)} → {fmtTextTime(ref.valid_to)}<span className="block text-xs text-ink-soft">{fmtUtcClock(ref.valid_from)} → {fmtUtcClock(ref.valid_to)}</span></dd>
            <dt className="eyebrow">Zones</dt><dd>{ref.zone_ids.join(', ')}</dd>
          </dl>
        )}
        {bulletins.length ? bulletins.map((bulletin) => (
          <article key={`${bulletin.zone_id}-${bulletin.valid_from}`} className="py-5 border-b hairline last:border-0">
            <p className="eyebrow">{bulletin.zone_name ?? bulletin.zone_id} · {bulletin.kind}</p>
            {language === 'fr' && isEnglishBulletin(bulletin.raw_text) && (
              <p className="mt-2 font-instrument text-[12px] text-ink-soft">Original text (in English)</p>
            )}
            <pre className="mt-3 whitespace-pre-wrap font-mono text-[12px] leading-relaxed bg-white/40 border hairline p-4">{bulletin.raw_text}</pre>
          </article>
        )) : (
          <div className="my-6 border border-dashed hairline p-5 font-instrument text-sm text-ink-soft">
            Bulletin text not archived for this legacy check. Use the source and validity details above to find the authority record.
          </div>
        )}
      </aside>
    </div>
  );
}
