import clsx from 'clsx';
import { fmtLocalTime, localDateTimeToIso, localTimeZoneName, VERDICT } from '../../lib/format.js';

/** compact verdict labels for the scan rows; the full wording lives in the briefing */
const SCAN_VERDICT = {
  within: 'within limits',
  approaching: 'approaching',
  exceeds: 'exceeds',
  insufficient: 'models disagree',
  warning_active: 'official warning',
};

function SkippedDepartures({ scan }) {
  const skipped = scan.skipped ?? [];
  const missing = scan.requested != null ? scan.requested - scan.candidates.length : skipped.length;
  if (missing <= 0) return null;
  return (
    <div className="font-sans text-[12px] text-ink-soft mt-2">
      {scan.requested != null && (
        <p>{`${missing} of ${scan.requested} departure times could not be assessed and are not shown.`}</p>
      )}
      <p>A missing cell does not mean safe conditions.</p>
      {skipped.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer">Unassessed departures</summary>
          <ul className="mt-1 space-y-1">
            {skipped.map((item, index) => (
              <li className="break-words" key={`${item.departure_utc}-${index}`}>
                <time dateTime={item.departure_utc}>{fmtLocalTime(item.departure_utc)}</time>
                {' · '}<span>{item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Full-width departure calendar: days across, one colored cell per candidate
 * (same verdict colors as everywhere else). Click a cell to adopt that
 * departure; in compute mode the cell also carries its own weather-routed track.
 */
export default function DepartureComparison({ scan, departureLocal, busy, disabled, onPick }) {
  if (scan.candidates.length === 0) {
    return (
      <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Departure comparison">
        <h2 className="font-instrument font-semibold uppercase tracking-wider">Departure comparison</h2>
        <p className="font-sans text-sm text-ink-soft mt-2 max-w-[70ch]">
          None of the candidate departures could be assessed.
        </p>
        <SkippedDepartures scan={scan} />
      </section>
    );
  }

  const days = [];
  for (const [i, c] of scan.candidates.entries()) {
    const stamp = fmtLocalTime(c.departure_utc); // "Mon 13 Jul 08:00" in browser-local time
    const day = stamp.slice(0, -6);
    if (days.at(-1)?.day !== day) days.push({ day, cells: [] });
    days.at(-1).cells.push({ ...c, index: i, hhmm: stamp.slice(-5) });
  }
  const best = scan.best_index !== null ? scan.candidates[scan.best_index] : null;
  const baseline = scan.candidates[0];
  const allInsufficient = scan.candidates.every((c) => c.verdict === 'insufficient');
  const selectedDepartureMs = Date.parse(localDateTimeToIso(departureLocal));

  return (
    <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Departure comparison">
      <div className="flex justify-between items-baseline flex-wrap gap-2">
        <h2 className="font-instrument font-semibold uppercase tracking-wider">
          Departure comparison · next 5 days
        </h2>
        <span className="eyebrow">
          <span>24-hour local time</span> · {localTimeZoneName()} ·{' '}
          <span>{scan.rerouted ? 'each departure sails its own computed route' : 'same route, different weather'}</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-3 mt-3">
        {days.map((d) => (
          <div key={d.day}>
            <p className="font-instrument text-[11px] uppercase tracking-wider text-ink-soft mb-1">{d.day}</p>
            <div className="flex gap-1.5">
              {d.cells.map((c) => {
                const v = VERDICT[c.verdict] ?? VERDICT.insufficient;
                const parts = [SCAN_VERDICT[c.verdict] ?? c.verdict];
                if (c.passage_h) parts.push(`≈${Math.round(c.passage_h)} h passage`);
                if (c.delta && c.index > 0) {
                  parts.push(`gusts ${c.delta.peak_gust_kt > 0 ? '+' : ''}${Math.round(c.delta.peak_gust_kt)} kt vs first option`);
                  parts.push(`${c.delta.hours_over_limit > 0 ? '+' : ''}${c.delta.hours_over_limit} h over your limit`);
                }
                return (
                  <button
                    key={c.departure_utc}
                    type="button"
                    onClick={() => onPick(c)}
                    disabled={disabled || busy !== null}
                    aria-pressed={selectedDepartureMs === Date.parse(c.departure_utc)}
                    title={`${fmtLocalTime(c.departure_utc)} local time (${localTimeZoneName()}) · ${parts.join(' · ')}`}
                    className={clsx(
                      'w-[66px] h-[54px] rounded-sm text-white flex flex-col items-center justify-center gap-0.5 disabled:opacity-40',
                      selectedDepartureMs === Date.parse(c.departure_utc) && 'outline outline-2 outline-ink outline-offset-1',
                    )}
                    style={{ backgroundColor: v.hex }}
                  >
                    <span className="font-mono text-[12px] font-semibold">{c.hhmm}</span>
                    <span className="text-[11px]" aria-hidden>{c.index === scan.best_index ? '◎' : v.glyph}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <SkippedDepartures scan={scan} />
      <div className="flex flex-wrap items-baseline justify-between gap-2 mt-3">
        <p className="font-sans text-[13px] max-w-[80ch]">
          {best && (
            <>
              <span className="font-medium">◎ Least exposure this window: {fmtLocalTime(best.departure_utc)} local time</span>
              {'. '}
            </>
          )}
          Click a time to check that departure against your limits{scan.rerouted ? ' (it sails its own computed route)' : ''} — the full briefing opens straight away.
          {allInsufficient && (
            <> The models disagree near your limits throughout this window. Open a briefing to see
            where they diverge and when the next update is due.</>
          )}
        </p>
        <span className="flex gap-4 font-sans text-[11px] text-ink-soft">
          {['within', 'approaching', 'exceeds', 'insufficient'].map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ backgroundColor: VERDICT[s].hex }} />
              {SCAN_VERDICT[s]}
            </span>
          ))}
        </span>
      </div>
    </section>
  );
}
