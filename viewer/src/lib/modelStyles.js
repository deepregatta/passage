import { palette } from './palette.js';

// Deterministic-model catalogue for the comparison chart: a human name plus a line
// style that survives colour-blindness and grayscale (hue AND dash differ per model).
// Ids come from the analysis (gfs_0p25, ecmwf_ifs_0p25) and from older saved snapshots
// and fixtures (gfs_global, ecmwf_ifs025, icon_eu); aliases share one look.

const ECMWF = { label: 'ECMWF IFS 0.25°', color: palette.ink.DEFAULT, dash: 'solid', width: 2.2 };
const GFS = { label: 'GFS 0.25°', color: palette.verdict.approaching, dash: 'dashed', width: 2.2 };
const ICON = { label: 'ICON-EU', color: palette.event, dash: 'dotted', width: 2.2 };

export const MODEL_STYLES = {
  ecmwf_ifs_0p25: ECMWF,
  ecmwf_ifs025: ECMWF,
  gfs_0p25: GFS,
  gfs_global: { ...GFS, label: 'GFS' },
  icon_eu: ICON,
};

// Any model not in the catalogue still gets a distinct look: purple, dash-dot.
const OTHER = { color: palette.authority, dash: [8, 3, 2, 3], width: 2.2 };

/** Name, colour and dash for one model id. Unknown ids keep their raw id as the label. */
export function modelStyle(model) {
  return MODEL_STYLES[model] ?? { ...OTHER, label: model };
}

/** SVG stroke-dasharray for the legend swatch matching an ECharts line dash. */
export function dashArray(dash) {
  if (dash === 'dashed') return '7 4';
  if (dash === 'dotted') return '2 3';
  if (Array.isArray(dash)) return dash.join(' ');
  return undefined;
}
