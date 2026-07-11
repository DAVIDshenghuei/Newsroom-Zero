import { describe, expect, it, vi } from 'vitest';
import { ingestFeeds, normalizeFeed, type FeedFetcher, type FeedSource } from '../feeds.js';

const source: FeedSource = {
  id: 'example-tech',
  name: 'Example Tech',
  url: 'https://example.com/feed.xml',
};

describe('normalizeFeed', () => {
  it('normalizes RSS 2.0 items into StoryCandidates', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel><title>Example Tech</title>
        <item><guid>post-42</guid><title> A useful headline </title>
          <description><![CDATA[<p>A useful summary.</p>]]></description>
          <link>https://example.com/posts/42</link>
          <pubDate>Fri, 10 Jul 2026 08:30:00 GMT</pubDate>
          <author>reporter@example.com (Ada Reporter)</author>
        </item>
      </channel></rss>`;

    expect(normalizeFeed(xml, source, '2026-07-11T12:00:00.000Z')).toEqual([{
      id: expect.stringMatching(/^feed_[a-f0-9]{64}$/),
      source: 'Example Tech',
      sourceUrl: source.url,
      headline: 'A useful headline',
      body: 'A useful summary.',
      url: 'https://example.com/posts/42',
      publishedAt: '2026-07-10T08:30:00.000Z',
      author: 'reporter@example.com (Ada Reporter)',
      externalId: 'post-42',
      fetchedAt: '2026-07-11T12:00:00.000Z',
      status: 'pending',
    }]);
  });

  it('normalizes Atom entries and alternate links', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Example Atom</title><entry><id>tag:example.com,2026:7</id>
      <title type="html">Atom &amp; News</title><summary type="html">A &lt;b&gt;short&lt;/b&gt; update.</summary>
      <link rel="self" href="https://example.com/api/7" />
      <link rel="alternate" href="https://example.com/news/7" />
      <published>2026-07-10T09:00:00Z</published><author><name>Grace Editor</name></author>
      </entry></feed>`;

    const [candidate] = normalizeFeed(xml, source, '2026-07-11T12:00:00.000Z');
    expect(candidate).toMatchObject({
      source: 'Example Tech',
      headline: 'Atom & News',
      body: 'A short update.',
      url: 'https://example.com/news/7',
      publishedAt: '2026-07-10T09:00:00.000Z',
      author: 'Grace Editor',
      externalId: 'tag:example.com,2026:7',
    });
  });

  it('skips malformed items without discarding valid siblings', () => {
    const xml = `<rss version="2.0"><channel>
      <item><guid>bad</guid><description>Missing title</description></item>
      <item><guid>good</guid><title>Valid item</title><description>Useful body</description></item>
      <item><guid>empty</guid><title>Has no body</title></item>
    </channel></rss>`;

    const candidates = normalizeFeed(xml, source, '2026-07-11T12:00:00.000Z');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ headline: 'Valid item', externalId: 'good' });
  });

  it('creates stable IDs independent of fetch time', () => {
    const xml = `<rss version="2.0"><channel><item><guid>stable-key</guid>
      <title>Same story</title><description>Same body</description></item></channel></rss>`;

    const first = normalizeFeed(xml, source, '2026-07-11T12:00:00.000Z')[0];
    const later = normalizeFeed(xml, source, '2026-07-12T12:00:00.000Z')[0];
    expect(first.id).toBe(later.id);
  });
});

describe('ingestFeeds', () => {
  it('uses an injected fetcher for every configured source', async () => {
    const second = { ...source, id: 'other', name: 'Other', url: 'https://other.example/feed' };
    const fetch: FeedFetcher['fetch'] = vi.fn(async (feedSource) =>
      `<rss version="2.0"><channel><item><guid>${feedSource.id}</guid>` +
      `<title>${feedSource.name} story</title><description>Body</description></item></channel></rss>`);
    const fetcher: FeedFetcher = { fetch };

    const result = await ingestFeeds([source, second], fetcher, () => new Date('2026-07-11T12:00:00Z'));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, source);
    expect(fetch).toHaveBeenNthCalledWith(2, second);
    expect(result.map((story) => story.source)).toEqual(['Example Tech', 'Other']);
  });
});
