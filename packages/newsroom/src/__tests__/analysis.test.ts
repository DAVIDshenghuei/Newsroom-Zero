import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicAnalysisGenerator, LlmAnalysisSchema, buildAnalysisPrompt, rankStories,
  runAnalysisFactGate, writeAnalysisBulletinScript, type LinkupEvidence,
} from '../index.js';

const stories = rankStories([{
  id: 'story-1', source: 'Example Wire', headline: 'AI glasses launch', body: 'The verified source body.',
  url: 'https://example.com/story', fetchedAt: '2026-07-11T12:00:00.000Z', status: 'pending',
}]);
const evidence: LinkupEvidence[] = [{
  storyId: 'story-1', query: 'AI glasses launch', searchResults: [],
  original: { url: 'https://example.com/story', markdown: [
    '# AI glasses launch',
    'The category is moving toward practical products.',
    'A verified launch shapes the market.',
    'Hardware and AI are converging.',
    'Teams should prioritize useful workflows.',
    'Test one focused user workflow.',
  ].join('\n') },
  verificationStatus: 'verified', errors: [],
}];
const supported = (quote: string) => [{ storyId: 'story-1', quote }];
const analysis = {
  title: 'AI Glasses Product Strategy Briefing',
  executiveSummary: { text: 'The category is moving toward practical products.', sourceStoryIds: ['story-1'], supportingQuotes: supported('The category is moving toward practical products.') },
  storyBriefs: [{ storyId: 'story-1', headline: 'AI glasses launch', summary: 'A verified launch shapes the market.', sourceStoryIds: ['story-1'], supportingQuotes: supported('A verified launch shapes the market.') }],
  crossStoryTrends: [{ text: 'Hardware and AI are converging.', sourceStoryIds: ['story-1'], supportingQuotes: supported('Hardware and AI are converging.') }],
  strategicImplications: [{ text: 'Teams should prioritize useful workflows.', sourceStoryIds: ['story-1'], supportingQuotes: supported('Teams should prioritize useful workflows.') }],
  actionableRecommendations: [{ text: 'Test one focused user workflow.', sourceStoryIds: ['story-1'], supportingQuotes: supported('Test one focused user workflow.') }],
};
const input = { preferences: { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const, outputLanguage: 'french' as const }, stories, evidence };

describe('LLM analysis schema and prompt', () => {
  it('requires citations and supporting quotes on every factual item', () => {
    expect(LlmAnalysisSchema.parse(analysis)).toEqual(analysis);
    expect(() => LlmAnalysisSchema.parse({ ...analysis, extra: true })).toThrow();
    expect(() => LlmAnalysisSchema.parse({ ...analysis, crossStoryTrends: [{ text: 'Uncited', sourceStoryIds: [], supportingQuotes: [] }] })).toThrow();
  });

  it('puts only source data and preferences in the user prompt', () => {
    const prompt = buildAnalysisPrompt(input);
    expect(prompt).toContain('AI Glasses');
    expect(prompt).toContain('Product Strategy');
    expect(prompt).toContain('Generate every prose field in French');
    expect(prompt).toContain('supportingQuotes verbatim in their original source language');
    expect(prompt).toContain('story-1');
    expect(prompt).toContain('The category is moving toward practical products.');
    expect(prompt).not.toContain('Do not use outside knowledge');
  });

  it('requests Traditional Chinese prose while preserving source-language quotes', () => {
    const prompt = buildAnalysisPrompt({
      ...input,
      preferences: { ...input.preferences, outputLanguage: 'traditional_chinese' },
    });
    expect(prompt).toContain('Generate every prose field in Traditional Chinese');
    expect(prompt).toContain('supportingQuotes verbatim in their original source language');
    expect(prompt).toContain('The category is moving toward practical products.');
  });

  it('keeps the system prompt language-neutral', async () => {
    const { ANTHROPIC_ANALYSIS_SYSTEM_PROMPT } = await import('../analysis.js');
    expect(ANTHROPIC_ANALYSIS_SYSTEM_PROMPT).not.toMatch(/grounded English/i);
  });
});

