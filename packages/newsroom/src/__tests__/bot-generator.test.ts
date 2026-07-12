import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBriefingGenerator } from '../bot.js';
import type { AnalysisGenerator } from '../analysis.js';
import { BOT_COPY } from '../bot-copy.js';

const audioPrefs = { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const, deliveryMode: 'text_and_audio' as const };
const textPrefs = { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const, deliveryMode: 'text_only' as const };
const searchResult = { name: 'A verified AI glasses launch', url: 'https://example.com/launch', content: 'A detailed launch report.', type: 'text' as const };

const validAnalysis = (storyId: string) => {
  const supportingQuotes = [{ storyId, quote: 'A detailed launch report with practical product information.' }];
  return {
    title: 'AI Glasses Strategy Briefing',
    executiveSummary: { text: 'A verified launch is shaping product strategy.', sourceStoryIds: [storyId], supportingQuotes },
    storyBriefs: [{ storyId, headline: 'A verified AI glasses launch', summary: 'The launch introduces a practical product.', sourceStoryIds: [storyId], supportingQuotes }],
    crossStoryTrends: [{ text: 'Products are focusing on practical use.', sourceStoryIds: [storyId], supportingQuotes }],
    strategicImplications: [{ text: 'Teams should focus on repeatable value.', sourceStoryIds: [storyId], supportingQuotes }],
    actionableRecommendations: [{ text: 'Test one focused workflow.', sourceStoryIds: [storyId], supportingQuotes }],
  };
};

const setup = async (analysisGenerator: AnalysisGenerator, ttsFails = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'newsroom-generator-'));
  const search = vi.fn().mockResolvedValue([searchResult]);
  const fetch = vi.fn().mockResolvedValue('# Verified article\nA detailed launch report with practical product information.');
  const synthesize = ttsFails
    ? vi.fn().mockRejectedValue(new Error('all providers unavailable'))
    : vi.fn().mockResolvedValue(Buffer.from('realistic-mp3-fixture'));
  const publish = vi.fn().mockResolvedValue(1);
  const sendMessage = vi.fn().mockResolvedValue(1);
  const generate = createBriefingGenerator({
    linkup: { search, fetch }, analysisGenerator,
    synthesizer: { synthesize }, telegram: { publish, sendMessage },
    artifactsDirectory: join(directory, 'artifacts'), episodesDirectory: join(directory, 'episodes'),
    now: () => new Date('2026-07-11T12:00:00.000Z'),
  });
  return { generate, directory, search, fetch, synthesize, publish, sendMessage };
};

describe('LLM personalized briefing generator', () => {
  it('calls grounded analysis after source fetch and publishes audio for text_and_audio mode', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', audioPrefs);
    expect(analysisGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({ preferences: audioPrefs, stories: expect.any(Array), evidence: expect.any(Array) }));
    expect(harness.fetch.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]);
    expect(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]).toBeLessThan(harness.synthesize.mock.invocationCallOrder[0]);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ title: expect.stringContaining('Product Strategy') }),
    }));
    expect(harness.sendMessage).toHaveBeenLastCalledWith('42', BOT_COPY.generationComplete);
  });

  it('never voices or publishes when the LLM fails', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
    const harness = await setup(analysisGenerator);
    await expect(harness.generate('42', audioPrefs)).rejects.toThrow('provider unavailable');
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('publishes text only and skips TTS for text_only delivery mode', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', textPrefs);
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith('42', expect.stringContaining('Glasses'));
    expect(harness.sendMessage).toHaveBeenLastCalledWith('42', BOT_COPY.generationComplete);
  });

  it('degrades to text when all configured TTS providers fail', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator, true);
    await harness.generate('42', audioPrefs);
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalledWith('42', expect.stringContaining(BOT_COPY.audioUnavailable));
    expect(harness.sendMessage).toHaveBeenLastCalledWith('42', BOT_COPY.generationComplete);
    const outcome = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'audio-outcome.json'), 'utf8'));
    expect(outcome).toEqual({ audioRequested: true, audioGenerated: false, provider: null, fallbackUsed: false });
  });

  it('includes correct episode audio outcome in artifacts for text_only mode', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', textPrefs);
    const episode = JSON.parse(await readFile(join(harness.directory, 'episodes', 'latest.json'), 'utf8'));
    expect(episode.audioRequested).toBe(false);
    expect(episode.audioGenerated).toBe(false);
    expect(episode.audioUrl).toBeUndefined();
  });
});
