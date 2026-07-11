import { z } from 'zod';
import {
  BulletinScriptSchema,
  EditionArtifactSchema,
  FactGateDecisionSchema,
  RankedStorySchema,
  type BulletinScript,
  type EditionArtifact,
  type FactGateDecision,
  type RankedStory,
} from './pipeline.js';

export const EpisodeMetadataSchema = z.object({
  title: z.string().min(1),
  generatedAt: z.string().datetime(),
  audioUrl: z.string().min(1),
  stories: z.array(z.object({
    headline: z.string().min(1),
    source: z.string().min(1),
    url: z.string().url(),
  })),
  factGate: FactGateDecisionSchema,
});
export type EpisodeMetadata = z.infer<typeof EpisodeMetadataSchema>;

export interface VoiceSynthesizer {
  synthesize(voiceId: string, text: string): Promise<Uint8Array>;
}

export interface VoiceEpisodeInput {
  script: BulletinScript;
  factGate: FactGateDecision;
  rundown: { stories: RankedStory[] };
  edition: EditionArtifact;
  synthesizer: VoiceSynthesizer;
  voiceId: string;
  generatedAt: string;
}

const concise = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function assertVoiceEligible(script: BulletinScript, factGate: FactGateDecision): void {
  if (script.status !== 'ready_for_voice' || factGate.approved !== true) {
    throw new Error('Voice generation refused: script must be ready_for_voice and Fact Gate must be approved');
  }
}

export async function createVoiceEpisode(input: VoiceEpisodeInput): Promise<{
  audio: Uint8Array;
  episode: EpisodeMetadata;
  edition: EditionArtifact;
}> {
  const script = BulletinScriptSchema.parse(input.script);
  const factGate = FactGateDecisionSchema.parse(input.factGate);
  const stories = RankedStorySchema.array().parse(input.rundown.stories);
  const edition = EditionArtifactSchema.parse(input.edition);
  assertVoiceEligible(script, factGate);

  const bulletin = script.segments.map(({ text }) => concise(text)).filter(Boolean).join('\n\n');
  const audio = await input.synthesizer.synthesize(input.voiceId, bulletin);
  const episode = EpisodeMetadataSchema.parse({
    title: `Newsroom Zero — ${input.generatedAt.slice(0, 10)}`,
    generatedAt: input.generatedAt,
    audioUrl: '/episodes/latest.mp3',
    stories: stories.map(({ headline, source, canonicalUrl }) => ({
      headline, source, url: canonicalUrl,
    })),
    factGate,
  });
  return {
    audio,
    episode,
    edition: EditionArtifactSchema.parse({ ...edition, status: 'voiced' }),
  };
}
