/**
 * HTTP tile transport for R2 (or any static host serving the forecast-runs/
 * layout). Browser-safe; also works in Node 22+ (global fetch and
 * DecompressionStream). Tiles are stored gzipped and decompressed here —
 * the codec always receives raw PFT1 bytes.
 */

import type { LatestDoc, RunManifest, TileTransport } from './store.js';

export interface HttpTileTransportOptions {
  /** e.g. "https://forecast.example.com" or "/data/forecast" (dev middleware) */
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export class HttpTileTransport implements TileTransport {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(options: HttpTileTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    // bind the global: bare `fetch` invoked as `this.fetchFn(...)` gets the
    // transport as its receiver and Chromium throws "Illegal invocation"
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/${path}`);
    if (!res.ok) throw new Error(`forecast fetch failed: HTTP ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  fetchLatest(): Promise<LatestDoc> {
    return this.getJson<LatestDoc>('latest.json');
  }

  fetchManifest(runId: string): Promise<RunManifest> {
    return this.getJson<RunManifest>(`forecast-runs/${runId}/manifest.json`);
  }

  async fetchTile(runId: string, path: string): Promise<Uint8Array> {
    const res = await this.fetchFn(`${this.baseUrl}/forecast-runs/${runId}/${path}`);
    if (!res.ok) throw new Error(`forecast tile fetch failed: HTTP ${res.status} for ${path}`);
    const body = new Uint8Array(await res.arrayBuffer());
    return gunzip(body);
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
