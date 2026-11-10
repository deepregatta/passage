import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../stores/appStore.js';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const SUSTAINED_KEYS = ['upwind', 'reach', 'downwind'];

// Messages are static so the French catalogue can translate each one.
const MSG_NUMBER = 'Enter a number.';
const MSG_POSITIVE = 'Enter a number above 0.';
const MSG_FRACTION = 'Enter a number above 0, up to 1.';
const MSG_VISIBILITY = 'Enter 0 or more.';
const MSG_GUST_BELOW = 'Gusts cannot be below your highest sustained wind limit.';
const MSG_SUSTAINED_ABOVE = 'Sustained wind cannot be above your gust limit.';
const MSG_KEPT = 'Not saved. Your previous value is kept.';

const positive = (n) => (n > 0 ? null : MSG_POSITIVE);

/** The sailor's declared limits, editable from any page. Saved as they change;
 * the next check uses them, briefings already made keep the limits they used.
 * Only valid values reach the store: a value that fails its check stays in the
 * field, with a message, until the field loses focus and the last valid value returns. */
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
    // The page behind the drawer must not scroll while it is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => !el.disabled);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus?.();
    };
  }, [close]);

  const sustained = (key) => limits.max_sustained_kt[key] ?? limits.max_sustained_kt.default;
  const highestSustained = () => Math.max(...SUSTAINED_KEYS.map(sustained));
  const sustainedCheck = (n) => {
    if (!(n > 0)) return MSG_POSITIVE;
    return n > limits.max_gust_kt ? MSG_SUSTAINED_ABOVE : null;
  };
  const gustCheck = (n) => {
    if (!(n > 0)) return MSG_POSITIVE;
    return n < highestSustained() ? MSG_GUST_BELOW : null;
  };
  return (
    <>
      <div className="fixed inset-0 bg-ink-deep/30 z-40" onClick={close} aria-hidden />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="limits-title"
        className="fixed right-0 top-0 h-full w-[26rem] max-w-full bg-paper z-50 border-l border-ink/40 overflow-y-auto overscroll-contain pb-20 md:pb-0"
      >
        <div className="titleblock m-3 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 id="limits-title" className="font-chart text-2xl">My limits</h2>
            <button type="button" onClick={close} className="min-h-11 min-w-11 text-ink-soft hover:text-ink font-sans text-sm" aria-label="Close limits">✕</button>
          </div>
          <p className="font-sans text-sm text-ink-soft mb-4">
            Set the conditions you will accept. These limits apply to every check you make from now on, not only to the passage you are planning. Every value remains editable.
          </p>
          {limits ? (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Max sustained · upwind" unit="kt" value={sustained('upwind')} validate={sustainedCheck} onCommit={(v) => updateLimit(['max_sustained_kt', 'upwind'], v)} />
              <Field label="Max sustained · reach" unit="kt" value={sustained('reach')} validate={sustainedCheck} onCommit={(v) => updateLimit(['max_sustained_kt', 'reach'], v)} />
              <Field label="Max sustained · downwind" unit="kt" value={sustained('downwind')} validate={sustainedCheck} onCommit={(v) => updateLimit(['max_sustained_kt', 'downwind'], v)} />
              <Field label="Max gusts" unit="kt" value={limits.max_gust_kt} validate={gustCheck} onCommit={(v) => updateLimit(['max_gust_kt'], v)} />
              <Field label="Max wave height" unit="m" step={0.1} value={limits.max_wave_height_m} validate={positive} onCommit={(v) => updateLimit(['max_wave_height_m'], v)} />
              <Field
                label="Max steepness" unit="H/L" step={0.005} value={limits.max_steepness} validate={positive}
                help="Wave height divided by wavelength. A short, steep sea is rougher than its height alone suggests."
                onCommit={(v) => updateLimit(['max_steepness'], v)}
              />
              <Field label="Min visibility" unit="nm" value={limits.min_visibility_nm ?? 0} validate={(n) => (n >= 0 ? null : MSG_VISIBILITY)} onCommit={(v) => updateLimit(['min_visibility_nm'], v)} />
              <Field
                label="Scenario fraction floor" unit="0–1" step={0.05} value={limits.scenario_fraction_floor}
                validate={(n) => (n > 0 && n <= 1 ? null : MSG_FRACTION)}
                help="If at least this share of forecast scenarios goes over a wind or gust limit, the check reads as close to your limits. For example, 0.3 means 3 in 10 scenarios."
                onCommit={(v) => updateLimit(['scenario_fraction_floor'], v)}
              />
            </div>
          ) : (
            <p className="font-sans text-sm text-ink-soft">Loading profile…</p>
          )}
          <p className="mt-4 font-sans text-sm text-ink-soft">
            Night-sailing preference is not evaluated. It does not affect the verdict, departure scan or route timing.
          </p>
          <p className="mt-4 border border-ink/25 bg-shoal/40 px-3 py-2 font-sans text-sm">
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

/** One numeric limit. `value` is the last valid number held by the store; the typed
 * text lives here so an invalid entry is never saved yet can still be corrected. */
function Field({ label, unit, value, onCommit, validate, step = 1, help }) {
  const id = useId();
  const helpId = `${id}-help`;
  const messageId = `${id}-message`;
  const [text, setText] = useState(String(value ?? ''));
  const [message, setMessage] = useState({ text: '', invalid: false });

  // Follow the store when it changes for any reason other than this field's own typing.
  useEffect(() => {
    setText((current) => (current.trim() !== '' && Number(current) === value ? current : String(value ?? '')));
    setMessage((current) => (current.invalid ? { text: '', invalid: false } : current));
  }, [value]);

  const check = (raw) => {
    const number = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(number)) return MSG_NUMBER;
    return validate(number);
  };
  const describedBy = [help ? helpId : null, message.text ? messageId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="font-sans text-sm">
      <label htmlFor={id} className="block mb-1 font-instrument text-xs uppercase tracking-[0.18em] text-ink-soft">{label}</label>
      <span className="flex items-center gap-1.5">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          value={text}
          aria-invalid={message.invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            const error = check(raw);
            setMessage({ text: error ?? '', invalid: Boolean(error) });
            if (!error) onCommit(Number(raw));
          }}
          onBlur={() => {
            if (!message.invalid) return;
            setText(String(value ?? ''));
            setMessage({ text: MSG_KEPT, invalid: false });
          }}
          className={`w-28 min-h-11 md:min-h-9 bg-white/60 border rounded-sm px-2 py-1 font-mono text-base md:text-sm ${message.invalid ? 'border-event' : 'hairline'}`}
        />
        <span className="text-ink-soft text-xs">{unit}</span>
      </span>
      {help && <p id={helpId} className="mt-1 text-xs text-ink-soft">{help}</p>}
      {message.text && <p id={messageId} role="alert" className="mt-1 text-xs text-ink">{message.text}</p>}
    </div>
  );
}
