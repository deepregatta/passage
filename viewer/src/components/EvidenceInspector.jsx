import { useEffect, useRef } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtTime, runAge } from '../lib/format.js';
import { SourceKindChip } from './common.jsx';

/**
 * The chart title block: rule → source → run age → leg/hour → value vs limit.
 * Every claim in the product resolves here. "Agreement is not proof." stays pinned.
 */
export default function EvidenceInspector() {
  const evidenceId = useApp((s) => s.selectedEvidenceId);
  const open = useApp((s) => s.inspectorOpen);
  const evidence = useApp((s) => s.evidenceById(s.selectedEvidenceId));
  const findings = useApp((s) => s.findings);
  const close = useApp((s) => s.closeInspector);
  const nowMs = useApp((s) => s.nowMs);
  const dialogRef = useRef(null);
  const returnFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])') ?? [])];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); returnFocus.current?.focus?.(); };
  }, [close, open]);

  if (!open || !evidenceId || !evidence) return null;

  const legName = findings?.legs.find((l) => l.leg_id === evidence.leg_id)?.name;
  const sourceMeta = findings?.inputs.openmeteo.find(
    (m) =>
      m.model === evidence.model ||
      (evidence.source_kind === 'ensemble' && m.api === 'ensemble') ||
      (String(evidence.model ?? '').startsWith('marine') && m.api === 'marine'),
  );
  const age = sourceMeta ? runAge(sourceMeta.fetched_at, nowMs) : null;
  const frac = evidence.member_fraction;

  return (
    <>
      <div
        className="fixed inset-0 bg-ink-deep/30 z-40"
        onClick={close}
        aria-hidden
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        className="fixed right-0 top-0 h-full w-[24rem] max-w-full bg-paper z-50 border-l border-ink/40 overflow-y-auto"
        role="dialog"
        aria-label="Evidence inspector"
      >
        <div className="titleblock m-3 p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="eyebrow">Evidence</span>
            <button
              type="button"
              onClick={close}
              className="text-ink-soft hover:text-ink font-sans text-sm px-2"
              aria-label="Close inspector"
            >
              ✕
            </button>
          </div>

          <Row label="Rule">
            <span className="font-mono">{evidence.rule_id}</span>
          </Row>
          <Row label="Leg & window">
            <div>
              <span className="font-mono">{evidence.leg_id}</span>
              {legName && <span className="text-ink-soft"> · {legName}</span>}
            </div>
            {evidence.valid_time && (
              <div className="font-mono text-sm">{fmtTime(evidence.valid_time)} UTC</div>
            )}
          </Row>
          <Row label="Data source">
            <span className="font-mono">{evidence.model ?? '—'}</span>
            <div className="mt-1">
              <SourceKindChip kind={evidence.source_kind} />
            </div>
          </Row>
          <Row label="Model run">
            <span className="font-mono text-sm">{evidence.run ?? 'not applicable'}</span>
          </Row>
          {age && (
            <Row label="Source age">
              <span className="font-mono">{age}</span>
            </Row>
          )}

          <div className="mt-4 pt-3 border-t hairline">
            <span className="eyebrow">Value vs declared limit</span>
            {frac ? (
              <FractionBlock frac={frac} limit={evidence.limit} units={evidence.units} />
            ) : (
              <div className="mt-2 font-mono text-2xl">
                {formatValue(evidence.value)}
                <span className="text-ink-soft text-base"> / {formatValue(evidence.limit)} </span>
                <span className="text-ink-soft text-sm">{evidence.units}</span>
              </div>
            )}
          </div>

          <div className="mt-5 border border-ink/25 bg-shoal/40 px-3 py-2 text-sm font-sans">
            Agreement is not proof. Models share observations and assumptions; disagreement
            mainly says when to wait for the next run.
          </div>
        </div>
      </aside>
    </>
  );
}

function Row({ label, children }) {
  return (
    <div className="py-2 border-b hairline last:border-0">
      <div className="eyebrow mb-0.5">{label}</div>
      <div className="font-sans text-[15px]">{children}</div>
    </div>
  );
}

function FractionBlock({ frac, limit, units }) {
  const pct = Math.round((frac.exceed / frac.total) * 100);
  return (
    <div className="mt-2">
      <div className="font-mono text-2xl">
        {frac.exceed} of {frac.total}
      </div>
      <div className="font-sans text-sm text-ink-soft mb-2">
        forecast scenarios exceed {formatValue(limit)} {units} — raw fraction ({pct}%), not a
        calibrated probability
      </div>
      <div className="h-2 bg-shoal rounded-sm overflow-hidden" aria-hidden>
        <div className="h-full bg-verdict-exceeds" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatValue(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
