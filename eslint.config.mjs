import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/node_modules/**', 'analysis/**', 'data/**', 'output/**', 'trashbin/**', '.playwright-cli/**']),
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    files: ['engine/**/*.{ts,tsx}', 'viewer/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    // Match TypeScript's unused-parameter convention for interface/test adapters.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }] },
  },
  {
    files: ['eslint.config.mjs', 'scripts/**/*.{js,mjs,cjs}', 'viewer/*.{js,mjs,cjs}', 'viewer/scripts/**/*.mjs', 'engine/test/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['viewer/src/**/*.{js,jsx,ts,tsx}', 'viewer/test/**/*.{js,jsx,ts,tsx}', 'viewer/e2e/**/*.{js,ts}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['viewer/test/**/*.{js,jsx,ts,tsx}', 'viewer/e2e/**/*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
]);
