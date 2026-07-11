/** @type {import('tailwindcss').Config} */
// Sober marine cartography (brief §16): chart-paper surfaces, ink-navy structure,
// shallow-water wash for data panels, chart-magenta reserved for the authority layer
// (on paper charts magenta marks lights & cautions — never decoration here either).
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
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
      },
      fontFamily: {
        chart: ['Iowan Old Style', 'Palatino Linotype', 'Palatino', 'P052', 'Georgia', 'serif'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(22,40,62,0.08), 0 2px 8px rgba(22,40,62,0.06)',
      },
    },
  },
  plugins: [],
};
