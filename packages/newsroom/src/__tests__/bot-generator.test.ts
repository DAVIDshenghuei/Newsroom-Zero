import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBriefingGenerator } from '../bot.js';
import type { AnalysisGenerator } from '../analysis.js';
import { BOT_COPY } from '../bot-copy.js';

const audioPrefs = { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const, outputLanguage: 'french' as const, deliveryMode: 'text_and_audio' as const };
const textPrefs = { topics: 'AI Glasses', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days' as const, outputLanguage: 'french' as const, deliveryMode: 'text_only' as const };
const searchResult = { name: 'A verified AI Glasses feature launch', url: 'https://meta.com/launch', content: 'A detailed product feature report.', type: 'text' as const };

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

const setup = async (analysisGenerator: AnalysisGenerator, ttsFails = false, voiceId?: string, withOutcome = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'newsroom-generator-'));
  const search = vi.fn().mockResolvedValue([searchResult]);
  const fetch = vi.fn().mockResolvedValue('Published July 10, 2026\n# Verified article\nA detailed launch report with practical product information.');
  const fetchDocument = vi.fn().mockResolvedValue({
    markdown: '# Verified AI Glasses product feature article\nA detailed launch report with practical product information.',
    rawHtml: '<meta property="article:published_time" content="2026-07-10T09:30:00Z">',
  });
  const synthesize = ttsFails
    ? vi.fn().mockRejectedValue(new Error('all providers unavailable'))
    : vi.fn().mockResolvedValue(Buffer.from('realistic-mp3-fixture'));
  const publish = vi.fn().mockResolvedValue(1);
  const sendMessage = vi.fn().mockResolvedValue(1);
  const synthesizeWithOutcome = ttsFails
    ? vi.fn().mockRejectedValue(new Error('all providers unavailable'))
    : vi.fn().mockResolvedValue({ audio: Buffer.from('realistic-mp3-fixture'), provider: 'kokoro', fallbackUsed: false });
  const synthesizer = withOutcome ? { synthesize, synthesizeWithOutcome } : { synthesize };
  const generate = createBriefingGenerator({
    linkup: { search, fetch, fetchDocument }, analysisGenerator,
    synthesizer, telegram: { publish, sendMessage },
    artifactsDirectory: join(directory, 'artifacts'), episodesDirectory: join(directory, 'episodes'),
    voiceId,
    now: () => new Date('2026-07-11T12:00:00.000Z'),
  });
  return { generate, directory, search, fetch, fetchDocument, synthesize, synthesizeWithOutcome, publish, sendMessage };
};

const seedEpisodeSentinels = async (directory: string) => {
  const episodes = join(directory, 'episodes');
  const metadata = Buffer.from('sentinel metadata\n');
  const audio = Buffer.from([0x00, 0xff, 0x49, 0x44, 0x33]);
  await mkdir(episodes, { recursive: true });
  await Promise.all([writeFile(join(episodes, 'latest.json'), metadata), writeFile(join(episodes, 'latest.mp3'), audio)]);
  return { metadata, audio };
};

const expectEpisodeSentinels = async (directory: string, sentinels: { metadata: Buffer; audio: Buffer }) => {
  expect(await readFile(join(directory, 'episodes', 'latest.json'))).toEqual(sentinels.metadata);
  expect(await readFile(join(directory, 'episodes', 'latest.mp3'))).toEqual(sentinels.audio);
};

