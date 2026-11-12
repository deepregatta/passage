import clsx from 'clsx';
import { useMemo } from 'react';
import { rankCandidates } from '@deepweather/engine';
import { RANK_CAUTIOUS, RANK_TYPICAL, usePlanner } from '../../stores/plannerStore.js';
import { fmtLocalTime, localDateTimeToIso, localTimeZoneName, VERDICT } from '../../lib/format.js';

/** compact verdict labels for the scan rows; the full wording lives in the briefing */
const SCAN_VERDICT = {
  within: 'within limits',
  approaching: 'approaching',
  exceeds: 'exceeds',
  insufficient: 'models disagree',
  warning_active: 'official warning',
};

/** A candidate has ensemble evidence when the scan says so, or it carries a scenario fraction (an older scan). */
const hasEnsemble = (c) => c.ensemble_covered === true || c.max_fraction != null;

const RANK_MODES = [[RANK_TYPICAL, 'Typical'], [RANK_CAUTIOUS, 'Cautious']];

const isCount = (value) => Number.isFinite(value);

/**
 * The tooltip's hour figures, each its own part so the French catalogue matches it
 * with one pattern. The ranked figures are distinct hours of the whole arrival
 * range, where the verdict looks (passageLimitHours); the expected-timing count
 * follows as a secondary part only when it differs, so a smaller number never
 * stands alone. Zeros are left out: an approaching cell can come from a reason
 * that is not a limit, so "0 h" would contradict it.
 */
function limitHourParts(c) {
  if (!isCount(c.arrival_hours_over_limit) || !isCount(c.arrival_hours_approaching)) return [];
  const parts = [];
  if (c.arrival_hours_over_limit > 0) {
    parts.push(`${c.arrival_hours_over_limit} h over a limit in your arrival range`);
    const expected = c.expected_hours_over_limit;
    if (isCount(expected) && expected !== c.arrival_hours_over_limit) {
      parts.push(expected > 0 ? `of which ${expected} h on the expected timing` : 'none on the expected timing');
    }
  }
  if (c.arrival_hours_approaching > 0) parts.push(`${c.arrival_hours_approaching} h approaching a limit in your arrival range`);
  if (isCount(c.arrival_hours_no_data) && c.arrival_hours_no_data > 0) {
    parts.push(`a forecast value needed for your limits is missing for ${c.arrival_hours_no_data} h of your arrival range`);
  }
  return parts;
}

/**
 * Typical / Cautious: a view of the scan already held, never a new scan. Cautious is
 * disabled, with the reason in view, when no time has forecast-scenario evidence.
 */
