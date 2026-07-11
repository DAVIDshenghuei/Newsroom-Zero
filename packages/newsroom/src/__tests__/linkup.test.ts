import { describe, expect, it, vi } from 'vitest';
import {
  LinkupClient,
  LinkupEvidenceSchema,
  gatherLinkupEvidence,
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

    await expect(client.search('Exact headline Example Wire')).resolves.toHaveLength(1);
    await expect(client.fetch('https://example.com/original')).resolves.toBe('# Original\nVerified body');
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.linkup.so/v1/search', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer top-secret' }),
      body: JSON.stringify({ q: 'Exact headline Example Wire', depth: 'standard', outputType: 'searchResults' }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.linkup.so/v1/fetch', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/original', extractImages: false, includeRawHtml: false, renderJs: false }),
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
