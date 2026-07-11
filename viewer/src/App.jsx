import { useEffect, useState } from 'react';

// M0 shell: nav skeleton + snapshot manifest readout proving the /data middleware works.
// Real pages (Planner, Briefing, Evidence, Changes, Verification, Settings) land at M4+.
const NAV = ['Planner', 'Briefing', 'Evidence', 'Changes', 'Verification', 'Snapshots', 'Settings'];

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/data/snapshots/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setManifest)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="min-h-screen flex">
      <nav className="w-48 bg-ink-deep text-chart-paper p-4 flex flex-col gap-1">
        <div className="font-serif text-xl tracking-wide mb-6">deepweather</div>
        {NAV.map((item) => (
          <div key={item} className="px-3 py-2 rounded text-sm opacity-70 hover:opacity-100 cursor-default">
            {item}
          </div>
        ))}
        <div className="mt-auto text-xs opacity-50">local prototype</div>
      </nav>
      <main className="flex-1 p-10">
        <h1 className="font-serif text-3xl mb-2">Passage risk audit</h1>
        <p className="text-ink-soft mb-8 max-w-xl">
          Decision aid — it never says GO. Official marine forecasts remain the authority of record.
        </p>
        <section className="border border-chart-line rounded p-4 bg-white/50 max-w-xl">
          <h2 className="font-semibold mb-2 text-sm uppercase tracking-wider text-ink-soft">
            Snapshots
          </h2>
          {error && <p className="text-verdict-exceeds text-sm">manifest error: {error}</p>}
          {manifest && manifest.snapshots.length === 0 && (
            <p className="text-sm text-ink-soft">No analyses yet.</p>
          )}
          {manifest &&
            manifest.snapshots.map((s) => (
              <div key={s.snapshot_id} className="text-sm py-1 border-b border-chart-line last:border-0">
                <span className="font-mono">{s.snapshot_id}</span>
                <span className="ml-2 text-ink-soft">{s.route_id}</span>
                {s.verdict_state && <span className="ml-2">{s.verdict_state}</span>}
              </div>
            ))}
        </section>
      </main>
    </div>
  );
}
