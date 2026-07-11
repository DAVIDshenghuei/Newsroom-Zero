import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  BulletinScriptSchema,
  EditionArtifactSchema,
  FactGateDecisionSchema,
  RankedStorySchema,
} from './pipeline.js';
import { ElevenLabsClient } from './elevenlabs.js';
import { assertVoiceEligible, createVoiceEpisode } from './voice.js';

const DEFAULT_VOICE_ID = 'SAz9YHcvj6GT2YYXdXww';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main(): Promise<void> {
  const root = process.cwd();
  const artifacts = resolve(root, 'artifacts');
  const publicEpisodes = resolve(root, 'apps/web/public/episodes');
  const [scriptValue, factGateValue, rundownValue, editionValue] = await Promise.all([
    readJson(resolve(artifacts, 'script.json')),
    readJson(resolve(artifacts, 'fact-gate.json')),
    readJson(resolve(artifacts, 'rundown.json')),
    readJson(resolve(artifacts, 'edition.json')),
  ]);
  const script = BulletinScriptSchema.parse(scriptValue);
  const factGate = FactGateDecisionSchema.parse(factGateValue);
  const rundown = z.object({ stories: RankedStorySchema.array() }).passthrough().parse(rundownValue);
  const edition = EditionArtifactSchema.parse(editionValue);
  assertVoiceEligible(script, factGate);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required');

  const output = await createVoiceEpisode({
    script,
    factGate,
    rundown,
    edition,
    synthesizer: new ElevenLabsClient({ apiKey }),
    voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
    generatedAt: new Date().toISOString(),
  });
  await mkdir(publicEpisodes, { recursive: true });
  await Promise.all([
    writeFile(resolve(publicEpisodes, 'latest.mp3'), output.audio),
    writeFile(resolve(publicEpisodes, 'latest.json'), `${JSON.stringify(output.episode, null, 2)}\n`, 'utf8'),
    writeFile(resolve(artifacts, 'edition.json'), `${JSON.stringify(output.edition, null, 2)}\n`, 'utf8'),
  ]);
  console.log(`Voiced ${output.episode.stories.length} stories to ${output.episode.audioUrl}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
