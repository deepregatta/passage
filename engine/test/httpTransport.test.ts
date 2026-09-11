import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { HttpTileTransport } from '../src/forecast/httpTransport.js';

afterEach(() => vi.useRealTimers());

describe('HTTP forecast transport', () => {
  it('revalidates mutable metadata and preserves gzip bytes with immutable tile caching', async () => {
    const bytes = gzipSync('PFT1 test body');
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ layers: {} }))
      .mockResolvedValueOnce(Response.json({ run_id: 'run' }))
      .mockResolvedValueOnce(new Response(bytes));
    const transport = new HttpTileTransport({ baseUrl: 'https://forecast.test/', fetchFn });
    await transport.fetchLatest();
    await transport.fetchManifest('run');
    expect(await transport.fetchTile('run', 'tile.bin.gz')).toEqual(new Uint8Array(bytes));
    expect(fetchFn.mock.calls.map(([url, init]) => [url, (init as { cache: string }).cache])).toEqual([
      ['https://forecast.test/latest.json', 'no-cache'],
      ['https://forecast.test/forecast-runs/run/manifest.json', 'no-cache'],
      ['https://forecast.test/forecast-runs/run/tile.bin.gz', 'force-cache'],
    ]);
    expect(fetchFn.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it.each(['headers', 'body'] as const)('bounds a stalled %s read, aborts it and leaves no timer', async stage => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => stage === 'headers'
      ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(new ReadableStream({ start() {} }))));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn, timeoutMs: 50, retries: 0 });
    const result = expect(transport.fetchLatest()).rejects.toThrow('forecast fetch timed out after 50 ms for latest.json');
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 500, 503])('retries HTTP %s after a delay and bypasses cached errors', async status => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
      .mockResolvedValueOnce(Response.json({ layers: {} }));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn, retryDelayMs: 25 });
    const result = transport.fetchLatest();
    await vi.advanceTimersByTimeAsync(24);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ layers: {} });
    expect(fetchFn.mock.calls[1]![1]).toEqual(expect.objectContaining({ cache: 'reload' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated network failures with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn, retries: 2, retryDelayMs: 25 });
    const result = expect(transport.fetchLatest()).rejects.toThrow('forecast fetch failed: network error for latest.json');
    await vi.advanceTimersByTimeAsync(25);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can recover after a timeout', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(Response.json({ layers: {} }));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn, timeoutMs: 50, retryDelayMs: 25 });
    const result = transport.fetchLatest();
    await vi.advanceTimersByTimeAsync(75);
    await expect(result).resolves.toEqual({ layers: {} });
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetchFn.mock.calls[1]![1]!.signal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 404])('does not retry HTTP %s', async status => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn });
    await expect(transport.fetchTile('run', 'tile.bin.gz')).rejects.toThrow(`HTTP ${status} for forecast-runs/run/tile.bin.gz`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry invalid JSON and clears its timeout', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{'));
    const transport = new HttpTileTransport({ baseUrl: '/forecast', fetchFn });
    await expect(transport.fetchLatest()).rejects.toThrow(SyntaxError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
