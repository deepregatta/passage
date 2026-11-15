// The content rules of the no-polar-data check (scripts/check-no-polar-data.mjs),
// shared with the viewer's check-file export (viewer/src/lib/checkFile.js), which
// refuses a file whose text matches one. Plain ECMAScript, no Node or DOM APIs,
// so both can import it. Each rule names its finding; a finding never quotes
// the data it found.

export const POLAR_CONTENT_RULES = [
  // Passage's polar shape and a deep-polars table: a numeric speed matrix.
  ['boat speed matrix', /speeds_kt["']?\s*:\s*\[\s*\[\s*(?:-?\d|null)/],
  // ORC certificate VPP rows: best-VMG angles and speeds as numbers.
  ['ORC best-VMG rows', /\b(?:beat|run)_(?:angle|vmg)["']?\s*:\s*\[\s*-?\d/],
  ['ORC VPP block', /["']vpp["']\s*:\s*\{/],
  // Every deep-polars entry and release carries its licence constraint.
  ['deep-polars licence record', /["']constraint["']\s*:\s*["']no-public-download["']/],
  // .pol text: a TWA\TWS header followed by a numeric row. The header's indent
  // is spaces and tabs only: with \s* every line start would rescan all the
  // blank lines after it, quadratic on a hand-made text of blank lines.
  ['.pol table text', /^[ \t]*twa\s*[\\/]\s*tws\b[^\n]*\r?\n\s*\d/im],
];

/** The names of the rules the text matches, in rule order; empty when none does. */
export function polarContentFindings(text) {
  if (typeof text !== 'string') return [];
  return POLAR_CONTENT_RULES.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
}
