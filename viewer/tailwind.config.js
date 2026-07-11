/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Sober marine cartography palette (mockup direction) — refined at M4 with the
      // frontend-design pass; keep chart-paper surfaces + ink-navy structure.
      colors: {
        ink: {
          DEFAULT: '#0e2038',
          deep: '#091729',
          soft: '#31445e',
        },
        chart: {
          paper: '#f4efe4',
          line: '#d8d0bd',
        },
        verdict: {
          within: '#1d7a53',
          approaching: '#c98a1b',
          exceeds: '#b3372c',
          insufficient: '#5b6b83',
          warning: '#8f1d1d',
        },
      },
      fontFamily: {
        serif: ['Georgia', 'Times New Roman', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
