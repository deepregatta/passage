import { useApp } from '../stores/appStore.js';
import { VERDICT, fmtTime } from '../lib/format.js';
import { EvidenceLink } from './common.jsx';

/**
 * §7 verdict strip. When an official warning is active it renders as a separate
 * authority band ABOVE the personal-limit verdict; it overrides, it never blends.
 */
export default function VerdictBanner() {
  const findings = useApp((s) => s.findings);
  if (!findings) return null;

  const { verdict } = findings;
  const warningActive = verdict.warning_override?.active;
  const personalState = warningActive
    ? recomputePersonalState(findings)
    : verdict.state;
  const v = VERDICT[personalState] ?? VERDICT.insufficient;
  const driver = findings.evidence.find((e) => e.evidence_id === verdict.driver_evidence_id);

  return (
    <div>
      {warningActive && (
        <div
          className="text-white px-6 py-2.5 font-sans text-sm flex items-center gap-3"
          style={{ backgroundColor: VERDICT.warning_active.hex }}
        >
          <span aria-hidden>🚩</span>
          <span className="font-semibold uppercase tracking-wider text-[12px]">
            Official warning active
          </span>
          <span className="opacity-90">Official advice takes priority over your personal limits.</span>
        </div>
      )}
      <div
        className="text-white px-6 py-3 font-sans flex items-center gap-3 flex-wrap"
        style={{ backgroundColor: v.hex, opacity: warningActive ? 0.75 : 1 }}
      >
        <span aria-hidden className="text-lg leading-none">
          {v.glyph}
        </span>
        <span className="font-semibold tracking-wide">{v.label}</span>
        {driver && (
          <span className="text-white/85 text-sm">
            driven by{' '}
            <EvidenceLink evidenceId={driver.evidence_id}>
              <span className="text-white underline decoration-dotted">
                {driver.rule_id} · {driver.leg_id} · {fmtTime(driver.valid_time)} UTC
              </span>
            </EvidenceLink>
          </span>
        )}
      </div>
    </div>
  );
}

/** without the override, what would the personal-limit summary say? */
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
