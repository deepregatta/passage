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
export const sectionTitle = (section) => TITLES[section.title] ?? section.title;

/** @param {unknown} text */
export const checkWording = (text) => TEXTS[text] ?? text;
