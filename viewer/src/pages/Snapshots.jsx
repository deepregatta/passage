import { useEffect } from 'react';
import { useApp } from '../stores/appStore.js';
import { VerdictChip } from '../components/common.jsx';
import { capitalize, fmtTime } from '../lib/format.js';

/** "cherbourg-plymouth-v1" / "my-passage-5wp" → "Cherbourg plymouth" / "My passage" */
function routeName(routeId) {
  const words = routeId
    .replace(/-(v\d+|\d+wp)$/i, '')
    .split('-')
    .filter(Boolean);
  return capitalize(words.join(' ')) || routeId;
}

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
      <h1 className="font-chart text-3xl mb-1">My briefings</h1>
      <p className="font-sans text-sm text-ink-soft mb-5">
        Every briefing is kept exactly as it was made — so you can re-read it later and see how
        the forecast actually did (that's the Track record page).
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
              title={s.snapshot_id}
              className="w-full text-left bg-white/40 border hairline rounded-sm shadow-panel px-4 py-3 hover:border-ink-soft flex items-center gap-4"
            >
              <span className="min-w-0 flex-1">
                <span className="font-sans font-medium">
                  {routeName(s.route_id)}
                  {s.demo && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft border border-line px-1.5 py-0.5 rounded-sm align-middle">
                      example
                    </span>
                  )}
                </span>
                <span className="font-sans text-[13px] text-ink-soft block mt-0.5">
                  departing {fmtTime(s.departure_utc)} UTC · made {fmtTime(s.created_at)}
                </span>
              </span>
              {s.verdict_state && (
                <span className="shrink-0">
                  <VerdictChip state={s.verdict_state} small />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
