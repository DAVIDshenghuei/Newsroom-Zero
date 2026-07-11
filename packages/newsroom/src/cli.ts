import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  BulletinScriptSchema,
  EditionArtifactSchema,
  LinkupClient,
  StoryCandidateSchema,
  gatherLinkupSearchEvidence,
  rankStories,
  runResearchFactGate,
  verifyLinkupOriginals,
  writeBulletinScript,
} from './index.js';
import { ingestFeeds } from './feeds.js';
import { HttpFeedFetcher } from './http-fetcher.js';

const FeedSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
});

async function main(): Promise<void> {
  const root = process.cwd();
  const apiKey = process.env.LINKUP_API_KEY;
  if (!apiKey) throw new Error('LINKUP_API_KEY is required');
  const configPath = resolve(root, 'config/feeds.json');
  const outputDirectory = resolve(root, 'artifacts');
  const sources = z.array(FeedSourceSchema).min(1).parse(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  console.log(`RSS: ingesting ${sources.length} feeds`);
  const candidates = await ingestFeeds(sources, new HttpFeedFetcher());
  const validated = z.array(StoryCandidateSchema).parse(candidates);
  const createdAt = new Date().toISOString();
  const stories = rankStories(validated);
  console.log(`Ranking: selected ${stories.length} of ${validated.length} candidates`);
  const rundown = { id: `rundown-${createdAt}`, createdAt, stories };
  const linkup = new LinkupClient({ apiKey });
  console.log(`Linkup search: enriching ${stories.length} stories`);
  const searchedEvidence = await gatherLinkupSearchEvidence(stories, linkup);
  const draft = writeBulletinScript(stories, createdAt);
  console.log(`Linkup fetch: verifying ${stories.length} original sources`);
  const evidence = await verifyLinkupOriginals(searchedEvidence, linkup);
  const factGate = runResearchFactGate(draft, stories, evidence, createdAt);
  const script = BulletinScriptSchema.parse({ ...draft, status: factGate.scriptStatus });
  const edition = EditionArtifactSchema.parse({
    id: `edition-${createdAt}`,
    createdAt,
    status: factGate.scriptStatus,
    rundownId: rundown.id,
    scriptId: script.id,
    factGateId: factGate.id,
    storyIds: stories.map(({ id }) => id),
  });

  await mkdir(outputDirectory, { recursive: true });
  const artifacts: Record<string, unknown> = {
    'story-candidates.json': validated,
    'rundown.json': rundown,
    'linkup-evidence.json': evidence,
    'script.json': script,
    'fact-gate.json': factGate,
    'edition.json': edition,
  };
  for (const [filename, value] of Object.entries(artifacts)) {
    await writeFile(resolve(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  console.log(`Prepared ${stories.length} of ${validated.length} story candidates in ${outputDirectory}; Fact Gate ${factGate.approved ? 'approved' : 'blocked'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
