import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIGH_SHARE, NEARLY_FULL_SHARE, formatStorageSize, readStorageUsage, storagePercent } from '../src/lib/storageUsage.js';

const estimating = (estimate) => vi.stubGlobal('navigator', { storage: { estimate } });
const reading = (usage, quota) => { estimating(async () => ({ usage, quota })); return readStorageUsage(); };

afterEach(() => vi.unstubAllGlobals());

describe('readStorageUsage', () => {
  it('is null when the browser has no storage API or no estimate()', async () => {
    vi.stubGlobal('navigator', {});
    expect(await readStorageUsage()).toBeNull();
    vi.stubGlobal('navigator', { storage: {} });
    expect(await readStorageUsage()).toBeNull();
    vi.stubGlobal('navigator', undefined);
    expect(await readStorageUsage()).toBeNull();
  });

  it('is null when estimate() throws or rejects', async () => {
    estimating(() => { throw new Error('denied'); });
    expect(await readStorageUsage()).toBeNull();
    estimating(async () => { throw new Error('denied'); });
    expect(await readStorageUsage()).toBeNull();
  });

  it('is null without a finite positive quota or a finite usage', async () => {
    expect(await reading(10, 0)).toBeNull();
    expect(await reading(10, undefined)).toBeNull();
    expect(await reading(10, -5)).toBeNull();
    expect(await reading(10, NaN)).toBeNull();
    expect(await reading(10, Infinity)).toBeNull();
    expect(await reading(undefined, 100)).toBeNull();
    expect(await reading(NaN, 100)).toBeNull();
    expect(await reading(-1, 100)).toBeNull();
    estimating(async () => undefined);
    expect(await readStorageUsage()).toBeNull();
  });

  it('returns the usage, the quota and their share', async () => {
    expect(await reading(29_000_000, 100_000_000)).toEqual({ usageBytes: 29_000_000, quotaBytes: 100_000_000, share: 0.29, level: 'ok' });
    expect(await reading(0, 100)).toMatchObject({ share: 0, level: 'ok' });
  });

  it('has the thresholds 50 % and 80 %', () => {
    expect([HIGH_SHARE, NEARLY_FULL_SHARE]).toEqual([0.5, 0.8]);
  });

  it.each([
    [4999, 'ok'], [5000, 'high'], [7999, 'high'], [8000, 'nearly-full'], [10_000, 'nearly-full'],
  ])('puts %i of 10,000 at %s', async (usage, level) => {
    expect((await reading(usage, 10_000)).level).toBe(level);
  });

  it('puts shares 0.4999, 0.5, 0.7999 and 0.8 at their levels', async () => {
    expect((await reading(0.4999, 1)).level).toBe('ok');
    expect((await reading(0.5, 1)).level).toBe('high');
    expect((await reading(0.7999, 1)).level).toBe('high');
    expect((await reading(0.8, 1)).level).toBe('nearly-full');
  });
});

describe('formatStorageSize', () => {
  it.each([
    [0, 'less than 1 MB'],
    [999_999, 'less than 1 MB'],
    [1_000_000, '1 MB'],
    [1_499_999, '1 MB'],
    [29_000_000, '29 MB'],
    [29_400_000, '29 MB'],
    [999_000_000, '999 MB'],
    [999_499_999, '999 MB'],
    [999_500_000, '1.0 GB'],
    [1_000_000_000, '1.0 GB'],
    [1_200_000_000, '1.2 GB'],
    [12_340_000_000, '12.3 GB'],
  ])('%i bytes is %s', (bytes, text) => {
    expect(formatStorageSize(bytes)).toBe(text);
  });
});

describe('storagePercent', () => {
  it.each([
    [796, 1000, 79],
    [799, 1000, 79],
    [800, 1000, 80],
    [499, 1000, 49],
    [500, 1000, 50],
    [29_000_000, 100_000_000, 29],
    [0, 100, 0],
    [130, 100, 100],
    [100, 100, 100],
  ])('%i of %i shows %i %%', (usageBytes, quotaBytes, percent) => {
    expect(storagePercent({ usageBytes, quotaBytes })).toBe(percent);
  });
});
