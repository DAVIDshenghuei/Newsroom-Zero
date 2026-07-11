import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { prepareEdition, StoryCandidateSchema } from './index.js';
import { ingestFeeds } from './feeds.js';
import { HttpFeedFetcher } from './http-fetcher.js';

const FeedSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
});

async function main(): Promise<void> {
  const root = process.cwd();
  const configPath = resolve(root, 'config/feeds.json');
  const outputDirectory = resolve(root, 'artifacts');
  const sources = z.array(FeedSourceSchema).min(1).parse(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  const candidates = await ingestFeeds(sources, new HttpFeedFetcher());
  const validated = z.array(StoryCandidateSchema).parse(candidates);
  const prepared = prepareEdition(validated, new Date().toISOString());

  await mkdir(outputDirectory, { recursive: true });
  const artifacts: Record<string, unknown> = {
    'story-candidates.json': validated,
    'rundown.json': prepared.rundown,
    'script.json': prepared.script,
    'fact-gate.json': prepared.factGate,
    'edition.json': prepared.edition,
  };
  for (const [filename, value] of Object.entries(artifacts)) {
    await writeFile(resolve(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  console.log(`Prepared ${prepared.rundown.stories.length} of ${validated.length} story candidates in ${outputDirectory}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
