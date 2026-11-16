/**
 * One cleaning rule for a passage's name, wherever it comes from: typed with
 * "Rename", saved in a route, or read from a check file (2026-11-16). A name
 * is free text shown on cards, headings, aria-labels and the tab title, so it
 * must not reorder, hide or break what is around it. Explicit code-unit
 * ranges only (no Unicode property classes and no normalisation, which vary
 * by engine version), so the same name cleans the same everywhere. Pure.
 */

/** The longest name, in UTF-16 code units (the rename field's own bound). */
export const PASSAGE_NAME_MAX_LENGTH = 80;

/**
 * Removed: C0 and C1 controls (U+0000–U+001F, U+007F–U+009F); the
 * bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069; and the invisible U+200B (zero width space) and U+2060
 * (word joiner). Kept: U+200C and U+200D (zero width non-joiner and joiner,
 * which emoji sequences and some scripts need) and tag characters (flag
 * sequences), which are surrogate pairs.
 */
// eslint-disable-next-line no-control-regex -- these code units are exactly what the rule removes
const REMOVED = /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * The name as Passage shows and stores it: white space runs made one space,
 * the characters above removed, lone surrogates removed, trimmed, then cut at
 * PASSAGE_NAME_MAX_LENGTH code units without splitting a surrogate pair, and
 * trimmed again. Anything that is not a string gives ''. Idempotent:
 * cleanPassageName(cleanPassageName(x)) === cleanPassageName(x).
 */
export function cleanPassageName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // white space first, so a tab or a line break between words stays a space
  let name = value.replace(/\s+/g, ' ').replace(REMOVED, '').replace(LONE_SURROGATE, '');
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > PASSAGE_NAME_MAX_LENGTH) {
    const end = isHigh(name.charCodeAt(PASSAGE_NAME_MAX_LENGTH - 1)) ? PASSAGE_NAME_MAX_LENGTH - 1 : PASSAGE_NAME_MAX_LENGTH;
    name = name.slice(0, end).trim();
  }
  return name;
}