describe('AnthropicAnalysisGenerator', () => {
  it('separates system safety instructions from untrusted user/source data', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` }],
    }), { status: 200 }));
    const generator = new AnthropicAnalysisGenerator({ apiKey: 'test-key', model: 'fixture-model', baseUrl: 'https://compatible.example/anthropic/', fetch });
    await expect(generator.generate(input)).resolves.toEqual(analysis);
    expect(fetch.mock.calls[0][0]).toBe('https://compatible.example/anthropic/v1/messages');
    const request = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.system).toContain('untrusted data');
    expect(body.messages[0].content).not.toContain('Do not use outside knowledge');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects malformed output without exposing credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'not json' }] }), { status: 200 }));
    const generator = new AnthropicAnalysisGenerator({ apiKey: 'never-print-this', fetch });
    await expect(generator.generate(input)).rejects.toThrow('Invalid Anthropic analysis response');
    await expect(generator.generate(input)).rejects.not.toThrow('never-print-this');
  });

  it('never includes credentials from a network error in its exception', async () => {
    const credential = 'credential-inside-network-error';
    const fetch = vi.fn().mockRejectedValue(new Error(`transport failed for ${credential}`));
    const generator = new AnthropicAnalysisGenerator({ apiKey: credential, fetch });
    await expect(generator.generate(input)).rejects.toThrow('Anthropic analysis request failed');
    await expect(generator.generate(input)).rejects.not.toThrow(credential);
  });
});

describe('analysis fact gate and script', () => {
  it.each([
    ['Spanish', {
      executiveSummary: 'La categoría avanza hacia productos prácticos.',
      headline: 'Lanzamiento de gafas con IA',
      summary: 'Un lanzamiento verificado está dando forma al mercado.',
      trend: 'El hardware y la IA están convergiendo.',
      implication: 'Los equipos deben priorizar flujos de trabajo útiles.',
      recommendation: 'Prueba un flujo de trabajo específico.',
    }],
    ['French', {
      executiveSummary: 'La catégorie évolue vers des produits pratiques.',
      headline: 'Lancement de lunettes IA',
      summary: 'Un lancement vérifié façonne le marché.',
      trend: "Le matériel et l'IA convergent.",
      implication: 'Les équipes doivent privilégier les usages utiles.',
      recommendation: 'Testez un usage ciblé.',
    }],
  ])('keeps %s spoken segments exactly in model-generated prose without internal labels', (_language, prose) => {
    const localized = {
      ...analysis,
      executiveSummary: { ...analysis.executiveSummary, text: prose.executiveSummary },
      storyBriefs: [{ ...analysis.storyBriefs[0], headline: prose.headline, summary: prose.summary }],
      crossStoryTrends: [{ ...analysis.crossStoryTrends[0], text: prose.trend }],
      strategicImplications: [{ ...analysis.strategicImplications[0], text: prose.implication }],
      actionableRecommendations: [{ ...analysis.actionableRecommendations[0], text: prose.recommendation }],
    };
    const script = writeAnalysisBulletinScript(localized, stories, '2026-07-11T12:30:00.000Z');
    const spoken = script.segments.filter((segment) => segment.kind === 'factual').map((segment) => segment.text);
    expect(spoken).toEqual([
      prose.executiveSummary,
      `${prose.headline}. ${prose.summary}`,
      prose.trend,
      prose.implication,
      prose.recommendation,
    ]);
    expect(spoken.join(' ')).not.toMatch(/Executive summary|Story brief|Cross-story trend|Strategic implication|Actionable recommendation/);
  });

  it('approves claims with quotes found in verified original sources', () => {
    const gate = runAnalysisFactGate(analysis, stories, evidence, '2026-07-11T12:30:00.000Z');
    expect(gate.approved).toBe(true);
    const script = writeAnalysisBulletinScript(analysis, stories, '2026-07-11T12:30:00.000Z', gate.scriptStatus);
    expect(script.status).toBe('ready_for_voice');
    expect(script.segments.filter((segment) => segment.kind === 'factual').every((segment) => segment.citations.length > 0)).toBe(true);
  });

  it('blocks unknown source IDs and malformed missing citations', () => {
    const unknown = { ...analysis, crossStoryTrends: [{ text: 'Unsupported trend.', sourceStoryIds: ['unknown-story'], supportingQuotes: [{ storyId: 'unknown-story', quote: 'Unsupported trend.' }] }] };
    expect(runAnalysisFactGate(unknown, stories, evidence, '2026-07-11T12:30:00.000Z').approved).toBe(false);
    const missing = { ...analysis, actionableRecommendations: [{ text: 'Uncited.', sourceStoryIds: [], supportingQuotes: [] }] };
    expect(runAnalysisFactGate(missing, stories, evidence, '2026-07-11T12:30:00.000Z').approved).toBe(false);
  });

  it('blocks supporting quotes absent from the verified original', () => {
    const fabricated = { ...analysis, crossStoryTrends: [{ text: 'A fabricated claim.', sourceStoryIds: ['story-1'], supportingQuotes: supported('This quote does not exist in the article.') }] };
    const gate = runAnalysisFactGate(fabricated, stories, evidence, '2026-07-11T12:30:00.000Z');
    expect(gate.approved).toBe(false);
    expect(gate.reasons.join(' ')).toContain('supporting quote not found');
  });

  it('requires case-exact quotes from the same source slice sent to the model', () => {
    const changedCase = { ...analysis, crossStoryTrends: [{ ...analysis.crossStoryTrends[0], supportingQuotes: supported('hardware and AI are converging.') }] };
    expect(runAnalysisFactGate(changedCase, stories, evidence, '2026-07-11T12:30:00.000Z').approved).toBe(false);
    const distantText = 'Evidence beyond prompt boundary.';
    const longEvidence = [{ ...evidence[0], original: { ...evidence[0].original, markdown: `${'x'.repeat(14_000)}${distantText}` } }];
    const beyondPrompt = { ...analysis, crossStoryTrends: [{ text: distantText, sourceStoryIds: ['story-1'], supportingQuotes: supported(distantText) }] };
    expect(runAnalysisFactGate(beyondPrompt, stories, longEvidence, '2026-07-11T12:30:00.000Z').approved).toBe(false);
  });

  it('requires each story brief to cite its own story ID', () => {
    const mismatch = { ...analysis, storyBriefs: [{ ...analysis.storyBriefs[0], sourceStoryIds: ['other-story'], supportingQuotes: [{ storyId: 'other-story', quote: 'A sufficiently long unrelated quote.' }] }] };
    const gate = runAnalysisFactGate(mismatch, stories, evidence, '2026-07-11T12:30:00.000Z');
    expect(gate.approved).toBe(false);
    expect(gate.reasons.join(' ')).toContain('must cite its own story');
  });
});
