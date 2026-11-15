import { openCheckMemory } from './openCheckMemory.js';

// What the error boundaries (components/PageErrorBoundary.jsx,
// components/InspectorErrorBoundary.jsx) do with an error: log it in this
// browser's console and nothing else. No analytics event or other report is
// sent, and no saved check is touched.

// The messages browsers give a dynamic import that could not be loaded
// (offline, or a hashed chunk an earlier deploy removed): Chromium, Firefox,
// Safari, and Vite's CSS preload. A bundler's ChunkLoadError is named.
const IMPORT_FAILED = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

/** True when the error is a page's code failing to load, not the page failing to render. */
export function isChunkLoadError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'ChunkLoadError') return true;
  return typeof error.message === 'string' && IMPORT_FAILED.some((pattern) => pattern.test(error.message));
}

/** The page could not be shown: log it, and forget the check this tab
 * remembers having open, so a reload does not reopen the check that failed. */
export function pageCouldNotRender(error, componentStack = '') {
  try {
    console.error('Passage could not show this page:', error, componentStack);
    openCheckMemory.forget();
  } catch {
    // reporting must never become a second error
  }
}

/** The page's code could not be loaded: log it only. The remembered open check
 * stays, so the reload that fetches the code again reopens it. */
export function pageCouldNotLoad(error) {
  try {
    console.error('Passage could not load this page:', error);
  } catch {
    // reporting must never become a second error
  }
}

/** The Evidence inspector could not be shown: log it only (the check itself rendered). */
export function evidenceCouldNotRender(error, componentStack = '') {
  try {
    console.error('Passage could not show this evidence detail:', error, componentStack);
  } catch {
    // reporting must never become a second error
  }
}

/** The page's error message could not be shown either: log it; the page area stays empty. */
export function fallbackCouldNotRender(error) {
  try {
    console.error('Passage could not show the page error message:', error);
  } catch {
    // nothing more to do
  }
}

/** A full reload, which fetches the page's code again. */
export function reloadPage() {
  location.reload();
}
