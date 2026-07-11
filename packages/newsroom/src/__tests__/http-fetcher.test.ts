import { describe, expect, it, vi } from 'vitest';
import { HttpFeedFetcher } from '../http-fetcher.js';

const source = { id: 'test', name: 'Test', url: 'https://example.com/feed.xml' };

describe('HttpFeedFetcher', () => {
  it('injects the HTTP implementation and rejects non-success statuses', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('Unavailable', { status: 503 }));
    const fetcher = new HttpFeedFetcher(request);

    await expect(fetcher.fetch(source)).rejects.toThrow('HTTP 503');
    expect(request).toHaveBeenCalledWith(source.url, expect.objectContaining({
      headers: expect.objectContaining({ accept: expect.stringContaining('application/rss+xml') }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects response bodies over the configured byte limit', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('12345'));
    await expect(new HttpFeedFetcher(request, 10_000, 4).fetch(source))
      .rejects.toThrow('4 byte limit');
  });

  it('aborts requests after the configured timeout', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = new HttpFeedFetcher(request, 10).fetch(source);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    vi.useRealTimers();
  });
});
