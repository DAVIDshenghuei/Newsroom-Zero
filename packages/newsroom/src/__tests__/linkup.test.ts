import { describe, expect, it, vi } from 'vitest';
import {
  LinkupClient,
  LinkupEvidenceSchema,
  gatherLinkupEvidence,
  extractPublishedAt,
  rankStories,
  type StoryCandidate,
} from '../index.js';

const fetchedAt = '2026-07-11T12:00:00.000Z';
const candidate: StoryCandidate = {
  id: 'story-1', source: 'Example Wire', headline: 'Exact headline', body: 'Feed body.',
  url: 'https://example.com/original', fetchedAt, status: 'pending',
};

describe('LinkupClient', () => {
  it('uses the official search and fetch contracts with Bearer authentication', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [
        { name: 'Other report', url: 'https://other.test/report', content: 'Corroboration', type: 'text' },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: '# Original\nVerified body' }), { status: 200 }));
    const client = new LinkupClient({ apiKey: 'top-secret', fetch });

    await expect(client.search('Exact headline Example Wire', {
      from: '2026-07-08T12:00:00.000Z', to: '2026-07-11T12:00:00.000Z',
      includeDomains: ['openai.com', 'anthropic.com'], excludeDomains: ['cnn.com', 'foxnews.com'],
    })).resolves.toHaveLength(1);
    await expect(client.fetch('https://example.com/original')).resolves.toBe('# Original\nVerified body');
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.linkup.so/v1/search', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer top-secret' }),
      body: JSON.stringify({
        q: 'Exact headline Example Wire', depth: 'standard', outputType: 'searchResults',
        fromDate: '2026-07-08', toDate: '2026-07-11',
        includeDomains: ['openai.com', 'anthropic.com'], excludeDomains: ['cnn.com', 'foxnews.com'],
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.linkup.so/v1/fetch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/original', extractImages: false, includeRawHtml: false, renderJs: false }),
    }));
  });

  it('fetches a production document with raw HTML while preserving markdown', async () => {
    const rawHtml = '<meta property="article:published_time" content="2026-07-10T08:00:00Z">';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ markdown: '# Article', rawHtml }), { status: 200 }));
    const client = new LinkupClient({ apiKey: 'top-secret', fetch });

    await expect(client.fetchDocument('https://example.com/article')).resolves.toEqual({ markdown: '# Article', rawHtml });
    expect(fetch).toHaveBeenCalledWith('https://api.linkup.so/v1/fetch', expect.objectContaining({
      body: JSON.stringify({ url: 'https://example.com/article', extractImages: false, includeRawHtml: true, renderJs: false }),
    }));
  });

  it('retries transient fetch request failures before succeeding', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: '# Original\nVerified body' }), { status: 200 }));
    const client = new LinkupClient({ apiKey: 'fixture-value', fetch });

    await expect(client.fetch('https://example.com/original')).resolves.toBe('# Original\nVerified body');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('strictly rejects malformed responses and never exposes the API key', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ name: 'bad' }], extra: true }), { status: 200 }));
    const client = new LinkupClient({ apiKey: 'never-print-me', fetch });
    await expect(client.search('query')).rejects.toThrow('Invalid Linkup search response');
    await expect(client.search('query')).rejects.not.toThrow('never-print-me');
  });
});

describe('extractPublishedAt', () => {
  it.each([
    ['JSON-LD', '<script type="application/ld+json">{"datePublished":"2026-07-11T09:15:00Z"}</script>', '2026-07-11T09:15:00.000Z'],
    ['meta', '<meta property="article:published_time" content="2026-07-10T08:00:00+02:00">', '2026-07-10T06:00:00.000Z'],
    ['semantic time', '<time itemprop="datePublished" datetime="2026-07-09T07:30:00Z">Today</time>', '2026-07-09T07:30:00.000Z'],
    ['semantic time with reversed attributes', '<time datetime="2026-07-08T06:20:00Z" itemprop="datePublished">Yesterday</time>', '2026-07-08T06:20:00.000Z'],
    ['visible US date', 'Published Jan 16, 2026', '2026-01-16T00:00:00.000Z'],
    ['visible long date', 'Published 20 January 2026', '2026-01-20T00:00:00.000Z'],
    ['visible month date', 'Published June 2, 2026', '2026-06-02T00:00:00.000Z'],
  ])('extracts a conservative %s publication date', (_label, content, expected) => {
    expect(extractPublishedAt(content)).toBe(expected);
  });

  it('does not guess a date from unrelated numeric content', () => {
    expect(extractPublishedAt('The company reported 2026 users and $16 million.')).toBeUndefined();
  });

  it('does not treat Updated-only visible text as publication time', () => {
    expect(extractPublishedAt('Updated June 2, 2026')).toBeUndefined();
  });

  it.each([
    ['generic time', '<time datetime="2026-07-09T07:30:00Z">Event starts today</time>'],
    ['update-specific time', '<time class="updated" datetime="2026-07-10T10:00:00Z">Updated today</time>'],
  ])('rejects %s markup without publication semantics', (_label, content) => {
    expect(extractPublishedAt(content)).toBeUndefined();
  });
});

describe('gatherLinkupEvidence', () => {
  it('retains search and successful canonical-original verification for every ranked story', async () => {
    const stories = rankStories([candidate]);
    const client = {
      search: vi.fn().mockResolvedValue([{ name: 'Other', url: 'https://other.test/report', content: 'Useful details', type: 'text' }]),
      fetch: vi.fn().mockResolvedValue('# Original\nFull original source'),
    };
    const evidence = await gatherLinkupEvidence(stories, client);
    expect(LinkupEvidenceSchema.array().parse(evidence)[0]).toMatchObject({
      storyId: 'story-1', query: 'Exact headline Example Wire',
      original: { url: 'https://example.com/original', markdown: '# Original\nFull original source' },
      verificationStatus: 'verified',
    });
  });

  it('records safe per-story failures so the gate can block instead of aborting the run', async () => {
    const stories = rankStories([candidate]);
    const evidence = await gatherLinkupEvidence(stories, {
      search: vi.fn().mockRejectedValue(new Error('safe search failure')),
      fetch: vi.fn().mockRejectedValue(new Error('safe fetch failure')),
    });
    expect(evidence[0]).toMatchObject({ searchResults: [], verificationStatus: 'failed' });
    expect(evidence[0].errors).toEqual(['safe search failure', 'safe fetch failure']);
  });
});
