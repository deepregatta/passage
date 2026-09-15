import { VerdictChip } from '../../components/common.jsx';
import { fmtLocalTime, localTimeZoneName } from '../../lib/format.js';
import { routeTitle } from './routeLabels.jsx';

/** compact dark chart-table header: route + departure left, personal-limit state right */
export default function HeaderBar({ findings }) {
  const warningActive = findings.verdict.warning_override?.active;
  const personalState = warningActive ? recomputePersonalState(findings) : findings.verdict.state;
  return (
    <div className="bg-ink-deep text-paper px-6 py-3 flex items-center justify-between flex-wrap gap-x-6 gap-y-2">
      <div className="flex items-baseline gap-4 flex-wrap">
        <span className="font-chart text-2xl tracking-wide">{routeTitle(findings)}</span>
        <span className="font-mono text-[12px] opacity-70">
          <span>dep</span> {fmtLocalTime(findings.departure_utc)} <span>local time</span> · {localTimeZoneName()}
        </span>
      </div>
      <VerdictChip state={personalState} />
    </div>
  );
}

function recomputePersonalState(findings) {
  let approaching = false;
  for (const leg of findings.legs) {
    for (const hour of leg.hours) {
      const statuses = Object.values(hour.limit_status ?? {});
      if (statuses.includes('exceeded')) return 'exceeds';
      if (statuses.includes('approaching')) approaching = true;
    }
  }
  return approaching ? 'approaching' : 'within';
}
