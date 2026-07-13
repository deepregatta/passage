import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultLanguage, getInitialLanguage } from '../src/i18n.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('language selection', () => {
  it('selects French from a French browser preference', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'en-US']);
    expect(getDefaultLanguage()).toBe('fr');
  });

  it('falls back to English for unsupported browser languages', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    expect(getDefaultLanguage()).toBe('en');
  });

  it('lets a saved explicit choice override browser detection', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['fr-FR']);
    localStorage.setItem('passage-language', 'en');
    expect(getInitialLanguage()).toBe('en');
  });
});
