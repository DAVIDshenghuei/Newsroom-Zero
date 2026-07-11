import type { FeedFetcher, FeedSource } from './feeds.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class HttpFeedFetcher implements FeedFetcher {
  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  async fetch(source: FeedSource): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(source.url, {
        headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Feed ${source.id} returned HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > this.maxBytes) {
        throw new Error(`Feed ${source.id} exceeds ${this.maxBytes} byte limit`);
      }
      if (!response.body) return '';

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let result = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBytes) {
          await reader.cancel();
          throw new Error(`Feed ${source.id} exceeds ${this.maxBytes} byte limit`);
        }
        result += decoder.decode(value, { stream: true });
      }
      return result + decoder.decode();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error(`Feed ${source.id} timed out after ${this.timeoutMs}ms`);
        timeoutError.name = 'AbortError';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
