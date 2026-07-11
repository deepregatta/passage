import { useEffect, useState } from 'react';
import { diffFindings } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { Panel, EvidenceLink, VerdictChip } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';

const KIND_META = {
  verdict_changed: { glyph: '◆', label: 'verdict' },
  event_shifted: { glyph: '↷', label: 'timing' },
  value_changed: { glyph: 'Δ', label: 'value' },
  event_new: { glyph: '+', label: 'new' },
  event_gone: { glyph: '−', label: 'cleared' },
  source_updated: { glyph: '↻', label: 'source' },
};

export default function Changes() {
  const findings = useApp((s) => s.findings);
  const manifest = useApp((s) => s.manifest);
  const loadManifest = useApp((s) => s.loadManifest);
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    if (!manifest) loadManifest();
  }, [manifest, loadManifest]);

  useEffect(() => {
    if (!findings || !manifest) return;
    // previous = most recent OLDER snapshot of the same passage (route + departure)
    const previous = manifest.snapshots
      .filter(
        (s) =>
          s.route_id === findings.route_id &&
          s.departure_utc === findings.departure_utc &&
          s.snapshot_id !== findings.snapshot_id &&
          Date.parse(s.created_at) <= Date.parse(findings.generated_at),
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

    if (!previous) {
      setState({ status: 'first', changes: diffFindings(null, findings) });
      return;
    }
    setState({ status: 'loading' });
    fetch(`/data/snapshots/${previous.snapshot_id}/findings.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((prevFindings) =>
        setState({ status: 'ok', previous: prevFindings, changes: diffFindings(prevFindings, findings) }),
      )
      .catch((e) => setState({ status: 'error', error: e.message }));
  }, [findings, manifest]);

  if (!findings) return <p className="p-10 font-sans text-ink-soft">Open a snapshot first.</p>;

  return (
    <div className="px-6 py-5 max-w-4xl">
      <h1 className="font-chart text-3xl mb-1">What changed</h1>
      <p className="font-sans text-sm text-ink-soft mb-5">
        This analysis compared with the previous one for the same passage and departure.
        Every change cites its evidence pair.
      </p>

      {state.status === 'first' && (
        <Panel title="First analysis of this passage">
          <p className="font-sans text-sm text-ink-soft">
            Nothing to compare yet. Run the analysis again after the next model run (forecasts
            update several times a day) and the differences will appear here.
          </p>
        </Panel>
      )}
      {state.status === 'error' && (
        <p className="font-sans text-sm text-verdict-exceeds">ledger error: {state.error}</p>
      )}

      {state.status === 'ok' && (
        <>
          <div className="flex items-center gap-3 mb-4 font-sans text-sm">
            <VerdictChip state={state.changes.verdict_transition.from} small />
            <span className="text-ink-soft">→</span>
            <VerdictChip state={state.changes.verdict_transition.to} small />
            <span className="font-mono text-[11px] text-ink-soft ml-2">
              {state.changes.previous_snapshot_id} → {state.changes.snapshot_id}
            </span>
          </div>

          {state.changes.entries.length === 0 ? (
            <Panel title="No material changes">
              <p className="font-sans text-sm text-ink-soft">
                The new analysis tells the same story as the previous one — steadiness between
                runs is itself useful information (though agreement is not proof).
              </p>
            </Panel>
          ) : (
            <Panel title={`Change ledger · ${state.changes.entries.length} entries`}>
              <ul className="divide-y divide-line">
                {state.changes.entries.map((entry, i) => (
                  <li key={i} className="py-2.5 flex gap-3 items-baseline">
                    <span className="font-mono text-ink-soft w-5 text-center" aria-hidden>
                      {KIND_META[entry.kind]?.glyph ?? '·'}
                    </span>
                    <div className="flex-1">
                      <p className="font-sans text-[14px] leading-relaxed">{entry.description}</p>
                      {entry.evidence_pair?.length > 0 && (
                        <p className="font-mono text-[11px] text-ink-soft mt-0.5">
                          evidence:{' '}
                          {entry.evidence_pair.map((id, j) => (
                            <span key={j}>
                              {j > 0 && ' → '}
                              <EvidenceLink evidenceId={id}>{id}</EvidenceLink>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                    <span className="eyebrow">{KIND_META[entry.kind]?.label}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
