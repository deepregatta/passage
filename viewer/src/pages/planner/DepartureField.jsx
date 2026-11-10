import { useEffect, useId, useState } from 'react';
import { localTimeZoneName } from '../../lib/format.js';
import {
  TIME_FORMAT_HINT, departureWindow, horizonText, isCompleteTimeEntry, parseTimeInput,
} from './departureInput.js';

const inputClass = 'w-full min-h-11 bg-white/60 border hairline rounded-sm px-2 py-2 text-base sm:text-sm font-mono aria-[invalid=true]:border-verdict-exceeds';

/** Date and time of departure. Time entry is forgiving ("830", "0830", "8:30"
 * all read as 08:30); a time that cannot be read is explained, not reverted.
 * `issue` is the controller's verdict on the whole departure (past, beyond the
 * forecast, unreadable), shown here where the sailor edits it. */
export default function DepartureField({ value, onChange, issue = null }) {
  const [timeDraft, setTimeDraft] = useState(value.slice(11, 16));
  const [touched, setTouched] = useState(false);
  const hintId = useId();
  const messageId = useId();
  const date = value.slice(0, 10);
  const storedTime = value.slice(11, 16);
  const parsed = parseTimeInput(timeDraft);
  const horizon = departureWindow();
  const timeError = touched && !parsed.ok ? TIME_FORMAT_HINT : null;
  const message = timeError ?? issue?.message ?? null;
  const describedBy = [hintId, message ? messageId : null].filter(Boolean).join(' ');

  useEffect(() => {
    setTimeDraft(storedTime);
  }, [storedTime]);

  const updateTime = (next) => {
    setTouched(false);
    setTimeDraft(next);
    if (!isCompleteTimeEntry(next)) return;
    const read = parseTimeInput(next);
    if (!read.ok) return;
    setTimeDraft(read.value);
    onChange(`${date}T${read.value}`);
  };

  // An unreadable time goes to the draft too, so Compute, Scan and Check stop
  // with a stated reason instead of running on a time the field no longer shows.
  const settleTime = () => {
    setTouched(true);
    if (parsed.ok) {
      setTimeDraft(parsed.value);
      if (parsed.value !== storedTime) onChange(`${date}T${parsed.value}`);
    } else if (timeDraft.trim() !== storedTime) {
      onChange(`${date}T${timeDraft.trim()}`);
    }
  };

  return (
    <fieldset className="block">
      <legend className="sr-only">Departure · local time</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_7.25rem] gap-2">
        <label>
          <span className="sr-only">Departure date</span>
          <input
            type="date"
            value={date}
            min={horizon.minDate}
            max={horizon.maxDate}
            onChange={(event) => onChange(`${event.target.value}T${parsed.ok ? parsed.value : storedTime}`)}
            aria-invalid={date === '' || issue?.dateIssue === true}
            aria-describedby={describedBy}
            className={inputClass}
          />
        </label>
        <label>
          <span className="sr-only">Departure time, 24-hour clock</span>
          <input
            type="text"
            value={timeDraft}
            onChange={(event) => updateTime(event.target.value)}
            onBlur={settleTime}
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            placeholder="HH:mm"
            aria-invalid={Boolean(timeError)}
            aria-describedby={describedBy}
            className={`${inputClass} tabular-nums`}
          />
        </label>
      </div>
      <p id={hintId} className="mt-1 text-[12px] text-ink-soft">
        <span>24-hour clock (HH:mm)</span> · <span>your local time</span> ·{' '}
        <span className="font-mono">{localTimeZoneName()}</span>
        <span className="block">{horizonText(horizon)}</span>
      </p>
      {message && (
        <p id={messageId} role="alert" className="mt-1 text-[13px] text-verdict-exceeds">{message}</p>
      )}
    </fieldset>
  );
}
