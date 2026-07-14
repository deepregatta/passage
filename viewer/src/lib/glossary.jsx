// One shared glossary: tooltip terms in the briefing AND the reference list in
// Settings. The tool should teach while briefing (brief §8).

export const GLOSSARY = {
  gust: 'A brief burst above the sustained wind. Gusts are often 20–40% stronger; squalls can double it.',
  ensemble:
    'The same model run ~30 times with slightly different starting conditions (31 members for GEFS). The spread between members shows how uncertain the forecast is.',
  'forecast scenarios':
    'The ensemble members. "24 of 31 scenarios exceed your limit" is a raw count, not a calibrated probability. The total comes from the current run.',
  'ETA window':
    'Your arrival time is a range, not an instant: computed for your slow, usual and fast boat speeds. Conditions are checked across the whole window.',
  'model run':
    'Weather models restart from fresh observations every 6–12 h. A new run can shift the forecast, so recheck before departure.',
  veer: 'Wind direction turning clockwise (e.g. SW → NW). Common behind a cold front.',
  'significant wave height':
    'The average of the highest third of waves. Individual waves can be nearly twice this height.',
  steepness:
    'Wave height relative to wavelength. Steep waves break; short, steep seas are dangerous well below your height limit.',
  'wind over tide':
    'Wind against the tidal stream makes waves shorter and steeper. The Alderney Race is a well-known example.',
  'tidal gate':
    'A passage best crossed in fair or slack stream. Miss the window and you meet foul current, rougher seas, or both.',
};

/** Keyboard- and touch-focusable teaching popover. */
export function Term({ children, term }) {
  const def = GLOSSARY[term ?? String(children).toLowerCase()];
  if (!def) return children;
  const id = `term-${String(term ?? children).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return <span className="relative inline-block group">
    <button type="button" aria-describedby={id} className="border-b border-dotted border-ink-soft/60 cursor-help leading-inherit">{children}</button>
    <span id={id} role="tooltip" className="hidden group-focus-within:block group-hover:block absolute z-20 left-0 top-full mt-1 w-64 bg-ink-deep text-paper p-2 font-instrument text-xs leading-relaxed shadow-lg">{def}</span>
  </span>;
}
