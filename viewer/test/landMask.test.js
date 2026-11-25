import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLandMaskCacheForTests, landMaskForBbox } from '../src/lib/landMask.js';
import { translateText } from '../src/i18n.js';

const bbox = { minLat: 49, maxLat: 50, minLon: -3, maxLon: -1 };

beforeEach(() => clearLandMaskCacheForTests());
afterEach(() => vi.unstubAllGlobals());

describe('when the coastline data cannot be loaded', () => {
  it.each([
    ['the metadata', (url) => url.endsWith('.json')],
    ['the packed mask', (url) => url.endsWith('.bin.gz')],
  ])('says it was needed to compute a route, not for "safe routing" (%s missing)', async (_, fails) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response('', { status: fails(String(url)) ? 404 : 200 })));
    const error = await landMaskForBbox(bbox).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Couldn't load the coastline data needed to compute a route");
    expect(error.message).not.toMatch(/safe|sécuris/i);
  });

  it('has a French sentence for it', () => {
    expect(translateText("Couldn't load the coastline data needed to compute a route", 'fr'))
      .toBe('Impossible de charger les données côtières nécessaires au calcul de la route');
    expect(translateText("Couldn't load the coastline data needed for safe routing", 'fr'))
      .toBe("Couldn't load the coastline data needed for safe routing");
  });
});
