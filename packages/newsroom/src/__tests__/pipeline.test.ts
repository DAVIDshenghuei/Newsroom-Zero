import { describe, expect, it } from 'vitest';
import {
  EditionArtifactSchema,
  FactGateDecisionSchema,
  RankedStorySchema,
  BulletinScriptSchema,
  canonicalizeUrl,
  filterCandidatesByPublicationWindow,
  prepareEdition,
  rankStories,
  runFactGate,
  runResearchFactGate,
  writeBulletinScript,
  type Citation,
  type StoryCandidate,
} from '../index.js';

const fetchedAt = '2026-07-11T12:00:00.000Z';
const story = (overrides: Partial<StoryCandidate> & Pick<StoryCandidate, 'id' | 'source' | 'headline'>): StoryCandidate => ({
  body: `${overrides.headline} has supporting detail.`,
  fetchedAt,
  status: 'pending',
  url: `https://example.com/${overrides.id}`,
  ...overrides,
});

describe('canonicalizeUrl', () => {
  it('removes fragments and tracking parameters and sorts the remaining query', () => {
    expect(canonicalizeUrl('https://Example.com/news?z=2&utm_source=x&a=1&fbclid=no#top'))
      .toBe('https://example.com/news?a=1&z=2');
  });
});

describe('rankStories', () => {
  it('never treats fetchedAt as publication recency', () => {
    const ranked = rankStories([
      story({ id: 'unknown', source: 'One', headline: 'Unknown', fetchedAt: '2026-07-11T12:00:00Z' }),
      story({ id: 'dated', source: 'Two', headline: 'Dated', publishedAt: '2026-07-10T00:00:00Z', fetchedAt: '2020-01-01T00:00:00Z' }),
    ]);
    expect(ranked.map(({ id }) => id)).toEqual(['dated', 'unknown']);
    expect(ranked[1].ranking.recency).toBe(0);
  });

  it('deduplicates by canonical URL and then normalized headline', () => {
    const ranked = rankStories([
      story({ id: 'b', source: 'One', headline: 'Same URL original', body: 'Same body', url: 'https://news.test/a?utm_campaign=x&b=2&a=1' }),
      story({ id: 'a', source: 'Two', headline: 'Same URL copy', body: 'Same body', url: 'https://news.test/a?a=1&b=2#fragment' }),
      story({ id: 'c', source: 'Three', headline: 'Markets: Rise Again!' }),
      story({ id: 'd', source: 'Four', headline: 'markets rise again' }),
    ]);
    expect(ranked.map(({ id }) => id).sort()).toEqual(['a', 'c']);
  });

  it('selects exactly the top three with source diversity on the first pass', () => {
    const ranked = rankStories([
      story({ id: 'a', source: 'Wire', headline: 'Newest', publishedAt: '2026-07-11T11:00:00Z' }),
      story({ id: 'b', source: 'Wire', headline: 'Second newest', publishedAt: '2026-07-11T10:00:00Z' }),
      story({ id: 'c', source: 'Daily', headline: 'Third newest', publishedAt: '2026-07-11T09:00:00Z' }),
      story({ id: 'd', source: 'Radio', headline: 'Fourth newest', publishedAt: '2026-07-11T08:00:00Z' }),
    ]);
    expect(ranked.map(({ id }) => id)).toEqual(['a', 'c', 'd']);
    expect(ranked.map(({ rank }) => rank)).toEqual([1, 2, 3]);
  });

  it('uses body completeness and stable ID as deterministic tie-breaks', () => {
    const ranked = rankStories([
      story({ id: 'z', source: 'One', headline: 'Zed', body: 'short' }),
      story({ id: 'b', source: 'Two', headline: 'Bee', body: 'a much more complete body' }),
      story({ id: 'a', source: 'Three', headline: 'Aye', body: 'a much more complete body' }),
    ]);
    expect(ranked.map(({ id }) => id)).toEqual(['a', 'b', 'z']);
  });
});

describe('publication-window filtering', () => {
  const window = { from: '2026-07-10T12:00:00.000Z', to: '2026-07-11T12:00:00.000Z' };

  it('uses exact inclusive timestamps while rejecting old, unknown, and future dates', () => {
    const candidates = [
      story({ id: 'lower', source: 'A', headline: 'Lower', publishedAt: window.from }),
      story({ id: 'upper', source: 'B', headline: 'Upper', publishedAt: window.to }),
      story({ id: 'before', source: 'C', headline: 'Before', publishedAt: '2026-07-10T11:59:59.999Z' }),
      story({ id: 'jan', source: 'D', headline: 'January', publishedAt: '2026-01-16T00:00:00.000Z' }),
      story({ id: 'june', source: 'E', headline: 'June', publishedAt: '2026-06-02T00:00:00.000Z' }),
      story({ id: 'unknown', source: 'F', headline: 'Unknown', fetchedAt: window.to }),
      story({ id: 'future', source: 'G', headline: 'Future', publishedAt: '2026-07-11T12:00:00.001Z' }),
    ];
    const report = filterCandidatesByPublicationWindow(candidates, window);
    expect(report.eligible.map(({ id }) => id)).toEqual(['lower', 'upper']);
    expect(report.rejected.map(({ id, reason }) => [id, reason])).toEqual([
      ['before', 'outside publication window'], ['jan', 'outside publication window'],
      ['june', 'outside publication window'], ['unknown', 'missing publishedAt'],
      ['future', 'future publishedAt'],
    ]);
    expect(rankStories(report.eligible)).toHaveLength(2);
  });
});

