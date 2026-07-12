import { z } from 'zod';
import type { StoryCandidate } from './index.js';
import type { LinkupEvidence, PublicationWindow } from './linkup.js';

const PipelineStoryCandidateSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  headline: z.string().min(1),
  body: z.string().min(1),
  url: z.string().url().optional(),
  sourceUrl: z.string().url().optional(),
  publishedAt: z.string().datetime().optional(),
  author: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  fetchedAt: z.string().datetime(),
  status: z.enum(['pending', 'selected', 'rejected']),
});

export const RankedStorySchema = PipelineStoryCandidateSchema.extend({
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  headlineFingerprint: z.string().min(1),
  rank: z.number().int().positive(),
  ranking: z.object({
    recency: z.number().finite(),
    bodyCompleteness: z.number().int().nonnegative(),
  }),
});
export type RankedStory = z.infer<typeof RankedStorySchema>;

export const CitationSchema = z.object({
  storyId: z.string().min(1),
  url: z.string().url(),
  text: z.string().min(1),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ScriptSegmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['factual', 'transition']),
  text: z.string().min(1),
  citations: z.array(CitationSchema),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const BulletinScriptSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(['draft', 'ready_for_voice', 'blocked']),
  segments: z.array(ScriptSegmentSchema),
});
export type BulletinScript = z.infer<typeof BulletinScriptSchema>;

export const FactGateDecisionSchema = z.object({
  id: z.string().min(1),
  checkedAt: z.string().datetime(),
  approved: z.boolean(),
  scriptStatus: z.enum(['ready_for_voice', 'blocked']),
  reasons: z.array(z.string()),
});
export type FactGateDecision = z.infer<typeof FactGateDecisionSchema>;

export const EditionArtifactSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(['ready_for_voice', 'blocked', 'voiced']),
  rundownId: z.string().min(1),
  scriptId: z.string().min(1),
  factGateId: z.string().min(1),
  storyIds: z.array(z.string().min(1)).max(3),
});
export type EditionArtifact = z.infer<typeof EditionArtifactSchema>;

const trackingParameter = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !trackingParameter.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareText(leftKey, rightKey) || compareText(leftValue, rightValue));
  url.search = '';
  for (const [key, item] of entries) url.searchParams.append(key, item);
  return url.toString();
}

