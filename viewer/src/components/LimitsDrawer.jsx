import { useEffect, useRef } from 'react';
import { useApp } from '../stores/appStore.js';

/** The sailor's declared limits, editable from any page. Saved as they change;
 * the next check uses them, briefings already made keep the limits they used. */
export default function LimitsDrawer() {
  const limits = useApp((s) => s.limits);
  const limitsPersisted = useApp((s) => s.limitsPersisted);
  const updateLimit = useApp((s) => s.updateLimit);
  const ensureLimits = useApp((s) => s.ensureLimits);
  const close = useApp((s) => s.closeLimits);
  const dialogRef = useRef(null);

  useEffect(() => { void ensureLimits(); }, [ensureLimits]);
  useEffect(() => {
    const returnFocus = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll('button, input') ?? [])];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); returnFocus?.focus?.(); };
  }, [close]);

  const sustained = (key) => limits.max_sustained_kt[key] ?? limits.max_sustained_kt.default;
  return (
    <>
      <div className="fixed inset-0 bg-ink-deep/30 z-40" onClick={close} aria-hidden />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="limits-title"
        className="fixed right-0 top-0 h-full w-[26rem] max-w-full bg-paper z-50 border-l border-ink/40 overflow-y-auto pb-20 md:pb-0"
      >
        <div className="titleblock m-3 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 id="limits-title" className="font-chart text-2xl">My limits</h2>
            <button type="button" onClick={close} className="min-h-11 min-w-11 text-ink-soft hover:text-ink font-sans text-sm" aria-label="Close limits">✕</button>
          </div>
          <p className="font-sans text-sm text-ink-soft mb-4">
            Set the conditions you will accept for this passage. Presets are only a starting point.
            Every value remains editable. Squall and storm tolerance never changes with a preset.
          </p>
          {limits ? (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Max sustained · upwind" unit="kt" value={sustained('upwind')} onChange={(v) => updateLimit(['max_sustained_kt', 'upwind'], v)} />
              <Field label="Max sustained · reach" unit="kt" value={sustained('reach')} onChange={(v) => updateLimit(['max_sustained_kt', 'reach'], v)} />
              <Field label="Max sustained · downwind" unit="kt" value={sustained('downwind')} onChange={(v) => updateLimit(['max_sustained_kt', 'downwind'], v)} />
              <Field label="Max gusts" unit="kt" value={limits.max_gust_kt} onChange={(v) => updateLimit(['max_gust_kt'], v)} />
              <Field label="Max wave height" unit="m" step={0.1} value={limits.max_wave_height_m} onChange={(v) => updateLimit(['max_wave_height_m'], v)} />
              <Field label="Max steepness" unit="H/L" step={0.005} value={limits.max_steepness} onChange={(v) => updateLimit(['max_steepness'], v)} />
              <Field label="Min visibility" unit="nm" value={limits.min_visibility_nm ?? 0} onChange={(v) => updateLimit(['min_visibility_nm'], v)} />
              <Field label="Scenario fraction floor" unit="0–1" step={0.05} value={limits.scenario_fraction_floor} onChange={(v) => updateLimit(['scenario_fraction_floor'], v)} />
              <label className="col-span-2 font-sans text-sm flex items-center gap-2 min-h-11">
                <input type="checkbox" checked={limits.night_ok} onChange={(e) => updateLimit(['night_ok'], e.target.checked)} />
                night sailing acceptable
              </label>
            </div>
          ) : (
            <p className="font-sans text-sm text-ink-soft">Loading profile…</p>
          )}
          <p className="mt-4 border border-ink/25 bg-shoal/40 px-3 py-2 font-sans text-[13px]">
            Changes apply to your next check. Briefings you already made keep the limits they were checked against.
          </p>
          {!limitsPersisted && <p role="status" className="mt-3 font-sans text-sm text-ink-soft">
            These limits apply to your next check, but could not be saved for a future visit.
          </p>}
          <button type="button" onClick={close} className="mt-4 w-full min-h-11 bg-ink text-paper font-medium rounded-sm px-3 py-2 hover:bg-ink-deep">
            Done
          </button>
        </div>
      </aside>
    </>
  );
}

function Field({ label, unit, value, onChange, step = 1 }) {
  return (
    <label className="font-sans text-sm block">
      <span className="eyebrow block mb-1">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          value={value ?? ''}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 bg-white/60 border hairline rounded-sm px-2 py-1 font-mono text-[14px]"
        />
        <span className="text-ink-soft text-[12px]">{unit}</span>
      </span>
    </label>
  );
}
