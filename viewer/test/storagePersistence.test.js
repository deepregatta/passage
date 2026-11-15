import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSIST_ASKED_KEY, PERSIST_RETRY_DAYS, readPersisted, requestPersistence } from '../src/lib/storagePersistence.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const storing = (storage) => vi.stubGlobal('navigator', { storage });
const blockLocalStorage = () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('readPersisted', () => {
  it('is true or false as the browser says', async () => {
    storing({ persisted: async () => true });
    expect(await readPersisted()).toBe(true);
    storing({ persisted: async () => false });
    expect(await readPersisted()).toBe(false);
  });

  it('is null when the browser cannot say: no API, no persisted(), a throwing or rejecting call, a non-boolean answer', async () => {
    vi.stubGlobal('navigator', {});
    expect(await readPersisted()).toBeNull();
    storing({});
    expect(await readPersisted()).toBeNull();
    storing({ persisted: () => { throw new Error('no'); } });
    expect(await readPersisted()).toBeNull();
    storing({ persisted: async () => { throw new Error('no'); } });
    expect(await readPersisted()).toBeNull();
    storing({ persisted: async () => undefined });
    expect(await readPersisted()).toBeNull();
  });
});

describe('requestPersistence', () => {
  it('names its interval in days', () => {
    expect(PERSIST_RETRY_DAYS).toBe(30);
  });

  it('does nothing when the browser has no persist()', async () => {
    const persisted = vi.fn(async () => false);
    vi.stubGlobal('navigator', {});
    await requestPersistence(NOW);
    storing({ persisted });
    await requestPersistence(NOW);
    expect(persisted).not.toHaveBeenCalled();
    expect(localStorage.getItem(PERSIST_ASKED_KEY)).toBeNull();
  });

  it('does nothing when the data is already persistent, and remembers nothing', async () => {
    const persist = vi.fn(async () => true);
    storing({ persist, persisted: async () => true });
    await requestPersistence(NOW);
    expect(persist).not.toHaveBeenCalled();
    expect(localStorage.getItem(PERSIST_ASKED_KEY)).toBeNull();
  });

  it('asks once, and remembers when under the internal key prefix', async () => {
    const persist = vi.fn(async () => false);
    storing({ persist, persisted: async () => false });
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(PERSIST_ASKED_KEY.startsWith('deepweather.')).toBe(true);
    expect(localStorage.getItem(PERSIST_ASKED_KEY)).toBe(String(NOW));
  });

  it('does not ask again within 30 days, and asks again after them', async () => {
    const persist = vi.fn(async () => false);
    storing({ persist, persisted: async () => false });
    await requestPersistence(NOW);
    await requestPersistence(NOW + 1000);
    await requestPersistence(NOW + 29 * DAY);
    await requestPersistence(NOW + 30 * DAY - 1);
    expect(persist).toHaveBeenCalledTimes(1);
    await requestPersistence(NOW + 30 * DAY);
    expect(persist).toHaveBeenCalledTimes(2);
    await requestPersistence(NOW + 31 * DAY);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(PERSIST_ASKED_KEY)).toBe(String(NOW + 30 * DAY));
  });

  it('does not let a remembered time in the future block asking, nor garbage', async () => {
    const persist = vi.fn(async () => false);
    storing({ persist, persisted: async () => false });
    localStorage.setItem(PERSIST_ASKED_KEY, String(NOW + 400 * DAY));
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(1);
    localStorage.setItem(PERSIST_ASKED_KEY, 'not a time');
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('asks when persisted() throws or rejects, and when it is missing', async () => {
    const persist = vi.fn(async () => false);
    storing({ persist, persisted: () => { throw new Error('no'); } });
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(1);
    localStorage.clear();
    storing({ persist, persisted: async () => { throw new Error('no'); } });
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(2);
    localStorage.clear();
    storing({ persist });
    await requestPersistence(NOW);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('swallows a rejecting or throwing persist(), and still counts the ask', async () => {
    storing({ persist: async () => { throw new Error('refused'); }, persisted: async () => false });
    await expect(requestPersistence(NOW)).resolves.toBeUndefined();
    expect(localStorage.getItem(PERSIST_ASKED_KEY)).toBe(String(NOW));
    localStorage.clear();
    storing({ persist: () => { throw new Error('sync'); }, persisted: async () => false });
    await expect(requestPersistence(NOW)).resolves.toBeUndefined();
  });

  it('with blocked localStorage asks this time and remembers nothing', async () => {
    const persist = vi.fn(async () => false);
    storing({ persist, persisted: async () => false });
    blockLocalStorage();
    await expect(requestPersistence(NOW)).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
    await requestPersistence(NOW + 1000);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not repeat an ask that never answers', async () => {
    const persist = vi.fn(() => new Promise(() => {}));
    storing({ persist, persisted: async () => false });
    requestPersistence(NOW);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    requestPersistence(NOW + 1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
