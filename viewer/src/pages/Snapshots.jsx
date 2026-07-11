import { useEffect } from 'react';
import { useApp } from '../stores/appStore.js';
import { VerdictChip } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';

export default function Snapshots() {
  const manifest = useApp((s) => s.manifest);
  const manifestError = useApp((s) => s.manifestError);
  const loadManifest = useApp((s) => s.loadManifest);
  const openSnapshot = useApp((s) => s.openSnapshot);
  const loading = useApp((s) => s.loading);

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);

  return (
    <div className="px-6 py-5 max-w-4xl">
      <h1 className="font-chart text-3xl mb-1">Analyses</h1>
      <p className="font-sans text-sm text-ink-soft mb-5">
        Every analysis is an immutable snapshot — inputs, findings, and briefing frozen for later
        verification.
      </p>

      {manifestError && (
        <p className="font-sans text-sm text-verdict-exceeds">manifest error: {manifestError}</p>
      )}

      {manifest?.snapshots.length === 0 && (
        <div className="border border-dashed hairline rounded-sm p-6 bg-white/30">
          <p className="font-sans text-sm text-ink-soft">
            No analyses yet. Run one from the repo root:
          </p>
          <pre className="font-mono text-[12px] mt-2 bg-ink text-paper p-3 rounded-sm overflow-x-auto">
            npm -w engine run cli -- run --departure 2026-07-14T06:00:00Z
          </pre>
        </div>
      )}

      <ul className="space-y-2">
        {manifest?.snapshots.map((s) => (
          <li key={s.snapshot_id}>
            <button
              type="button"
              disabled={loading}
              onClick={() => openSnapshot(s.snapshot_id)}
              className="w-full text-left bg-white/40 border hairline rounded-sm shadow-panel px-4 py-3 hover:border-ink-soft flex items-center justify-between gap-4 flex-wrap"
            >
              <span>
                <span className="font-sans font-medium">{s.route_id}</span>
                <span className="font-mono text-[12px] text-ink-soft block mt-0.5">
                  departure {fmtTime(s.departure_utc)} UTC · created {fmtTime(s.created_at)} ·{' '}
                  {s.snapshot_id}
                </span>
              </span>
              {s.verdict_state && <VerdictChip state={s.verdict_state} small />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
