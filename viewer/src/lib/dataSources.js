// Licence registers, imported at build time (nothing is fetched at run time):
// forecast-tiles' register, vendored under contracts/ with a pin in
// contracts/shared-contracts.lock.json, and Passage's own feeds in
// config/data-sources.json. A value is shown only where a repository file states
// it; every other source reads unconfirmed (see docs/shared-contracts.md).
import tilesRegister from '../../../contracts/forecast-tiles-data-sources.json';
import ownRegister from '../../../config/data-sources.json';

// The forecast-tiles register also covers the routing index and the chart pack,
// which Tactician consumes. Passage reads neither, so a source used only by
// them is not one of Passage's data providers.
export const NOT_PASSAGE_USERS = ['land', 'charts'];

const usedByPassage = (source) => source.used_by.some((user) => !NOT_PASSAGE_USERS.includes(user));

export const FORECAST_SOURCES = tilesRegister.sources.filter(usedByPassage);
export const OTHER_SOURCES = ownRegister.sources;

/** A source is confirmed once its redistribution answer is yes or no; the
 * register holds "unconfirmed" until the owner confirms the terms. */
export const isConfirmed = (source) => source.redistribute === 'yes' || source.redistribute === 'no';

/** Summary line of a group, composed here (not in JSX) so the French catalogue
 * can match it as one pattern: "Forecast model data · 9 sources · none confirmed yet". */
export function groupSummary(title, sources) {
  const total = sources.length;
  const pending = sources.filter((source) => !isConfirmed(source)).length;
  let status;
  if (total === 1) status = pending ? 'not yet confirmed' : 'confirmed';
  else if (pending === total) status = 'none confirmed yet';
  else if (pending === 0) status = 'all confirmed';
  else status = `${pending} not yet confirmed`;
  return `${title} · ${total} ${total === 1 ? 'source' : 'sources'} · ${status}`;
}