describe('script and Fact Gate', () => {
  it.each([
    ['missing', undefined],
    ['old', '2026-01-16T00:00:00.000Z'],
    ['future', '2026-07-11T12:00:00.001Z'],
  ])('research gate independently blocks %s publishedAt', (_label, publishedAt) => {
    const ranked = rankStories([story({ id: 'a', source: 'Wire', headline: 'A precise headline', publishedAt })]);
    const script = writeBulletinScript(ranked, fetchedAt);
    const decision = runResearchFactGate(script, ranked, [{
      storyId: 'a', query: 'query', searchResults: [],
      original: { url: 'https://example.com/a', markdown: 'Verified.' }, verificationStatus: 'verified', errors: [],
    }], fetchedAt, { from: '2026-07-10T12:00:00.000Z', to: fetchedAt });
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([expect.stringContaining('publishedAt')]));
  });

  it('writes only source text and supplies a story ID and URL citation for every factual segment', () => {
    const ranked = rankStories([story({ id: 'a', source: 'Wire', headline: 'A precise headline', body: 'A precise body.' })]);
    const script = writeBulletinScript(ranked, fetchedAt);
    expect(BulletinScriptSchema.parse(script).segments).toHaveLength(1);
    expect(script.segments[0]).toMatchObject({
      kind: 'factual',
      text: 'A precise headline A precise body.',
      citations: [{ storyId: 'a', url: 'https://example.com/a' }],
    });
    expect(runFactGate(script, ranked, fetchedAt).approved).toBe(true);
  });

  it('research gate blocks missing or failed original fetches without changing runFactGate', () => {
    const ranked = rankStories([story({ id: 'a', source: 'Wire', headline: 'A precise headline', body: 'A precise body.' })]);
    const script = writeBulletinScript(ranked, fetchedAt);
    expect(runFactGate(script, ranked, fetchedAt).approved).toBe(true);
    const decision = runResearchFactGate(script, ranked, [{
      storyId: 'a', query: 'A precise headline Wire', searchResults: [],
      original: { url: 'https://example.com/a' }, verificationStatus: 'failed', errors: ['fetch failed'],
    }], fetchedAt);
    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('story a: original fetch not verified');
  });

  it('accepts a verified original fetch when optional corroborating search is empty', () => {
    const ranked = rankStories([story({ id: 'a', source: 'Wire', headline: 'A precise headline', body: 'A precise body.' })]);
    const script = writeBulletinScript(ranked, fetchedAt);
    const decision = runResearchFactGate(script, ranked, [{
      storyId: 'a', query: 'A precise headline Wire', searchResults: [],
      original: { url: 'https://example.com/a', markdown: 'Verified original article content.' },
      verificationStatus: 'verified', errors: [],
    }], fetchedAt);
    expect(decision.approved).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it.each<[string, Citation[]]>([
    ['missing citation', []],
    ['unknown citation', [{ storyId: 'missing', url: 'https://example.com/a', text: 'A precise headline' }]],
    ['missing URL', [{ storyId: 'a', url: '', text: 'A precise headline' }]],
    ['unsupported citation text', [{ storyId: 'a', url: 'https://example.com/a', text: 'Invented fact' }]],
  ])('blocks %s and prevents ready_for_voice', (_label, citations) => {
    const ranked = rankStories([story({ id: 'a', source: 'Wire', headline: 'A precise headline', body: 'A precise body.' })]);
    const script = { ...writeBulletinScript(ranked, fetchedAt), status: 'ready_for_voice' as const };
    script.segments[0] = { ...script.segments[0], citations };
    const decision = runFactGate(script, ranked, fetchedAt);
    expect(decision.approved).toBe(false);
    expect(decision.scriptStatus).toBe('blocked');
  });
});

describe('prepareEdition', () => {
  it('produces contract-valid deterministic artifacts and a ready edition after an approved gate', () => {
    const output = prepareEdition([
      story({ id: 'a', source: 'One', headline: 'Alpha' }),
      story({ id: 'b', source: 'Two', headline: 'Beta' }),
    ], fetchedAt);
    expect(output.rundown.stories).toHaveLength(2);
    expect(RankedStorySchema.array().parse(output.rundown.stories)).toEqual(output.rundown.stories);
    expect(FactGateDecisionSchema.parse(output.factGate).approved).toBe(true);
    expect(EditionArtifactSchema.parse(output.edition).status).toBe('ready_for_voice');
  });
});
