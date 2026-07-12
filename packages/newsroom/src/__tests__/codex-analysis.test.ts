import { describe, expect, it, vi } from 'vitest';
import { CodexAnalysisGenerator } from '../codex-analysis.js';
import type { AnalysisInput, LlmAnalysis } from '../analysis.js';

const analysis: LlmAnalysis = {
  title: 'Grounded briefing',
  executiveSummary: { text: 'Summary', sourceStoryIds: ['story-1'], supportingQuotes: [{ storyId: 'story-1', quote: 'An exact source quotation.' }] },
  storyBriefs: [{ storyId: 'story-1', headline: 'Headline', summary: 'Summary', sourceStoryIds: ['story-1'], supportingQuotes: [{ storyId: 'story-1', quote: 'An exact source quotation.' }] }],
  crossStoryTrends: [{ text: 'Trend', sourceStoryIds: ['story-1'], supportingQuotes: [{ storyId: 'story-1', quote: 'An exact source quotation.' }] }],
  strategicImplications: [{ text: 'Implication', sourceStoryIds: ['story-1'], supportingQuotes: [{ storyId: 'story-1', quote: 'An exact source quotation.' }] }],
  actionableRecommendations: [{ text: 'Action', sourceStoryIds: ['story-1'], supportingQuotes: [{ storyId: 'story-1', quote: 'An exact source quotation.' }] }],
};

const input = {
  preferences: { topics: 'AI glasses', analysisAngles: 'Product strategy', timeRange: 'Past 24 Hours' },
  stories: [{ id: 'story-1', source: 'example.com', headline: 'Headline', body: 'Body', canonicalUrl: 'https://example.com/story', sourceUrl: 'https://example.com/story', publishedAt: '2026-07-12T00:00:00.000Z', status: 'selected', ranking: { score: 1, reasons: ['fixture'] } }],
  evidence: [{ storyId: 'story-1', query: 'query', searchResults: [], original: { url: 'https://example.com/story', markdown: 'An exact source quotation.' }, verificationStatus: 'verified', errors: [] }],
} as unknown as AnalysisInput;

describe('CodexAnalysisGenerator', () => {
  it('passes grounded instructions to the runner and validates its JSON response', async () => {
    const run = vi.fn<(prompt: string) => Promise<string>>(async () => JSON.stringify(analysis));
    await expect(new CodexAnalysisGenerator({ run }).generate(input)).resolves.toEqual(analysis);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toContain('untrusted data');
    expect(run.mock.calls[0][0]).toContain('AI glasses');
  });

  it('rejects malformed or schema-invalid output', async () => {
    await expect(new CodexAnalysisGenerator({ run: async () => '{"title":' }).generate(input))
      .rejects.toThrow('Invalid Codex analysis response');
  });
});
