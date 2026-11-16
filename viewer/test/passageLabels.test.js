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

describe('a rename this browser could not store', () => {
  it('lasts the visit when only writing fails (a full storage): the next read does not drop it', async () => {
    const { vi } = await import('vitest');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded.', 'QuotaExceededError'); });
    try {
      const { persisted } = passageLabels.set('local|passage|p1', 'Kept for the visit');
      expect(persisted).toBe(false);
      expect(passageLabels.all()).toEqual({ 'local|passage|p1': 'Kept for the visit' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('names across tabs, with this tab\'s unsaved changes laid over storage', () => {
  // another tab writes local storage directly; this tab's writes fail while `blocked` is true
  let blocked = false;
  let unreadable = false;
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  const getItem = Storage.prototype.getItem;
  const otherTab = (labels) => (Object.keys(labels).length
    ? setItem.call(localStorage, PASSAGE_LABELS_KEY, JSON.stringify(labels))
    : removeItem.call(localStorage, PASSAGE_LABELS_KEY));
  const stored = () => JSON.parse(getItem.call(localStorage, PASSAGE_LABELS_KEY) ?? '{}');
  let spies;
  beforeEach(async () => {
    blocked = false;
    unreadable = false;
    const { vi } = await import('vitest');
    const full = () => { throw new DOMException('Quota exceeded.', 'QuotaExceededError'); };
    spies = [
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function set(key, value) { if (blocked) full(); return setItem.call(this, key, value); }),
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function remove(key) { if (blocked) full(); return removeItem.call(this, key); }),
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function get(key) { if (unreadable) throw new Error('blocked'); return getItem.call(this, key); }),
    ];
  });
  const restore = () => spies.forEach((spy) => spy.mockRestore());

  it('keeps another tab\'s rename when this tab later writes', () => {
    try {
      blocked = true;
      passageLabels.set('local|passage|a', 'Mine, unsaved');
      otherTab({ ...stored(), 'local|passage|b': 'From tab B' });
      // this tab still shows its own unsaved name, over what storage now holds
      expect(passageLabels.all()).toEqual({ 'local|passage|a': 'Mine, unsaved', 'local|passage|b': 'From tab B' });
      blocked = false;
      const { persisted } = passageLabels.set('local|passage|c', 'Third');
      expect(persisted).toBe(true);
      expect(stored()).toEqual({ 'local|passage|a': 'Mine, unsaved', 'local|passage|b': 'From tab B', 'local|passage|c': 'Third' });
    } finally {
      restore();
    }
  });

  it('never brings back names another tab deleted when this tab later writes', () => {
    try {
      otherTab({ 'local|passage|x': 'Old x', 'local|passage|y': 'Old y' });
      expect(passageLabels.all()).toEqual({ 'local|passage|x': 'Old x', 'local|passage|y': 'Old y' });
      blocked = true;
      passageLabels.set('local|passage|a', 'Mine');
      otherTab({});
      blocked = false;
      passageLabels.set('local|passage|c', 'Third');
      expect(stored()).toEqual({ 'local|passage|a': 'Mine', 'local|passage|c': 'Third' });
      expect(passageLabels.all()).toEqual({ 'local|passage|a': 'Mine', 'local|passage|c': 'Third' });
    } finally {
      restore();
    }
  });

  it.each([
    ['reading and writing work', false, false, true],
    ['only writing fails (a full storage)', false, true, false],
    ['only reading fails', true, false, true],
    ['both fail (blocked storage)', true, true, false],
  ])('keeps a typed name for the visit when %s', (_case, cannotRead, cannotWrite, persists) => {
    try {
      otherTab({ 'local|passage|old': 'Old' });
      expect(passageLabels.all()).toEqual({ 'local|passage|old': 'Old' });
      unreadable = cannotRead;
      blocked = cannotWrite;
      const { persisted, labels } = passageLabels.set('local|passage|p1', 'Typed');
      expect(persisted).toBe(persists);
      expect(labels).toEqual({ 'local|passage|old': 'Old', 'local|passage|p1': 'Typed' });
      // the next reads, however many, keep it
      expect(passageLabels.all()).toEqual({ 'local|passage|old': 'Old', 'local|passage|p1': 'Typed' });
      expect(passageLabels.all()).toEqual({ 'local|passage|old': 'Old', 'local|passage|p1': 'Typed' });
      unreadable = false;
      blocked = false;
      expect(passageLabels.all()['local|passage|p1']).toBe('Typed');
      if (persists) expect(stored()['local|passage|p1']).toBe('Typed');
    } finally {
      restore();
    }
  });

  it('keeps a removal this tab could not store, over a stored name', () => {
    try {
      otherTab({ 'local|passage|x': 'Old x' });
      passageLabels.all();
      blocked = true;
      passageLabels.remove('local|passage|x');
      expect(passageLabels.all()).toEqual({});
      blocked = false;
      passageLabels.set('local|passage|c', 'Third');
      expect(stored()).toEqual({ 'local|passage|c': 'Third' });
    } finally {
      restore();
    }
  });
});
