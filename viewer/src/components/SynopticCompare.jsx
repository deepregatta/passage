import { chartUrl } from '../lib/synopticCharts.js';

function systemSummary(synoptic) {
  const low = synoptic?.systems?.find((item) => item.kind === 'low');
  if (!low?.track?.length) return null;
  const deepest = [...low.track].sort((a, b) => a.center_hpa - b.center_hpa)[0];
  return { name: `Low ${low.system_id}`, pressure: Math.round(deepest.center_hpa), time: deepest.valid_time, track: low.track };
}

export default function SynopticCompare({ previous, latest, previousId, latestId }) {
  const a = systemSummary(previous), b = systemSummary(latest);
  if (!a || !b) return <div className="border border-dashed hairline p-6 font-instrument text-sm text-ink-soft">Before/after synoptic comparison unavailable for this legacy pair.</div>;
  return <div className="grid md:grid-cols-2 gap-px bg-ink/30 border border-ink/30">
    <SystemCard label="Previous" summary={a} snapshotId={previousId} synoptic={previous} />
    <SystemCard label="Latest" summary={b} snapshotId={latestId} synoptic={latest} delta={b.pressure - a.pressure} />
  </div>;
}

function SystemCard({ label, summary, snapshotId, synoptic, delta }) {
  const chart = synoptic.chart_captions?.[1] ?? synoptic.chart_captions?.[0];
  return <figure className="bg-paper p-3"><figcaption className="flex justify-between items-baseline mb-2"><span className="eyebrow">{label} run</span><span className="font-mono text-xs">{summary.name} · {summary.pressure} hPa{delta ? ` · ${delta > 0 ? '+' : ''}${delta} hPa` : ''}</span></figcaption>{chart?.file ? <img src={chartUrl(chart.file, snapshotId)} alt={`${label} synoptic chart`} className="w-full aspect-[4/2.4] object-cover border hairline" /> : <div className="aspect-[4/2.4] border border-dashed hairline grid place-items-center">chart image no longer archived</div>}<p className="font-instrument text-xs text-ink-soft mt-2">{chart?.caption ?? `${summary.track.length} tracked positions`}</p></figure>;
}