export function normalizedHeadlineFingerprint(headline: string): string {
  return headline.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function recency(story: StoryCandidate): number {
  return story.publishedAt ? Date.parse(story.publishedAt) : 0;
}

export interface PublicationFilterReport {
  window: PublicationWindow;
  eligible: StoryCandidate[];
  rejected: Array<{ id: string; url?: string; publishedAt?: string; reason: 'missing publishedAt' | 'outside publication window' | 'future publishedAt' }>;
}

export function filterCandidatesByPublicationWindow(
  candidates: StoryCandidate[], window: PublicationWindow,
): PublicationFilterReport {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const eligible: StoryCandidate[] = [];
  const rejected: PublicationFilterReport['rejected'] = [];
  for (const candidate of candidates) {
    const published = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN;
    if (!Number.isFinite(published)) {
      rejected.push({ id: candidate.id, url: candidate.url, reason: 'missing publishedAt' });
    } else if (published > to) {
      rejected.push({ id: candidate.id, url: candidate.url, publishedAt: candidate.publishedAt, reason: 'future publishedAt' });
    } else if (published < from) {
      rejected.push({ id: candidate.id, url: candidate.url, publishedAt: candidate.publishedAt, reason: 'outside publication window' });
    } else {
      eligible.push(candidate);
    }
  }
  return { window, eligible, rejected };
}

function compareStories(left: StoryCandidate, right: StoryCandidate): number {
  return recency(right) - recency(left)
    || right.body.trim().length - left.body.trim().length
    || compareText(left.id, right.id);
}

export function rankStories(candidates: StoryCandidate[]): RankedStory[] {
  const valid = PipelineStoryCandidateSchema.array().parse(candidates);
  const seenUrls = new Set<string>();
  const urlUnique: Array<StoryCandidate & { url: string }> = [];

  for (const candidate of [...valid].sort((left, right) => compareText(left.id, right.id))) {
    if (!candidate.url) continue;
    const canonicalUrl = canonicalizeUrl(candidate.url);
    if (seenUrls.has(canonicalUrl)) continue;
    seenUrls.add(canonicalUrl);
    urlUnique.push({ ...candidate, url: candidate.url });
  }

  const seenHeadlines = new Set<string>();
  const unique: Array<StoryCandidate & { url: string }> = [];
  for (const candidate of urlUnique) {
    const fingerprint = normalizedHeadlineFingerprint(candidate.headline);
    if (seenHeadlines.has(fingerprint)) continue;
    seenHeadlines.add(fingerprint);
    unique.push(candidate);
  }
  unique.sort(compareStories);

  const selected: Array<StoryCandidate & { url: string }> = [];
  const selectedIds = new Set<string>();
  const sources = new Set<string>();
  for (const candidate of unique) {
    if (sources.has(candidate.source)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    sources.add(candidate.source);
    if (selected.length === 3) break;
  }
  if (selected.length < 3) {
    for (const candidate of unique) {
      if (selectedIds.has(candidate.id)) continue;
      selected.push(candidate);
      if (selected.length === 3) break;
    }
  }

  return selected.map((candidate, index) => RankedStorySchema.parse({
    ...candidate,
    status: 'selected',
    url: canonicalizeUrl(candidate.url),
    canonicalUrl: canonicalizeUrl(candidate.url),
    headlineFingerprint: normalizedHeadlineFingerprint(candidate.headline),
    rank: index + 1,
    ranking: { recency: recency(candidate), bodyCompleteness: candidate.body.trim().length },
  }));
}

export function writeBulletinScript(stories: RankedStory[], createdAt: string): BulletinScript {
  return BulletinScriptSchema.parse({
    id: `script-${createdAt}`,
    createdAt,
    status: 'draft',
    segments: stories.map((story) => ({
      id: `segment-${story.id}`,
      kind: 'factual',
      text: `${story.headline.trim()} ${story.body.trim()}`,
      citations: [{
        storyId: story.id,
        url: story.canonicalUrl,
        text: `${story.headline.trim()} ${story.body.trim()}`,
      }],
    })),
  });
}

const normalizedText = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function runFactGate(script: BulletinScript, stories: RankedStory[], checkedAt: string): FactGateDecision {
  const sources = new Map(stories.map((story) => [story.id, story]));
  const reasons: string[] = [];
  if (!script.segments.some(({ kind }) => kind === 'factual')) reasons.push('script: no factual segments');
  for (const segment of script.segments) {
    if (segment.kind !== 'factual') continue;
    if (segment.citations.length === 0) reasons.push(`${segment.id}: missing citation`);
    for (const citation of segment.citations) {
      const source = sources.get(citation.storyId);
      if (!source) {
        reasons.push(`${segment.id}: unknown story ${citation.storyId}`);
        continue;
      }
      if (!citation.url) reasons.push(`${segment.id}: missing citation URL`);
      else if (citation.url !== source.canonicalUrl) {
        reasons.push(`${segment.id}: citation URL does not match story`);
      }
      const sourceText = normalizedText(`${source.headline} ${source.body}`);
      if (normalizedText(citation.text) !== sourceText || normalizedText(segment.text) !== sourceText) {
        reasons.push(`${segment.id}: unsupported text`);
      }
    }
  }
  const approved = reasons.length === 0;
  return FactGateDecisionSchema.parse({
    id: `fact-gate-${checkedAt}`,
    checkedAt,
    approved,
    scriptStatus: approved ? 'ready_for_voice' : 'blocked',
    reasons,
  });
}

export function runResearchFactGate(
  script: BulletinScript,
  stories: RankedStory[],
  evidence: LinkupEvidence[],
  checkedAt: string,
  publicationWindow?: PublicationWindow,
): FactGateDecision {
  const base = runFactGate(script, stories, checkedAt);
  const byStory = new Map(evidence.map((item) => [item.storyId, item]));
  const reasons = [...base.reasons];
  for (const story of stories) {
    const item = byStory.get(story.id);
    if (!item || item.verificationStatus !== 'verified' || !item.original.markdown?.trim()) {
      reasons.push(`story ${story.id}: original fetch not verified`);
    }
    if (publicationWindow) {
      const published = story.publishedAt ? Date.parse(story.publishedAt) : Number.NaN;
      if (!Number.isFinite(published)) reasons.push(`story ${story.id}: missing publishedAt`);
      else if (published > Date.parse(publicationWindow.to)) reasons.push(`story ${story.id}: future publishedAt`);
      else if (published < Date.parse(publicationWindow.from)) reasons.push(`story ${story.id}: publishedAt outside publication window`);
    }
  }
  const approved = reasons.length === 0;
  return FactGateDecisionSchema.parse({
    ...base, approved, scriptStatus: approved ? 'ready_for_voice' : 'blocked', reasons,
  });
}

export interface PreparedEdition {
  rundown: { id: string; createdAt: string; stories: RankedStory[] };
  script: BulletinScript;
  factGate: FactGateDecision;
  edition: EditionArtifact;
}

export function prepareEdition(candidates: StoryCandidate[], createdAt: string): PreparedEdition {
  const stories = rankStories(candidates);
  const rundown = { id: `rundown-${createdAt}`, createdAt, stories };
  const draft = writeBulletinScript(stories, createdAt);
  const factGate = runFactGate(draft, stories, createdAt);
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
  return { rundown, script, factGate, edition };
}
