import { useEffect, useState } from 'react';
import { localTimeZoneName } from '../../lib/format.js';

export default function DepartureField({ value, onChange }) {
  const [timeDraft, setTimeDraft] = useState(value.slice(11, 16));
  const date = value.slice(0, 10);
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeDraft);

  useEffect(() => {
    setTimeDraft(value.slice(11, 16));
  }, [value]);

  const updateTime = (next) => {
    setTimeDraft(next);
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next)) onChange(`${date}T${next}`);
  };

  return (
    <fieldset className="block">
      <legend className="eyebrow block mb-1">Departure · local time</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_7.25rem] gap-2">
        <label>
          <span className="sr-only">Departure date</span>
          <input
            type="date"
            value={date}
            onChange={(event) => onChange(`${event.target.value}T${validTime ? timeDraft : value.slice(11, 16)}`)}
            className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono"
          />
        </label>
        <label>
          <span className="sr-only">Departure time, 24-hour clock</span>
          <input
            type="text"
            value={timeDraft}
            onChange={(event) => updateTime(event.target.value)}
            onBlur={() => { if (!validTime) setTimeDraft(value.slice(11, 16)); }}
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
            placeholder="HH:mm"
            aria-invalid={!validTime}
            className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono tabular-nums"
          />
        </label>
      </div>
      <p className="mt-1 text-[11px] text-ink-soft">
        <span>24-hour clock (HH:mm)</span> · <span>your local time</span> ·{' '}
        <span className="font-mono">{localTimeZoneName()}</span>
      </p>
    </fieldset>
  );
}

