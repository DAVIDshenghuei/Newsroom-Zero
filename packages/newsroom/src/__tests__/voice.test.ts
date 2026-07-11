import { describe, expect, it, vi } from 'vitest';
import {
  EditionArtifactSchema,
  type BulletinScript,
  type EditionArtifact,
  type FactGateDecision,
  type RankedStory,
} from '../index.js';
import { createVoiceEpisode, type VoiceSynthesizer } from '../voice.js';

const generatedAt = '2026-07-11T15:00:00.000Z';
const script: BulletinScript = {
  id: 'script-1',
  createdAt: generatedAt,
  status: 'ready_for_voice',
  segments: [
    { id: 'one', kind: 'factual', text: '  First   headline. ', citations: [] },
    { id: 'two', kind: 'transition', text: ' Next, the second story. ', citations: [] },
  ],
};
const factGate: FactGateDecision = {
  id: 'gate-1', checkedAt: generatedAt, approved: true,
  scriptStatus: 'ready_for_voice', reasons: [],
};
const story = {
  id: 'story-1', source: 'Wire', headline: 'First headline', body: 'Body',
  url: 'https://news.test/one', canonicalUrl: 'https://news.test/one',
  headlineFingerprint: 'first headline', rank: 1,
  ranking: { recency: 1, bodyCompleteness: 4 }, fetchedAt: generatedAt, status: 'selected',
} satisfies RankedStory;
const edition: EditionArtifact = {
  id: 'edition-1', createdAt: generatedAt, status: 'ready_for_voice',
  rundownId: 'rundown-1', scriptId: script.id, factGateId: factGate.id, storyIds: [story.id],
};

describe('createVoiceEpisode', () => {
  it.each<[string, BulletinScript, FactGateDecision]>([
    ['script is not ready', { ...script, status: 'draft' as const }, factGate],
    ['Fact Gate is not approved', script, { ...factGate, approved: false }],
  ])('refuses when %s before calling ElevenLabs', async (_label, unsafeScript, unsafeGate) => {
    const synthesizer = { synthesize: vi.fn() } satisfies VoiceSynthesizer;
    await expect(createVoiceEpisode({
      script: unsafeScript, factGate: unsafeGate, rundown: { stories: [story] },
      edition, synthesizer, voiceId: 'voice', generatedAt,
    })).rejects.toThrow('Voice generation refused');
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('builds a bulletin and returns public metadata plus a voiced edition', async () => {
    const synthesizer = {
      synthesize: vi.fn().mockResolvedValue(new Uint8Array([0x49, 0x44, 0x33])),
    } satisfies VoiceSynthesizer;
    const output = await createVoiceEpisode({
      script, factGate, rundown: { stories: [story] }, edition,
      synthesizer, voiceId: 'voice', generatedAt,
    });
    expect(synthesizer.synthesize).toHaveBeenCalledWith(
      'voice', 'First headline.\n\nNext, the second story.',
    );
    expect(output.episode).toMatchObject({
      audioUrl: '/episodes/latest.mp3',
      stories: [{ headline: 'First headline', source: 'Wire', url: 'https://news.test/one' }],
      factGate: { approved: true },
    });
    expect(EditionArtifactSchema.parse(output.edition).status).toBe('voiced');
  });
});
