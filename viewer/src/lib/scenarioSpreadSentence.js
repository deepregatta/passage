/**
 * The sentences that describe how the forecast scenarios spread over the
 * passage ("in half of the 31 forecast scenarios the strongest wind ... stays
 * at or under 16 kt"). A count of scenarios, never a probability: none of those
 * words, and no percent sign, belongs here.
 *
 * Built here, in a .js sibling, so each sentence reaches the DOM as one text
 * node and the French catalogue (i18n.js) matches it with one pattern.
 */

/** Whole knots, rounded up: "at or under N kt" must stay true of the figure it rounds. */
export function wholeKnotsUp(kt) {
  return Math.ceil(kt - 1e-6);
}

/**
 * @param {{ wind: object|null, gust: object|null }|null} spread from the engine's scenarioSpread
 * @param {{ emulated?: boolean }} [options] emulated scenarios are named as such, as the verdict sentence names them
 * @returns {Array<{ variable: 'wind'|'gust', text: string }>} wind first, then gust; empty without a spread
 */
export function scenarioSpreadSentences(spread, { emulated = false } = {}) {
  if (!spread) return [];
  const scenarios = emulated ? 'emulated forecast scenarios' : 'forecast scenarios';
  return [['wind', 'wind', spread.wind], ['gust', 'gust', spread.gust]]
    .filter(([, , values]) => values)
    .map(([variable, noun, values]) => ({
      variable,
      text: `In half of the ${values.members} ${scenarios} the strongest ${noun} at the points checked along your route stays at or under ${wholeKnotsUp(values.median)} kt; in nine out of ten, at or under ${wholeKnotsUp(values.p90)} kt.`,
    }));
}
