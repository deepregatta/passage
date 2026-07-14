import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

/** Search the full published ORC polar database (3k+ boat types) with the
 * length-bucket generics as the fallback when a boat isn't listed.
 * Index: /data/polars/index.json (built by `deepweather-analysis build-polar-db`);
 * legacy fallback: /data/config/polars/index.json (the two curated boats). */

let indexPromise = null;
function loadIndex() {
  indexPromise ??= (async () => {
    try {
      const res = await fetch('/data/polars/index.json');
      if (res.ok) return (await res.json()).polars ?? [];
    } catch { /* fall through to legacy */ }
    try {
      const res = await fetch('/data/config/polars/index.json');
      if (!res.ok) return [];
      return ((await res.json()).polars ?? []).map((p) => ({ ...p, kind: p.source_kind ?? 'orc_vpp' }));
    } catch {
      return [];
    }
  })();
  return indexPromise;
}

const norm = (text) => (text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function BoatPicker({ polarId, polarLabel, onSelect }) {
  const [index, setIndex] = useState(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (open && !index) loadIndex().then(setIndex);
  }, [open, index]);

  useEffect(() => {
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const generics = useMemo(() => (index ?? []).filter((p) => p.kind === 'generic'), [index]);
  const matches = useMemo(() => {
    if (!index) return [];
    const q = norm(query);
    if (!q) return [];
    const boats = index.filter((p) => p.kind !== 'generic');
    const starts = [];
    const contains = [];
    for (const p of boats) {
      const key = norm(p.label);
      if (key.startsWith(q)) starts.push(p);
      else if (key.includes(q)) contains.push(p);
      if (starts.length >= 30) break;
    }
    return [...starts, ...contains].slice(0, 30);
  }, [index, query]);

  const pick = (entry) => {
    onSelect(entry);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative">
      <span className="eyebrow block mb-1">Your boat (ORC polar)</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 text-left flex justify-between items-baseline gap-2"
      >
        <span>{polarLabel ?? polarId ?? 'Choose your boat…'}</span>
        <span className="text-ink-soft text-[11px]" aria-hidden>{open ? '▴' : '▾ search'}</span>
      </button>
      {open && (
        <div className="absolute z-30 inset-x-0 mt-1 bg-paper border border-ink/40 rounded-sm shadow-panel max-h-80 overflow-y-auto">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && matches.length) pick(matches[0]);
            }}
            placeholder="Type a model, for example First 36.7 or JPK 10.10"
            aria-label="Search boat models"
            className="w-full sticky top-0 bg-white/95 border-b hairline px-2 py-2 text-sm outline-none"
          />
          {!index && <p className="px-2 py-2 text-[12px] text-ink-soft">Loading boat database…</p>}
          {index && query && matches.length === 0 && (
            <p className="px-2 py-2 text-[12px] text-ink-soft">
              No ORC boat matches “{query}”. Choose a generic cruiser by length below. The
              briefing will identify the generic polar.
            </p>
          )}
          <ul role="listbox" aria-label="Boat models">
            {matches.map((p) => (
              <Row key={p.polar_id} entry={p} selected={p.polar_id === polarId} onPick={pick} />
            ))}
          </ul>
          {(query.length > 0 || matches.length === 0) && generics.length > 0 && (
            <>
              <p className="eyebrow px-2 pt-2">Not listed? Generic by boat length</p>
              <ul role="listbox" aria-label="Generic cruiser polars">
                {generics.map((p) => (
                  <Row key={p.polar_id} entry={p} selected={p.polar_id === polarId} onPick={pick} />
                ))}
              </ul>
            </>
          )}
          {index && !query && (
            <p className="px-2 py-2 text-[12px] text-ink-soft">
              {index.filter((p) => p.kind !== 'generic').length.toLocaleString()} boat types from
              the ORC 2025 database. Start typing to search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ entry, selected, onPick }) {
  const meta = [
    entry.loa_m ? `${entry.loa_m} m` : null,
    entry.builder,
    entry.year,
    entry.certs > 1 ? `${entry.certs} certs` : null,
  ].filter(Boolean).join(' · ');
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => onPick(entry)}
        className={clsx(
          'w-full text-left px-2 py-1.5 hover:bg-shoal/50 flex justify-between gap-2 items-baseline',
          selected && 'bg-shoal/60',
        )}
      >
        <span className="text-sm">{entry.label}</span>
        <span className="font-mono text-[10px] text-ink-soft whitespace-nowrap">{meta}</span>
      </button>
    </li>
  );
}
