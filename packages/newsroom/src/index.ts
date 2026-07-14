import { z } from 'zod';

// ─── StoryCandidate ───────────────────────────────────────────

export const StoryStatus = z.enum(['pending', 'selected', 'rejected']);
export type StoryStatus = z.infer<typeof StoryStatus>;

export const StoryCandidateSchema = z.object({
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
  status: StoryStatus,
});
export type StoryCandidate = z.infer<typeof StoryCandidateSchema>;

export * from './feeds.js';
export * from './http-fetcher.js';
export * from './pipeline.js';
export * from './elevenlabs.js';
export * from './pocket-tts.js';
export * from './voice.js';
export * from './telegram.js';
export * from './linkup.js';
export * from './analysis.js';
export * from './codex-analysis.js';
export * from './bot-copy.js';
export * from './bot.js';
export * from './languages.js';
export * from './search-policy.js';
export * from './document-voice.js';
export * from './document-telegram.js';

// ─── VerifiedClaim ────────────────────────────────────────────

export const ClaimVerdict = z.enum(['true', 'false', 'misleading', 'unverifiable']);
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

export const VerifiedClaimSchema = z.object({
  id: z.string().min(1),
  storyId: z.string().min(1),
  claim: z.string().min(1),
  verdict: ClaimVerdict,
  evidence: z.string().optional(),
  verifiedAt: z.string().datetime(),
});
export type VerifiedClaim = z.infer<typeof VerifiedClaimSchema>;

// ─── FactGateResult ───────────────────────────────────────────

export const GateVerdict = z.enum(['approved', 'rejected', 'needs_review']);
export type GateVerdict = z.infer<typeof GateVerdict>;

export const FactGateResultSchema = z.object({
  id: z.string().min(1),
  storyId: z.string().min(1),
  passed: z.boolean(),
  claims: z.array(VerifiedClaimSchema),
  overallVerdict: GateVerdict,
  checkedAt: z.string().datetime(),
});
export type FactGateResult = z.infer<typeof FactGateResultSchema>;

// ─── Rundown ──────────────────────────────────────────────────

export const RundownStatus = z.enum(['draft', 'finalized', 'published']);
export type RundownStatus = z.infer<typeof RundownStatus>;

export const RundownSchema = z.object({
  id: z.string().min(1),
  editionId: z.string().min(1),
  stories: z.array(z.string()),
  createdAt: z.string().datetime(),
  status: RundownStatus,
});
export type Rundown = z.infer<typeof RundownSchema>;

// ─── EditionStatus ────────────────────────────────────────────

export const EditionPhase = z.enum([
  'creating',
  'curating',
  'fact_checking',
  'voicing',
  'publishing',
  'published',
  'failed',
]);
export type EditionPhase = z.infer<typeof EditionPhase>;

export const EditionStatusSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: EditionPhase,
  rundown: RundownSchema.optional(),
  factGateResults: z.array(FactGateResultSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EditionStatus = z.infer<typeof EditionStatusSchema>;
