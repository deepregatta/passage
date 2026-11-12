import { useMemo } from 'react';
import { routeSummary } from '@deepweather/engine';
import { EmulatedStamp } from '../../components/common.jsx';
import { routeSummaryEmulated, routeSummaryLines } from '../../lib/routeSummaryLines.js';

/** Hours of the passage by point of sail and by wind strength, at the forecast wind and the expected
 * timing. Text and numbers only, from the saved findings alone (so a reopened saved passage shows
 * it with no new fetch and never reads the latest data). Renders nothing when the findings have no
 * usable hours. The wind is the deterministic sustained wind the check compares to your wind limit.
 * Emulated forecasts carry the same EMULATED stamp as the rest of the page. */
export default function RouteSummary({ findings }) {
  const summary = useMemo(() => routeSummary(findings), [findings]);
  const lines = routeSummaryLines(summary);
  if (!lines.length) return null;
  const emulated = routeSummaryEmulated(findings);
  return (
    <div className="mt-4 px-4 font-instrument text-sm space-y-1" data-testid="route-summary">
      <h3 className="eyebrow flex items-center gap-2">
        Hours by point of sail and wind
        {emulated && <EmulatedStamp />}
      </h3>
      <p className="text-ink-soft">Hours of your passage at the forecast wind, on the expected timing.</p>
      {lines.map(({ key, text }) => <p key={key}>{text}</p>)}
    </div>
  );
}
