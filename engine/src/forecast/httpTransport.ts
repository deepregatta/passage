/**
 * Bounded HTTP transport for R2 (or any static forecast-runs/ host).
 * Browser-safe; retains stored gzip bytes for manifest validation in the store.
 */

import type { LatestDoc, RunManifest, TileFetchOptions, TileTransport } from './store.js';

type CacheMode = 'no-cache' | 'force-cache' | 'reload';

export interface HttpTileTransportOptions {
  /** e.g. "https://forecast.example.com" or "/data/forecast" (dev middleware) */
  baseUrl: string;
  fetchFn?: typeof fetch;
  /** Per-attempt deadline, including reading the response body. Default 15 s. */
  timeoutMs?: number;
  /** Additional attempts for timeout, network, 408/429 and 5xx failures. Default 2. */
  retries?: number;
  /** Initial exponential-backoff delay. Default 250 ms. */
  retryDelayMs?: number;
}

class RetryableFetchError extends Error {}

export class HttpTileTransport implements TileTransport {
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private retryDelayMs: number;

  constructor(options: HttpTileTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    // A bare global fetch called as this.fetchFn has an illegal browser receiver.
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 ||
        !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5 ||
        !Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error('Invalid forecast transport timeout/retry options');
    }
  }

  private async request<T>(path: string, cache: CacheMode, read: (res: Response) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(path, attempt === 0 ? cache : 'reload', read);
      } catch (error) {
        if (!(error instanceof RetryableFetchError) || attempt >= this.retries) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, this.retryDelayMs * 2 ** attempt));
      }
    }
  }

  private async attempt<T>(path: string, cache: CacheMode, read: (res: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new RetryableFetchError(`forecast fetch timed out after ${this.timeoutMs} ms for ${path}`);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    try {
      // Race as well as abort: a supplied fetch implementation may ignore signals.
      return await Promise.race([deadline, (async () => {
        try {
          // Node's fetch types omit browser cache modes; keep the core DOM-free.
          const init = { cache, signal: controller.signal };
          const res = await this.fetchFn(`${this.baseUrl}/${path}`, init);
          if (!res.ok) {
            void res.body?.cancel().catch(() => {});
            const ErrorType = res.status === 408 || res.status === 429 || res.status >= 500
              ? RetryableFetchError : Error;
            throw new ErrorType(`forecast fetch failed: HTTP ${res.status} for ${path}`);
          }
          return await read(res);
        } catch (error) {
          if (error instanceof TypeError) {
            throw new RetryableFetchError(`forecast fetch failed: network error for ${path}`, { cause: error });
          }
          throw error;
        }
      })()]);
    } finally {
      clearTimeout(timer);
    }
  }

  private getJson<T>(path: string): Promise<T> {
    return this.request(path, 'no-cache', async res => await res.json() as T);
  }

  fetchLatest(): Promise<LatestDoc> {
    return this.getJson<LatestDoc>('latest.json');
  }

  fetchManifest(runId: string): Promise<RunManifest> {
    return this.getJson<RunManifest>(`forecast-runs/${runId}/manifest.json`);
  }

  fetchTile(runId: string, path: string, options?: TileFetchOptions): Promise<Uint8Array> {
    return this.request(`forecast-runs/${runId}/${path}`, options?.cache ?? 'force-cache',
      async res => new Uint8Array(await res.arrayBuffer()));
  }
}

/** gunzip via the web-standard DecompressionStream (browser + Node 22+) */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
