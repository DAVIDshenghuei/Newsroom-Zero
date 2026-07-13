import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EpisodeMetadataSchema, type EpisodeMetadata } from '@ai-newsroom-studio/newsroom';

export async function loadLatestEpisode(
  metadataPath = resolve(process.cwd(), 'public/episodes/latest.json'),
): Promise<EpisodeMetadata | null> {
  try {
    return EpisodeMetadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
  } catch {
    return null;
  }
}
