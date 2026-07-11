import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { Panel, EmulatedStamp } from '../components/common.jsx';

const GLOSSARY = [
  ['gust', 'A brief burst of wind above the sustained speed — typically 20–40% higher; squalls can double it.'],
  ['ensemble', 'The same model run ~50 times with slightly different starting conditions. The spread between members shows how uncertain the forecast is.'],
  ['ETA window', 'Your arrival time is a range, not an instant: computed for your slow, nominal and fast boat speeds. Conditions are checked across the whole window.'],
  ['model run', 'Weather models restart from fresh observations every 6–12 h. A new run can shift the forecast — always recheck before departure.'],
  ['veer', 'Wind direction turning clockwise (e.g. SW → NW). Common behind a cold front in the northern hemisphere.'],
  ['significant wave height', 'The average of the highest third of waves. Individual waves can be nearly twice this height.'],
  ['steepness', 'Wave height relative to wavelength (H/L). Steep waves break; short-period seas are dangerous well below your height limit.'],
  ['scenario exceedance', 'The count of ensemble members exceeding your declared limit — "33 of 51". A raw fraction, not a calibrated probability.'],
];

export default function Settings() {
  const providers = useApp((s) => s.providers);
  const profileDefaults = useApp((s) => s.profileDefaults);
  const loadConfig = useApp((s) => s.loadConfig);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (profileDefaults && !draft) {
      const stored = localStorage.getItem('deepweather.profile-draft');
      setDraft(stored ? JSON.parse(stored) : structuredClone(profileDefaults));
    }
  }, [profileDefaults, draft]);

  const update = (path, value) => {
    const next = structuredClone(draft);
    let obj = next;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = value;
    setDraft(next);
    localStorage.setItem('deepweather.profile-draft', JSON.stringify(next));
  };

  return (
    <div className="px-6 py-5 max-w-4xl space-y-4">
      <h1 className="font-chart text-3xl">Settings</h1>

      <Panel title="Your declared limits">
        <p className="font-sans text-sm text-ink-soft mb-4">
          These are operational limits you declare — not sailor categories. Presets only pre-fill;
          everything is editable. No preset relaxes squall or storm tolerance.{' '}
          <span className="text-ink">
            CLI analyses read config/profiles/default-limits.json; this draft feeds in-browser
            analysis when it lands.
          </span>
        </p>
        {draft ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field
              label="Max sustained · upwind"
              unit="kt"
              value={draft.max_sustained_kt.upwind ?? draft.max_sustained_kt.default}
              onChange={(v) => update(['max_sustained_kt', 'upwind'], v)}
            />
            <Field
              label="Max sustained · reach"
              unit="kt"
              value={draft.max_sustained_kt.reach ?? draft.max_sustained_kt.default}
              onChange={(v) => update(['max_sustained_kt', 'reach'], v)}
            />
            <Field
              label="Max sustained · downwind"
              unit="kt"
              value={draft.max_sustained_kt.downwind ?? draft.max_sustained_kt.default}
              onChange={(v) => update(['max_sustained_kt', 'downwind'], v)}
            />
            <Field label="Max gusts" unit="kt" value={draft.max_gust_kt} onChange={(v) => update(['max_gust_kt'], v)} />
            <Field label="Max wave height" unit="m" step={0.1} value={draft.max_wave_height_m} onChange={(v) => update(['max_wave_height_m'], v)} />
            <Field label="Max steepness" unit="H/L" step={0.005} value={draft.max_steepness} onChange={(v) => update(['max_steepness'], v)} />
            <Field label="Min visibility" unit="nm" value={draft.min_visibility_nm ?? 0} onChange={(v) => update(['min_visibility_nm'], v)} />
            <Field
              label="Scenario fraction floor"
              unit="0–1"
              step={0.05}
              value={draft.scenario_fraction_floor}
              onChange={(v) => update(['scenario_fraction_floor'], v)}
            />
            <label className="font-sans text-sm flex items-center gap-2 self-end pb-2">
              <input
                type="checkbox"
                checked={draft.night_ok}
                onChange={(e) => update(['night_ok'], e.target.checked)}
              />
              night sailing acceptable
            </label>
          </div>
        ) : (
          <p className="font-sans text-sm text-ink-soft">Loading profile…</p>
        )}
      </Panel>

      <Panel title="Data providers">
        <p className="font-sans text-sm text-ink-soft mb-3">
          Feeds marked <EmulatedStamp /> produce synthetic values for testing — they are badged
          everywhere they appear and must never inform a real passage decision.
        </p>
        <ul className="grid md:grid-cols-2 gap-x-8">
          {providers &&
            Object.entries(providers.providers).map(([name, p]) => (
              <li key={name} className="flex items-center justify-between py-1.5 border-b hairline">
                <span className="font-mono text-[13px]">{name}</span>
                {p.mode === 'synthetic' ? (
                  <EmulatedStamp />
                ) : (
                  <span className="font-sans text-[12px] text-verdict-within">{p.mode}</span>
                )}
              </li>
            ))}
        </ul>
      </Panel>

      <Panel title="Glossary">
        <dl className="grid md:grid-cols-2 gap-x-8 gap-y-3">
          {GLOSSARY.map(([term, def]) => (
            <div key={term}>
              <dt className="font-sans font-medium text-sm">{term}</dt>
              <dd className="font-sans text-[13px] text-ink-soft leading-relaxed">{def}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
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
