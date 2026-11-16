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
 * Removed (explicit code-unit ranges only):
 * - C0 and C1 controls, U+0000–U+001F and U+007F–U+009F;
 * - the bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E,
 *   U+2066–U+2069;
 * - characters that render blank or hide text (tightened 2026-11-16, before
 *   any file carried names): U+00AD soft hyphen, U+034F grapheme joiner,
 *   U+115F and U+1160 Hangul fillers, U+17B4 and U+17B5 Khmer inherent
 *   vowels, U+180B–U+180F Mongolian selectors, U+200B zero width space,
 *   U+2060–U+2064 word joiner and invisible operators, U+206A–U+206F
 *   deprecated format controls, U+2800 braille pattern blank, U+3164 Hangul filler, U+FE00–U+FE0D
 *   variation selectors 1 to 14, U+FFA0 halfwidth Hangul filler, U+FFF0–U+FFFB
 *   specials and interlinear annotation;
 * - astral (as surrogate pairs): U+1BCA0–U+1BCA3 shorthand format controls,
 *   U+1D173–U+1D17A musical formatting, U+E0000–U+E0FFF tag characters and the
 *   variation-selector supplement (a subdivision flag loses its tags).
 * Kept: U+200C and U+200D (zero width non-joiner and joiner, which emoji
 * sequences and some scripts need) and U+FE0E and U+FE0F (text and emoji
 * presentation). A name left with nothing visible (spaces, U+200C, U+200D,
 * U+FE0E, U+FE0F and combining marks only) is empty, so the default name shows.
 */
// eslint-disable-next-line no-control-regex, no-misleading-character-class -- each code unit here is one the rule removes, combining marks included
const REMOVED = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0D\uFFA0\uFFF0-\uFFFB]/g;
/** The astral ranges above, as surrogate pairs (no u flag: code units, as everywhere in the rule). */
const REMOVED_ASTRAL = /\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|[\uDB40-\uDB43][\uDC00-\uDFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Something a name shows: any code unit but a space, the joiners, the presentation selectors
 * and combining marks (U+0300–U+036F, U+1AB0–U+1AFF, U+1DC0–U+1DFF, U+20D0–U+20FF,
 * U+FE20–U+FE2F), which show nothing on their own: a name with another visible character keeps them.
 */
// eslint-disable-next-line no-misleading-character-class -- single code units, the joiners and the presentation selectors among them
const VISIBLE = /[^ \u200C\u200D\uFE0E\uFE0F\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/;
const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * The name as Passage shows and stores it: white space runs made one space,
 * the characters above removed, lone surrogates removed, trimmed, then cut at
 * PASSAGE_NAME_MAX_LENGTH code units without splitting a surrogate pair, and
 * trimmed again; '' when nothing visible is left. Anything that is not a string gives ''. Idempotent:
 * cleanPassageName(cleanPassageName(x)) === cleanPassageName(x).
 */
export function cleanPassageName(value: unknown): string {
  if (typeof value !== 'string') return '';
  // white space first, so a tab or a line break between words stays a space
  // lone surrogates first: every surrogate left is then paired, so no removal after can join two halves into a new pair
  let name = value.replace(/\s+/g, ' ').replace(LONE_SURROGATE, '').replace(REMOVED_ASTRAL, '').replace(REMOVED, '');
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > PASSAGE_NAME_MAX_LENGTH) {
    const end = isHigh(name.charCodeAt(PASSAGE_NAME_MAX_LENGTH - 1)) ? PASSAGE_NAME_MAX_LENGTH - 1 : PASSAGE_NAME_MAX_LENGTH;
    name = name.slice(0, end).trim();
  }
  // nothing to show: the default name shows instead
  return VISIBLE.test(name) ? name : '';
}
