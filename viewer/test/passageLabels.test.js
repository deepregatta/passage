import { beforeEach, describe, expect, it } from 'vitest';
import { PASSAGE_LABELS_KEY, passageLabels } from '../src/lib/passageLabels.js';

// The names typed with "Rename" on My passages (lib/passageLabels.js): one cleaning
// rule with the engine's cleanPassageName, so a name read back, or from a file, is
// shown the same way it was typed.
beforeEach(() => {
  localStorage.clear();
  passageLabels.forgetMemory();
});

describe('a typed rename', () => {
  it('drops a right-to-left override, which would reorder what the card shows', () => {
    const { labels } = passageLabels.set('local|passage|p1', 'Brest \u202Eevil\u202C → Yeu');
    expect(labels['local|passage|p1']).toBe('Brest evil → Yeu');
  });

  it('never leaves half of an emoji at the 80-character cut', () => {
    const { labels } = passageLabels.set('local|passage|p1', `${'a'.repeat(79)}😀`);
    const label = labels['local|passage|p1'];
    expect(label).toBe('a'.repeat(79));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label)).toBe(false);
  });

  it('reads a stored name back through the same rule', () => {
    localStorage.setItem(PASSAGE_LABELS_KEY, JSON.stringify({ 'local|passage|p1': ' Cherbourg\u200B →\tPlymouth ' }));
    expect(passageLabels.all()).toEqual({ 'local|passage|p1': 'Cherbourg → Plymouth' });
  });
});

describe('a route name shown as a passage name or title', () => {
  // check content from a file: shown cleaned, never changed where it is saved
  const hostile = '  Brest \u202Eevil\u202C\u200B →\tYeu  ';
  it('is cleaned as a default passage name, a heading and a title from the legs, and the ordinary names stay as they are', async () => {
    const { passageDefaultName, routeName, userRouteName } = await import('../src/lib/passages.js');
    const { routeTitle } = await import('../src/pages/briefing/routeLabels.jsx');
    const route = { name: hostile, mode: 'draw' };
    expect(passageDefaultName(route, 'cherbourg-plymouth-v1', 'en')).toBe('Brest evil → Yeu');
    expect(route.name).toBe(hostile);
    expect(userRouteName(route)).toBe('Brest evil → Yeu');
    expect(routeName('a\u202Eb-c-v1')).toBe('Ab c');
    expect(routeTitle({ route_id: 'x', legs: [{ name: 'Brest\u202E → A' }, { name: 'A → Yeu\u2066' }] })).toBe('Brest → Yeu');
    // the fixtures' names and the ordinary ones
    expect(passageDefaultName({ name: 'Cherbourg → Plymouth' }, 'x', 'en')).toBe('Cherbourg → Plymouth');
    expect(userRouteName({ name: 'Île d’Yeu → Brest 🌊', mode: 'draw' })).toBe('Île d’Yeu → Brest 🌊');
    expect(routeTitle({ route_id: 'x', legs: [{ name: 'Cherbourg → Cap de la Hague' }, { name: 'Start Point → Plymouth' }] })).toBe('Cherbourg → Plymouth');
    // a name with nothing to show falls back as a missing one does
    expect(passageDefaultName({ name: '\u202E\u200B' }, 'cherbourg-plymouth-v1', 'en')).toBe('Cherbourg plymouth');
  });
});
