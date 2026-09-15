import { themeColors, palette, rgba } from './src/lib/palette.js';

/** @type {import('tailwindcss').Config} */
// Sober marine cartography (brief §16): chart-paper surfaces, ink-navy structure,
// shallow-water wash for data panels, chart-magenta reserved for the authority layer
// (on paper charts magenta marks lights & cautions — never decoration here either).
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: themeColors,
      fontFamily: {
        story: ['Source Serif 4', 'Georgia', 'serif'],
        chart: ['Source Serif 4', 'Georgia', 'serif'],
        instrument: ['Archivo Narrow', 'Arial Narrow', 'sans-serif'],
        sans: ['Archivo Narrow', 'Arial Narrow', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        panel: `0 1px 0 ${rgba(palette.ink.DEFAULT, '0.08')}, 0 2px 8px ${rgba(palette.ink.DEFAULT, '0.06')}`,
      },
    },
  },
  plugins: [],
};
