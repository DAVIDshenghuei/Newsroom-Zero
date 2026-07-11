import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBriefingGenerator } from '../bot.js';
import type { AnalysisGenerator } from '../analysis.js';

const preferences = { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const };
const searchResult = { name: 'A verified AI glasses launch', url: 'https://example.com/launch', content: 'A detailed launch report.', type: 'text' as const };

const validAnalysis = (storyId: string) => ({
  title: 'AI Glasses Strategy Briefing',
  executiveSummary: { text: 'A verified launch is shaping product strategy.', sourceStoryIds: [storyId] },
  storyBriefs: [{ storyId, headline: 'A verified AI glasses launch', summary: 'The launch introduces a practical product.', sourceStoryIds: [storyId] }],
  crossStoryTrends: [{ text: 'Products are focusing on practical use.', sourceStoryIds: [storyId] }],
  strategicImplications: [{ text: 'Teams should focus on repeatable value.', sourceStoryIds: [storyId] }],
  actionableRecommendations: [{ text: 'Test one focused workflow.', sourceStoryIds: [storyId] }],
});

const setup = async (analysisGenerator: AnalysisGenerator) => {
  const directory = await mkdtemp(join(tmpdir(), 'newsroom-generator-'));
  const search = vi.fn().mockResolvedValue([searchResult]);
  const fetch = vi.fn().mockResolvedValue('# Verified article\nA detailed launch report with practical product information.');
  const synthesize = vi.fn().mockResolvedValue(Buffer.from('realistic-mp3-fixture'));
  const publish = vi.fn().mockResolvedValue(1);
  const sendMessage = vi.fn().mockResolvedValue(1);
  const generate = createBriefingGenerator({
    linkup: { search, fetch }, analysisGenerator,
    synthesizer: { synthesize }, telegram: { publish, sendMessage },
    artifactsDirectory: join(directory, 'artifacts'), episodesDirectory: join(directory, 'episodes'),
    now: () => new Date('2026-07-11T12:00:00.000Z'),
  });
  return { generate, search, fetch, synthesize, publish, sendMessage };
};

describe('LLM personalized briefing generator', () => {
  it('calls grounded analysis after source fetch and publishes only after approval', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', preferences);
    expect(analysisGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({ preferences, stories: expect.any(Array), evidence: expect.any(Array) }));
    expect(harness.fetch.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]);
    expect(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]).toBeLessThan(harness.synthesize.mock.invocationCallOrder[0]);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ title: expect.stringContaining('Product Strategy') }),
    }));
  });

  it('never voices or publishes when the LLM fails', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
    const harness = await setup(analysisGenerator);
    await expect(harness.generate('42', preferences)).rejects.toThrow('provider unavailable');
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });
});
