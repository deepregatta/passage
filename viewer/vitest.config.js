import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Several tests read local clock times (the example departs 06:00 UTC = 08:00 in Paris).
// Pin the zone so they pass on any machine, including the UTC hosted runners.
process.env.TZ = 'Europe/Paris';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['./test/**/*.test.{js,jsx}'],
    exclude: ['./e2e/**', './node_modules/**', './dist/**'],
    css: false,
    restoreMocks: true,
  },
});
