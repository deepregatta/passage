import { useId, useState } from 'react';
import { gribArea } from '../../lib/gribExport.js';
import { parseGribCoordinate } from './gribBox.js';

// The box's edges as typed fields: another way to set it than the chart.
const FIELDS = [
  { id: 'north', label: 'North', axis: 'lat', edge: 'maxLat' },
  { id: 'south', label: 'South', axis: 'lat', edge: 'minLat' },
  { id: 'west', label: 'West', axis: 'lon', edge: 'minLon' },
  { id: 'east', label: 'East', axis: 'lon', edge: 'maxLon' },
];

const UNREADABLE = {
  lat: 'Enter a latitude from -90 to 90, such as 50.5 or 12.5S.',
  lon: 'Enter a longitude from -180 to 180, such as -9.5 or 9.5W.',
};

const ORDER = {
  north: 'North must be above south.',
  south: 'South must be below north.',
  west: 'West must be west of east. A box cannot cross the 180° meridian.',
  east: 'East must be east of west. A box cannot cross the 180° meridian.',
};

const drafts = (area) => Object.fromEntries(FIELDS.map(({ id, edge }) => [id, area ? String(area[edge]) : '']));

/**
 * North, south, west and east in decimal degrees, applied on blur or Enter
 * through gribArea (the same snapping as a drawn box). With no box yet, the
 * box appears once all four edges are filled in.
 */
export default function GribAreaFields({ area, disabled, onArea }) {
  const [shown, setShown] = useState(area);
  const [values, setValues] = useState(() => drafts(area));
  const [errors, setErrors] = useState({});
  const baseId = useId();
  // A box drawn, dragged or nudged elsewhere replaces what the fields show.
  if (shown !== area) {
    setShown(area);
    setValues(drafts(area));
    setErrors({});
  }

  const apply = (field) => {
    const text = values[field.id].trim();
    if (!text && area) {
      setValues((v) => ({ ...v, [field.id]: String(area[field.edge]) }));
      setErrors((e) => ({ ...e, [field.id]: null }));
      return;
    }
    if (!text) {
      setErrors((e) => ({ ...e, [field.id]: null }));
      return;
    }
    const value = parseGribCoordinate(text, field.axis);
    if (value === null) {
      setErrors((e) => ({ ...e, [field.id]: UNREADABLE[field.axis] }));
      return;
    }
    // The other edges: the box's, or with no box the other fields once they are all readable.
    const edges = {};
    for (const other of FIELDS) {
      edges[other.edge] = other.id === field.id ? value
        : area ? area[other.edge] : parseGribCoordinate(values[other.id], other.axis);
    }
    setErrors((e) => ({ ...e, [field.id]: null }));
    if (Object.values(edges).some((edge) => edge === null)) return;
    if (field.axis === 'lat' ? edges.minLat >= edges.maxLat : edges.minLon >= edges.maxLon) {
      setErrors((e) => ({ ...e, [field.id]: ORDER[field.id] }));
      return;
    }
    const next = gribArea({ lat: edges.minLat, lon: edges.minLon }, { lat: edges.maxLat, lon: edges.maxLon });
    // shows the snapped edge even when the box itself does not change
    setValues((v) => ({ ...v, [field.id]: String(next[field.edge]) }));
    onArea(next);
  };

  return (
    <fieldset disabled={disabled} className="space-y-1.5 pt-1">
      <legend className="text-[12px] text-ink-soft">
        Or type the edges in decimal degrees: south and west are negative, or add S or W.
      </legend>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {FIELDS.map((field) => {
          const error = errors[field.id];
          const errorId = `${baseId}-${field.id}-error`;
          return (
            <div key={field.id}>
              <label htmlFor={`${baseId}-${field.id}`} className="block text-[12px] text-ink-soft">{field.label}</label>
              <input
                id={`${baseId}-${field.id}`}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={values[field.id]}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                onBlur={() => apply(field)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    apply(field);
                  }
                }}
                className={`w-full min-h-11 md:min-h-0 bg-white/60 border rounded-sm px-2 py-1.5 font-mono text-base md:text-sm ${error ? 'border-verdict-exceeds' : 'hairline'}`}
              />
              {error && <p id={errorId} role="alert" className="mt-1 text-[12px] text-verdict-exceeds">{error}</p>}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
