import { useMemo } from 'react';
import { currentSummary } from '@deepweather/engine';
import { EmulatedStamp } from '../../components/common.jsx';
import {
  CURRENT_CAVEATS, CURRENT_DISCLAIMER, currentSource, currentSummaryEmulated, currentSummaryLines,
  windAgainstCurrentEmulated, windAgainstCurrentHazard,
} from '../../lib/currentSummaryLines.js';

/** What the current did over the passage: distance gained or lost on the expected timing, the
 * strongest current anywhere in the arrival range, and wind against current. Text and numbers only,
 * from the saved findings and the route saved with them (so a reopened saved passage shows it with no
 * new fetch and never reads the latest data). Renders nothing when the check has no current value.
 * Names the current model the check recorded by its family ("Model not recorded" when nothing
 * identifies one), with that source's caveat and the not-a-tidal-stream-prediction disclaimer.
 * The heading's EMULATED stamp follows the current record; the wind-against-current line, which
 * depends on wind and current, is stamped when either is emulated. No hours with and against the
 * current: no saved record shows whether the source resolves the tide. */
export default function CurrentSummary({ findings, route = null }) {
  const summary = useMemo(() => currentSummary(findings, route), [findings, route]);
  const legNumber = (legId) => {
    const index = findings?.legs?.findIndex((leg) => leg.leg_id === legId) ?? -1;
    return index >= 0 ? index + 1 : String(legId);
  };
  const lines = currentSummaryLines(summary, { legNumber, hazard: windAgainstCurrentHazard(findings) });
  if (!lines.length) return null;
  const { name, caveat } = currentSource(findings);
  const emulated = currentSummaryEmulated(findings);
  const wacEmulated = windAgainstCurrentEmulated(findings);
  return (
    <div className="mt-4 px-4 font-instrument text-sm space-y-1" data-testid="current-summary">
      <h3 className="eyebrow flex items-center gap-2">
        Current along your route
        {emulated && <EmulatedStamp />}
      </h3>
      <p className="text-ink-soft" data-line>The model current at the points checked along your passage, on the expected timing.</p>
      <p data-testid="current-model"><span>Currents</span> · <span>{name ?? 'Model not recorded'}</span></p>
      {lines.map(({ key, text }) => (key === 'wac'
        ? <p key={key} data-testid="current-wac"><span data-line>{text}</span>{wacEmulated && <> <EmulatedStamp /></>}</p>
        : <p key={key} data-line>{text}</p>))}
      <p className="text-ink-soft" data-line>{CURRENT_CAVEATS[caveat]}</p>
      <p className="text-ink-soft" data-line>{CURRENT_DISCLAIMER}</p>
    </div>
  );
}
