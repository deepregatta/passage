import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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