function RankToggle({ mode, cautiousAvailable, onChange }) {
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="eyebrow text-xs!" id="rank-mode-label">Rank by</span>
        <div role="group" aria-labelledby="rank-mode-label" className="inline-flex border border-ink/40 rounded-sm font-instrument text-xs">
          {RANK_MODES.map(([id, label]) => {
            const unavailable = id === RANK_CAUTIOUS && !cautiousAvailable;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={mode === id}
                disabled={unavailable}
                aria-describedby={unavailable ? 'rank-mode-reason' : undefined}
                onClick={() => onChange(id)}
                className={clsx('min-h-11 min-w-11 px-4', mode === id ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink', unavailable && 'cursor-not-allowed opacity-50')}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="font-sans text-[12px] text-ink-soft mt-1 max-w-[80ch]">
        Typical: ranked on the main forecast against your limits, including how many hours of your arrival range are over or approaching a limit. Cautious: ranked first on how many forecast scenarios exceed your limits, then on those hours.
      </p>
      {!cautiousAvailable && (
        <p id="rank-mode-reason" className="font-sans text-[12px] text-ink-soft mt-1 max-w-[80ch]">
          Cautious is unavailable: no forecast scenarios cover these departure times.
        </p>
      )}
    </div>
  );
}

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
export default function DepartureComparison({ scan, departureLocal, busy, disabled, onPick, headingRef, children }) {
  const storedMode = usePlanner((state) => state.rankMode);
  const patch = usePlanner((state) => state.patch);
  const cautiousAvailable = scan.candidates.some(hasEnsemble);
  // The stored choice is a preference and is never rewritten: without ensemble evidence the
  // view falls back to typical, and the preference applies again for a scan that has it.
  const mode = storedMode === RANK_CAUTIOUS && cautiousAvailable ? RANK_CAUTIOUS : RANK_TYPICAL;
  const ranking = useMemo(() => rankCandidates(scan.candidates, { mode }), [scan.candidates, mode]);
  if (scan.candidates.length === 0) {
    return (
      <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Departure comparison">
        <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-16 font-instrument font-semibold uppercase tracking-wider">Departure comparison</h2>
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
  const bestIndex = ranking.best_index;
  const tiedIndices = new Set(ranking.tied_indices);
  const best = bestIndex !== null ? scan.candidates[bestIndex] : null;
  const allInsufficient = scan.candidates.every((c) => c.verdict === 'insufficient');
  const selectedDepartureMs = Date.parse(localDateTimeToIso(departureLocal));

  return (
    <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Departure comparison">
      <div className="flex justify-between items-baseline flex-wrap gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-16 font-instrument font-semibold uppercase tracking-wider">
          Departure comparison · next 5 days
        </h2>
        <span className="eyebrow text-xs!">
          <span>24-hour local time</span> · {localTimeZoneName()} ·{' '}
          <span>{scan.rerouted ? 'each departure sails its own computed route' : 'same route, different weather'}</span>
        </span>
      </div>

      <RankToggle mode={mode} cautiousAvailable={cautiousAvailable} onChange={(next) => patch({ rankMode: next })} />

      <div className="flex flex-wrap gap-x-5 gap-y-3 mt-3">
        {days.map((d) => (
          <div key={d.day}>
            <p className="font-instrument text-[12px] uppercase tracking-wider text-ink-soft mb-1">{d.day}</p>
            <div className="flex gap-1.5">
              {d.cells.map((c) => {
                const v = VERDICT[c.verdict] ?? VERDICT.insufficient;
                const parts = [SCAN_VERDICT[c.verdict] ?? c.verdict];
                if (c.passage_h) parts.push(`≈${Math.round(c.passage_h)} h passage`);
                parts.push(...limitHourParts(c));
                if (c.max_members) parts.push(`${c.max_members.exceed} of ${c.max_members.total} forecast scenarios exceed a limit`);
                if (tiedIndices.has(c.index)) parts.push('effectively tied with the least-exposure time');
                // The hours are given above; the delta's hour difference counted gusts only, twice where legs overlap.
                if (c.delta && c.index > 0) parts.push(`gusts ${c.delta.peak_gust_kt > 0 ? '+' : ''}${Math.round(c.delta.peak_gust_kt)} kt vs first option`);
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
                    <span className="text-[12px]" aria-hidden>
                      {c.index === bestIndex ? '◎' : v.glyph}
                      {tiedIndices.has(c.index) && ' ≈'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {children && <div className="mt-3 space-y-2">{children}</div>}
      <SkippedDepartures scan={scan} />
      <div className="flex flex-wrap items-baseline justify-between gap-2 mt-3">
        <p className="font-sans text-[13px] max-w-[80ch]">
          {best && (
            <>
              <span className="font-medium">◎ Least exposure this window: {fmtLocalTime(best.departure_utc)} local time</span>
              {'. '}
              {tiedIndices.size > 0 && (
                <>
                  <span className="font-medium">≈ Effectively tied:</span>{' '}
                  {[...tiedIndices].map((i) => fmtLocalTime(scan.candidates[i].departure_utc)).join(' · ')}
                  {' local time'}{'. '}
                </>
              )}
            </>
          )}
          Click a time to check that departure against your limits{scan.rerouted ? ' (it sails its own computed route)' : ''} — the full briefing opens straight away.
          {allInsufficient && (
            <> The models disagree near your limits throughout this window. Open a briefing to see
            where they diverge and when the next update is due.</>
          )}
        </p>
        <span className="flex gap-4 font-sans text-[12px] text-ink-soft">
          {['within', 'approaching', 'exceeds', 'insufficient'].map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ backgroundColor: VERDICT[s].hex }} />
              {SCAN_VERDICT[s]}
            </span>
          ))}
          {tiedIndices.size > 0 && (
            <span className="flex items-center gap-1.5">
              <span aria-hidden>≈</span>
              effectively tied with the least exposure
            </span>
          )}
        </span>
      </div>
    </section>
  );
}
