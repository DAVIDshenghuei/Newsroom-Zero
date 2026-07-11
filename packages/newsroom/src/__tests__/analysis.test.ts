import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicAnalysisGenerator,
  LlmAnalysisSchema,
  buildAnalysisPrompt,
  rankStories,
  runAnalysisFactGate,
  writeAnalysisBulletinScript,
  type LinkupEvidence,
} from '../index.js';

const stories = rankStories([{
  id: 'story-1', source: 'Example Wire', headline: 'AI glasses launch', body: 'The verified source body.',
  url: 'https://example.com/story', fetchedAt: '2026-07-11T12:00:00.000Z', status: 'pending',
}]);
const evidence: LinkupEvidence[] = [{
  storyId: 'story-1', query: 'AI glasses launch', searchResults: [],
  original: { url: 'https://example.com/story', markdown: '# AI glasses launch\nVerified original content.' },
  verificationStatus: 'verified', errors: [],
}];
const analysis = {
  title: 'AI Glasses Product Strategy Briefing',
  executiveSummary: { text: 'The category is moving toward practical products.', sourceStoryIds: ['story-1'] },
  storyBriefs: [{ storyId: 'story-1', headline: 'AI glasses launch', summary: 'A verified launch shapes the market.', sourceStoryIds: ['story-1'] }],
  crossStoryTrends: [{ text: 'Hardware and AI are converging.', sourceStoryIds: ['story-1'] }],
  strategicImplications: [{ text: 'Teams should prioritize useful workflows.', sourceStoryIds: ['story-1'] }],
  actionableRecommendations: [{ text: 'Test one focused user workflow.', sourceStoryIds: ['story-1'] }],
};

describe('LLM analysis schema and prompt', () => {
  it('requires citations on every factual analysis item and rejects extra fields', () => {
    expect(LlmAnalysisSchema.parse(analysis)).toEqual(analysis);
    expect(() => LlmAnalysisSchema.parse({ ...analysis, extra: true })).toThrow();
    expect(() => LlmAnalysisSchema.parse({ ...analysis, crossStoryTrends: [{ text: 'Uncited', sourceStoryIds: [] }] })).toThrow();
  });

  it('grounds the prompt in verified sources and user preferences', () => {
    const prompt = buildAnalysisPrompt({
      preferences: { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' },
      stories, evidence,
    });
    expect(prompt).toContain('AI Glasses');
    expect(prompt).toContain('Product Strategy');
    expect(prompt).toContain('Past 3 Days');
    expect(prompt).toContain('story-1');
    expect(prompt).toContain('Verified original content.');
    expect(prompt).toContain('Do not use outside knowledge');
    expect(prompt).toContain('English');
  });
});

describe('AnthropicAnalysisGenerator', () => {
  it('uses Anthropic Messages API and parses fenced JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` }],
    }), { status: 200 }));
    const generator = new AnthropicAnalysisGenerator({ apiKey: 'fixture-value', model: 'fixture-model', fetch });
    await expect(generator.generate({
      preferences: { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' }, stories, evidence,
    })).resolves.toEqual(analysis);
    expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'x-api-key': 'fixture-value', 'anthropic-version': '2023-06-01' }),
    }));
  });

  it('rejects malformed output without exposing credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'not json' }] }), { status: 200 }));
    const generator = new AnthropicAnalysisGenerator({ apiKey: 'never-print-this', fetch });
    await expect(generator.generate({
      preferences: { topics: 'AI', analysisAngles: 'Strategy', timeRange: 'Past 24 Hours' }, stories, evidence,
    })).rejects.toThrow('Invalid Anthropic analysis response');
    await expect(generator.generate({
      preferences: { topics: 'AI', analysisAngles: 'Strategy', timeRange: 'Past 24 Hours' }, stories, evidence,
    })).rejects.not.toThrow('never-print-this');
  });
});

describe('analysis fact gate and script', () => {
  it('approves fully cited analysis backed by verified original sources', () => {
    const gate = runAnalysisFactGate(analysis, stories, evidence, '2026-07-11T12:30:00.000Z');
    expect(gate.approved).toBe(true);
    const script = writeAnalysisBulletinScript(analysis, stories, '2026-07-11T12:30:00.000Z', gate.scriptStatus);
    expect(script.status).toBe('ready_for_voice');
    expect(script.segments.filter((segment) => segment.kind === 'factual').every((segment) => segment.citations.length > 0)).toBe(true);
    expect(script.segments.flatMap((segment) => segment.citations).every((citation) => citation.url === stories[0].canonicalUrl)).toBe(true);
  });

  it('blocks unknown source IDs and malformed missing citations', () => {
    const unknown = { ...analysis, crossStoryTrends: [{ text: 'Unsupported trend.', sourceStoryIds: ['unknown-story'] }] };
    expect(runAnalysisFactGate(unknown, stories, evidence, '2026-07-11T12:30:00.000Z')).toMatchObject({ approved: false, scriptStatus: 'blocked' });
    const missing = { ...analysis, actionableRecommendations: [{ text: 'Uncited recommendation.', sourceStoryIds: [] }] };
    const gate = runAnalysisFactGate(missing, stories, evidence, '2026-07-11T12:30:00.000Z');
    expect(gate.approved).toBe(false);
    expect(gate.reasons.join(' ')).toContain('structured analysis');
  });
});
