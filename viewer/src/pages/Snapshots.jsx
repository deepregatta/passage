import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { VerdictChip } from '../components/common.jsx';
import { capitalize, fmtLocalTime, localTimeZoneName } from '../lib/format.js';
import { translateText } from '../i18n.js';

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
  const deleteSnapshot = useApp((s) => s.deleteSnapshot);
  const loading = useApp((s) => s.loading);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    loadManifest();
  }, [loadManifest]);

  return (
    <div className="px-6 py-5 max-w-4xl">
      <h1 className="font-chart text-3xl mb-1">My briefings</h1>
      <p className="font-sans text-sm text-ink-soft mb-5">
        Briefings are frozen when you make them. Reopen one here, or compare its forecast with
        later observations in Track record.
      </p>

      {manifestError && (
        <p className="font-sans text-sm text-verdict-exceeds">manifest error: {manifestError}</p>
      )}

      {manifest?.snapshots.length === 0 && (
        <div className="border border-dashed hairline rounded-sm p-6 bg-white/30">
          <p className="font-story text-xl">No briefings yet.</p>
          <p className="font-sans text-sm text-ink-soft mt-1">
            Plan a passage, set a departure time and check it against your limits.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {manifest?.snapshots.map((s) => (
          <li key={s.snapshot_id} className="flex items-stretch gap-1.5">
            <button
              type="button"
              disabled={loading}
              onClick={() => openSnapshot(s.snapshot_id)}
              title={s.snapshot_id}
              className="flex-1 min-w-0 text-left bg-white/40 border hairline rounded-sm shadow-panel px-4 py-3 hover:border-ink-soft flex items-center gap-4"
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
                  departing {fmtLocalTime(s.departure_utc)} local time · made {fmtLocalTime(s.created_at)}
                </span>
              </span>
              {s.verdict_state && (
                <span className="shrink-0">
                  <VerdictChip state={s.verdict_state} small />
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label="Delete this briefing"
              title="Delete this briefing"
              disabled={loading}
              onClick={async () => {
                if (!window.confirm(translateText(`Delete the briefing "${routeName(s.route_id)}" departing ${fmtLocalTime(s.departure_utc)} local time (${localTimeZoneName()})? This cannot be undone.`, document.documentElement.lang))) return;
                try {
                  await deleteSnapshot(s.snapshot_id);
                } catch (e) {
                  setDeleteError(e.message);
                }
              }}
              className="shrink-0 px-3 border hairline rounded-sm text-ink-soft hover:text-verdict-exceeds hover:border-verdict-exceeds min-h-11"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {deleteError && (
        <p className="font-sans text-sm text-verdict-exceeds mt-3">{deleteError}</p>
      )}
    </div>
  );
}
