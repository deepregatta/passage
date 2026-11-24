import { stripInvisibleControls } from '@deepweather/engine';
import { own } from '../../lib/own.js';

// Saved briefing sections predate "check" as the one name for a result. The page shows the
// current wording for old and new checks alike; saved files stay as they are.

const TITLES = {
  'Not assessed by this analysis': 'Not assessed by this check',
  'Emulated data in this analysis': 'Emulated data in this check',
};

const TEXTS = {
  'Some values in this briefing come from EMULATED (synthetic) data sources, marked with a badge. Do not use them for a real passage decision.':
    'Some values in this check come from EMULATED (synthetic) data sources, marked with a badge. Do not use them for a real passage decision.',
};

/** @param {{ title?: string }} section */
export const sectionTitle = (section) => {
  const title = stripInvisibleControls(section.title);
  return own(TITLES, title) ?? title;
};

// The one frozen sentence that carries evidence ids, so it is matched as a whole rather than looked up.
const EMULATED_ENTRIES = /^(Emulated evidence entries: .+\.) Provider modes are recorded in the snapshot inputs\.$/;

// The engine's "not assessed" sentence ends with a reference to the product brief, which means nothing to a sailor.
// Matched as a whole sentence (from its first words), the same shape the French entries recognise.
const UNASSESSED = /^(Unassessed hazard classes: [\s\S]* Absence of a flag must not be read as absence of risk) \(brief §5\)\.$/;

/** @param {unknown} text */
export const checkWording = (text) => {
  const known = own(TEXTS, text);
  if (known !== undefined) return known;
  if (typeof text !== 'string') return text;
  return text.replace(EMULATED_ENTRIES, '$1 Provider modes are recorded with this check.').replace(UNASSESSED, '$1.');
};
