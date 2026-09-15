// Shared cartographic colors for Tailwind, charts and Leaflet/SVG overlays.
export const themeColors = {
  paper: { DEFAULT: '#F3EEE3', deep: '#EAE2CF' },
  shoal: '#DCE5E6',
  line: '#D8CFBA',
  ink: { DEFAULT: '#16283E', deep: '#0C1A2C', soft: '#4C5D73' },
  verdict: {
    within: '#2F6E4F',
    approaching: '#A87718',
    exceeds: '#A63B2A',
    insufficient: '#5A6B82',
  },
  authority: '#9E2B63',
  event: '#176B87',
};

export const palette = {
  ...themeColors,
  sea: '#CBDCE0',
  wind: '#31445E',
  wave: '#52739E',
  unknown: '#9AA6B5',
};

/** Preserve each consumer's opacity while sharing the opaque palette value. */
export function rgba(hex, alpha) {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${rgb.join(',')},${alpha})`;
}