describe('LLM personalized briefing generator', () => {
  it('shadow-writes stage observations and stays nonblocking with a fixed safe warning', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ledger = {
      startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'),
      observe: vi.fn(() => { throw new Error('database path and secret'); }),
      finalizeRun: vi.fn(),
    };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts-ledger'), episodesDirectory: join(harness.directory, 'episodes-ledger'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('private-chat-id', textPrefs)).resolves.toBeUndefined();
    expect(ledger.startRun).toHaveBeenCalledWith({ windowHours: 72 });
    expect(JSON.stringify(ledger.startRun.mock.calls)).not.toContain('ai-glasses');
    expect(JSON.stringify(ledger.startRun.mock.calls)).not.toContain('product-strategy');
    expect(JSON.stringify(ledger.startRun.mock.calls)).not.toContain('private-chat-id');
    expect(ledger.finalizeRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
    expect(warning).toHaveBeenCalledWith('[RunLedger] WRITE_FAILED');
    expect(warning.mock.calls.flat().join(' ')).not.toContain('secret');
    warning.mockRestore();
  });

  it('persists normalized ranking explanation for selected stories without changing output', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    const ledger = {
      startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'),
      observe: vi.fn(), finalizeRun: vi.fn(),
    };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts-ranking-ledger'),
      episodesDirectory: join(harness.directory, 'episodes-ranking-ledger'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('42', textPrefs)).resolves.toBeUndefined();
    expect(ledger.observe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stage: 'ranking', reasonCode: 'RANK_SELECTED',
      ranking: expect.objectContaining({
        sourceAuthority: expect.any(Number), policyRelevance: expect.any(Number),
        recency: expect.any(Number), bodyCompleteness: expect.any(Number),
        explanationCodes: expect.any(Array),
      }),
    }));
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.sendMessage).toHaveBeenCalled();
  });

  it('records a Fact Gate block with fixed codes and does not voice or publish', async () => {
    const analysisGenerator: AnalysisGenerator = {
      generate: vi.fn(async ({ stories }) => {
        const analysis = validAnalysis(stories[0].id);
        return {
          ...analysis,
          executiveSummary: {
            ...analysis.executiveSummary,
            supportingQuotes: [{ storyId: stories[0].id, quote: 'This quotation is not in the public source.' }],
          },
        };
      }),
    };
    const harness = await setup(analysisGenerator);
    const ledger = { startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'), observe: vi.fn(), finalizeRun: vi.fn() };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts-gate'), episodesDirectory: join(harness.directory, 'episodes-gate'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('42', audioPrefs)).rejects.toThrow('Fact Gate blocked');
    expect(ledger.observe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stage: 'fact_gate', outcome: 'blocked', reasonCode: 'FACT_GATE_BLOCKED',
    }));
    expect(ledger.finalizeRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', reasonCode: 'FACT_GATE_BLOCKED',
    }));
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('observes every policy-eligible ranking candidate without changing the selected top three', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn().mockRejectedValue(new Error('stop after ranking')) };
    const harness = await setup(analysisGenerator);
    harness.search.mockResolvedValue(Array.from({ length: 4 }, (_, index) => ({
      ...searchResult, name: `AI Glasses verified feature ${index}`, url: `https://meta.com/story-${index}`,
    })));
    harness.fetchDocument.mockResolvedValue({
      markdown: 'AI Glasses product strategy feature with practical product information.',
      rawHtml: '<meta property="article:published_time" content="2026-07-10T09:30:00Z">',
    });
    const ledger = { startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'), observe: vi.fn(), finalizeRun: vi.fn() };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts-ranking'), episodesDirectory: join(harness.directory, 'episodes-ranking'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('42', textPrefs)).rejects.toThrow('stop after ranking');
    const rankingCalls = ledger.observe.mock.calls.map(([, value]) => value).filter(({ stage }) => stage === 'ranking');
    expect(rankingCalls).toHaveLength(4);
    expect(rankingCalls.filter(({ reasonCode }) => reasonCode === 'RANK_SELECTED')).toHaveLength(3);
    expect(rankingCalls.filter(({ reasonCode }) => reasonCode === 'RANK_NOT_SELECTED')).toHaveLength(1);
  });
  it('rejects disallowed domains before fetch and writes safe policy diagnostics', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn() };
    const harness = await setup(analysisGenerator);
    const sentinels = await seedEpisodeSentinels(harness.directory);
    harness.search.mockResolvedValue([{ ...searchResult, url: 'https://evil-meta.com/story' }]);
    const ledger = { startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'), observe: vi.fn(), finalizeRun: vi.fn() };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts'), episodesDirectory: join(harness.directory, 'episodes'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('42', textPrefs)).rejects.toThrow('No stories matched');
    expect(ledger.observe.mock.calls.filter(([, value]) => value.stage === 'source' && value.outcome === 'rejected')).toHaveLength(1);
    expect(ledger.observe.mock.calls.filter(([, value]) => value.stage === 'policy')).toHaveLength(0);
    expect(harness.fetchDocument).not.toHaveBeenCalled();
    expect(analysisGenerator.generate).not.toHaveBeenCalled();
    const policy = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'search-policy.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'search-policy-filter-report.json'), 'utf8'));
    expect(policy.topicId).toBe('ai-glasses');
    expect(report.rejected[0].reasons).toContain('source domain not allowed');
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    await expectEpisodeSentinels(harness.directory, sentinels);
  });

  it.each([
    ['unrelated', 'Published July 10, 2026\nA gardening article about tomato irrigation.'],
    ['excluded', 'Published July 10, 2026\nAI Glasses startup coverage involving politics.'],
  ])('rejects Linkup title and snippet matches when fetched original content is %s', async (_label, markdown) => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn() };
    const harness = await setup(analysisGenerator);
    const sentinels = await seedEpisodeSentinels(harness.directory);
    harness.fetchDocument.mockResolvedValue({
      markdown,
      rawHtml: '<meta property="article:published_time" content="2026-07-10T09:30:00Z">',
    });
    const preferences = _label === 'excluded'
      ? { ...audioPrefs, analysisAngles: 'Startup Opportunities' }
      : audioPrefs;
    await expect(harness.generate('42', preferences)).rejects.toThrow('No stories matched');
    expect(analysisGenerator.generate).not.toHaveBeenCalled();
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    await expectEpisodeSentinels(harness.directory, sentinels);
  });

  it('records formatting-only original markdown as a failed fetch', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn() };
    const harness = await setup(analysisGenerator);
    harness.fetchDocument.mockResolvedValue({ markdown: ' \n\t ', rawHtml: '<meta property="article:published_time" content="2026-07-10T09:30:00Z">' });
    const ledger = { startRun: vi.fn(() => 'run_00000000-0000-4000-8000-000000000000'), observe: vi.fn(), finalizeRun: vi.fn() };
    const generate = createBriefingGenerator({
      linkup: { search: harness.search, fetch: harness.fetch, fetchDocument: harness.fetchDocument },
      analysisGenerator, synthesizer: { synthesize: harness.synthesize },
      telegram: { publish: harness.publish, sendMessage: harness.sendMessage }, ledger,
      artifactsDirectory: join(harness.directory, 'artifacts-empty-original'), episodesDirectory: join(harness.directory, 'episodes-empty-original'),
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    await expect(generate('42', textPrefs)).rejects.toThrow('No stories matched');
    expect(ledger.observe).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      stage: 'original', outcome: 'rejected', reasonCode: 'ORIGINAL_FETCH_FAILED',
    }));
    expect(analysisGenerator.generate).not.toHaveBeenCalled();
  });

  it('passes the exact window to search and reuses the pre-ranking original fetch', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', textPrefs);
    expect(harness.search).toHaveBeenNthCalledWith(1, expect.any(String), {
      from: '2026-07-08T12:00:00.000Z', to: '2026-07-11T12:00:00.000Z',
      includeDomains: ['meta.com', 'google.com', 'snap.com', 'xreal.com', 'brilliant.xyz', 'viture.com', 'rayneo.com', 'uploadvr.com', 'roadtovr.com', 'apple.com', 'qualcomm.com', 'magicleap.com', 'rokid.com', 'evenrealities.com', 'vuzix.com', 'realwear.com', 'solosglasses.com', 'mentraglass.com', 'letsenvision.com', 'xrai.glass', 'lumus.com', 'diglens.com', 'mixed-news.com', 'xrtoday.com', 'theverge.com', 'androidcentral.com'],
      excludeDomains: [],
    });
    expect(harness.search.mock.calls[0]?.[0]).not.toContain('site:');
    expect(harness.fetchDocument).toHaveBeenCalledTimes(1);
    expect(harness.fetch).not.toHaveBeenCalled();
    const rundown = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'rundown.json'), 'utf8'));
    expect(rundown.stories[0].publishedAt).toBe('2026-07-10T09:30:00.000Z');
  });

  it.each([
    ['old', 'Published Jan 16, 2026'],
    ['unknown', '# Article without a publication date'],
    ['future', 'Published July 12, 2026'],
  ])('rejects %s originals before analysis, audio, or episode writes', async (_label, markdown) => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn() };
    const harness = await setup(analysisGenerator);
    const sentinels = await seedEpisodeSentinels(harness.directory);
    harness.fetchDocument.mockResolvedValue({ markdown });
    await expect(harness.generate('42', textPrefs)).rejects.toThrow('No stories were published within Past 3 Days');
    expect(analysisGenerator.generate).not.toHaveBeenCalled();
    expect(harness.synthesize).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    await expectEpisodeSentinels(harness.directory, sentinels);
    const report = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'publication-filter-report.json'), 'utf8'));
    expect(report.eligible).toEqual([]);
    expect(report.rejected).toHaveLength(1);
  });

  it('continues with one or two eligible stories without backfilling rejected results', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    harness.search.mockResolvedValue([
      searchResult,
      { ...searchResult, name: 'Second current AI Glasses feature story', url: 'https://meta.com/current-two' },
      { ...searchResult, name: 'Old AI Glasses feature story', url: 'https://meta.com/old' },
    ]);
    harness.fetchDocument
      .mockResolvedValueOnce({ markdown: 'Published July 10, 2026\nA detailed launch report with practical product information. AI Glasses product feature.' })
      .mockResolvedValueOnce({ markdown: 'Published July 9, 2026\nA detailed launch report with practical product information. AI Glasses product feature.' })
      .mockResolvedValueOnce({ markdown: 'Published June 2, 2026\nOld' });
    await harness.generate('42', textPrefs);
    const rundown = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'rundown.json'), 'utf8'));
    expect(rundown.stories).toHaveLength(2);
    expect(rundown.stories.map((item: { headline: string }) => item.headline)).not.toContain('Old story');
  });

  it('rejects Updated-only markdown when raw HTML has no publication metadata', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn() };
    const harness = await setup(analysisGenerator);
    harness.fetchDocument.mockResolvedValue({ markdown: 'Updated July 10, 2026', rawHtml: '<html><body>Article</body></html>' });
    await expect(harness.generate('42', textPrefs)).rejects.toThrow('No stories were published within Past 3 Days');
    expect(analysisGenerator.generate).not.toHaveBeenCalled();
  });

  it('calls grounded analysis after source fetch and publishes audio for text_and_audio mode', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', audioPrefs);
    expect(analysisGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({ preferences: audioPrefs, stories: expect.any(Array), evidence: expect.any(Array) }));
    expect(harness.fetchDocument.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]);
    expect(vi.mocked(analysisGenerator.generate).mock.invocationCallOrder[0]).toBeLessThan(harness.synthesize.mock.invocationCallOrder[0]);
    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ title: 'AI Glasses Strategy Briefing', outputLanguage: 'french' }),
    }));
    expect(harness.synthesize).toHaveBeenCalledWith('SAz9YHcvj6GT2YYXdXww', expect.any(String), { language: 'french_24l' });
    const outcome = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'audio-outcome.json'), 'utf8'));
    expect(outcome.outputLanguage).toBe('french');
    expect(harness.sendMessage).toHaveBeenLastCalledWith('42', BOT_COPY.generationComplete);
  });

  it('uses exactly the model-generated selected-language title for episode metadata', async () => {
    const modelTitle = 'Bulletin stratégique sur les lunettes IA';
    const analysisGenerator: AnalysisGenerator = {
      generate: vi.fn(async ({ stories }) => ({ ...validAnalysis(stories[0].id), title: modelTitle })),
    };
    const harness = await setup(analysisGenerator);
    await harness.generate('42', audioPrefs);
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ title: modelTitle }),
    }));
  });

  it('uses the configured ElevenLabs voice for a Spanish request with a plain synthesizer', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator, false, 'configured-elevenlabs-voice');
    await harness.generate('42', { ...audioPrefs, outputLanguage: 'spanish' });
    expect(harness.synthesize).toHaveBeenCalledWith(
      'configured-elevenlabs-voice',
      expect.any(String),
      { language: 'spanish_24l' },
    );
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ provider: 'elevenlabs', outputLanguage: 'spanish' }),
    }));
  });

  it('routes Traditional Chinese audio through Kokoro and records its provider metadata', async () => {
    const analysisGenerator: AnalysisGenerator = { generate: vi.fn(async ({ stories }) => validAnalysis(stories[0].id)) };
    const harness = await setup(analysisGenerator, false, undefined, true);
    await harness.generate('42', { ...audioPrefs, outputLanguage: 'traditional_chinese' });
    expect(harness.synthesizeWithOutcome).toHaveBeenCalledWith(expect.any(String), {
      language: 'chinese_traditional', voiceId: 'zf_xiaoxiao', provider: 'kokoro',
    });
    expect(harness.publish).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ provider: 'kokoro', outputLanguage: 'traditional_chinese' }),
    }));
    const outcome = JSON.parse(await readFile(join(harness.directory, 'artifacts', 'audio-outcome.json'), 'utf8'));
    expect(outcome).toMatchObject({
      audioRequested: true, audioGenerated: true, provider: 'kokoro', fallbackUsed: false,
      outputLanguage: 'traditional_chinese',
    });
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
    expect(outcome).toEqual({ audioRequested: true, audioGenerated: false, provider: null, fallbackUsed: false, outputLanguage: 'french' });
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
