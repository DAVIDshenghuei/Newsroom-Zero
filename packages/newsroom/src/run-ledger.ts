import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { RankedStory } from './pipeline.js';

export const RUN_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1_000;

export const RunStatusSchema = z.enum(['running', 'completed', 'blocked', 'failed']);
export const RunReasonCodeSchema = z.enum([
  'STARTED', 'COMPLETED', 'NO_ELIGIBLE_STORIES', 'FACT_GATE_BLOCKED', 'INTERNAL_FAILURE',
]);
export const ObservationStageSchema = z.enum([
  'source', 'original', 'publication', 'policy', 'ranking', 'fact_gate',
]);
export const ObservationOutcomeSchema = z.enum(['accepted', 'rejected', 'observed', 'blocked']);
const RankingExplanationCodeSchema = z.enum([
  'SOURCE_TIER_1', 'SOURCE_TIER_2', 'SOURCE_TIER_UNKNOWN',
  'POLICY_MATCHES_PRESENT', 'POLICY_MATCHES_ABSENT',
  'RECENT_WITHIN_WINDOW', 'OLDER_WITHIN_WINDOW',
  'BODY_COMPLETE', 'BODY_PARTIAL',
]);
export const RankingExplanationSchema = z.object({
  sourceAuthority: z.number().min(0).max(1),
  policyRelevance: z.number().min(0).max(1),
  recency: z.number().min(0).max(1),
  bodyCompleteness: z.number().min(0).max(1),
  explanationCodes: z.array(RankingExplanationCodeSchema).min(4).max(4),
}).strict();
export const ObservationReasonCodeSchema = z.enum([
  'SOURCE_ALLOWED', 'SOURCE_DOMAIN_NOT_ALLOWED', 'SOURCE_DOMAIN_EXCLUDED', 'SOURCE_URL_INVALID',
  'ORIGINAL_FETCHED', 'ORIGINAL_FETCH_FAILED',
  'PUBLICATION_ACCEPTED', 'PUBLICATION_MISSING', 'PUBLICATION_INVALID', 'PUBLICATION_FUTURE', 'PUBLICATION_OUT_OF_WINDOW',
  'POLICY_ACCEPTED', 'POLICY_MISSING_TOPIC', 'POLICY_MISSING_ANALYSIS', 'POLICY_EXCLUDED_KEYWORD',
  'RANK_SELECTED', 'RANK_NOT_SELECTED', 'FACT_GATE_APPROVED', 'FACT_GATE_BLOCKED',
]);

export function publicSourceUrl(value: string): string {
  const url = new URL(z.string().url().parse(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Source URL must be a public HTTP URL without credentials');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
const PublicUrlSchema = z.string().transform(publicSourceUrl);
export const StartRunInputSchema = z.object({
  windowHours: z.number().int().min(1).max(24 * 31),
}).strict();
const OBSERVATION_CONTRACT: Record<z.infer<typeof ObservationReasonCodeSchema>, {
  stage: z.infer<typeof ObservationStageSchema>;
  outcome: z.infer<typeof ObservationOutcomeSchema>;
}> = {
  SOURCE_ALLOWED: { stage: 'source', outcome: 'accepted' },
  SOURCE_DOMAIN_NOT_ALLOWED: { stage: 'source', outcome: 'rejected' },
  SOURCE_DOMAIN_EXCLUDED: { stage: 'source', outcome: 'rejected' },
  SOURCE_URL_INVALID: { stage: 'source', outcome: 'rejected' },
  ORIGINAL_FETCHED: { stage: 'original', outcome: 'accepted' },
  ORIGINAL_FETCH_FAILED: { stage: 'original', outcome: 'rejected' },
  PUBLICATION_ACCEPTED: { stage: 'publication', outcome: 'accepted' },
  PUBLICATION_MISSING: { stage: 'publication', outcome: 'rejected' },
  PUBLICATION_INVALID: { stage: 'publication', outcome: 'rejected' },
  PUBLICATION_FUTURE: { stage: 'publication', outcome: 'rejected' },
  PUBLICATION_OUT_OF_WINDOW: { stage: 'publication', outcome: 'rejected' },
  POLICY_ACCEPTED: { stage: 'policy', outcome: 'accepted' },
  POLICY_MISSING_TOPIC: { stage: 'policy', outcome: 'rejected' },
  POLICY_MISSING_ANALYSIS: { stage: 'policy', outcome: 'rejected' },
  POLICY_EXCLUDED_KEYWORD: { stage: 'policy', outcome: 'rejected' },
  RANK_SELECTED: { stage: 'ranking', outcome: 'observed' },
  RANK_NOT_SELECTED: { stage: 'ranking', outcome: 'observed' },
  FACT_GATE_APPROVED: { stage: 'fact_gate', outcome: 'accepted' },
  FACT_GATE_BLOCKED: { stage: 'fact_gate', outcome: 'blocked' },
};
export const ObservationInputSchema = z.object({
  candidateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  fetchedAt: z.string().datetime(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  stage: ObservationStageSchema,
  outcome: ObservationOutcomeSchema,
  reasonCode: ObservationReasonCodeSchema,
  source: z.string().trim().min(1).max(160).optional(),
  hostname: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/).optional(),
  canonicalUrl: PublicUrlSchema.optional(),
  publishedAt: z.string().datetime().optional(),
  sourceTier: z.enum(['tier1', 'tier2']).optional(),
  rank: z.number().int().min(1).max(1000).optional(),
  sourcePriority: z.number().int().min(0).max(100).optional(),
  policyRelevance: z.number().int().min(0).max(100).optional(),
  recency: z.number().int().min(0).max(253_402_300_799_999).optional(),
  bodyCompleteness: z.number().int().min(0).max(1_000_000).optional(),
  ranking: RankingExplanationSchema.optional(),
}).strict().superRefine((value, context) => {
  const expected = OBSERVATION_CONTRACT[value.reasonCode];
  if (value.stage !== expected.stage || value.outcome !== expected.outcome) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Observation stage/outcome contradicts reason code' });
  }
});
export const FinalizeRunInputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), reasonCode: z.literal('COMPLETED'),
    candidateCount: z.number().int().min(0).max(100_000), selectedCount: z.number().int().min(0).max(1000) }).strict(),
  z.object({ status: z.literal('blocked'), reasonCode: z.enum(['NO_ELIGIBLE_STORIES', 'FACT_GATE_BLOCKED']),
    candidateCount: z.number().int().min(0).max(100_000), selectedCount: z.number().int().min(0).max(1000) }).strict(),
  z.object({ status: z.literal('failed'), reasonCode: z.literal('INTERNAL_FAILURE'),
    candidateCount: z.number().int().min(0).max(100_000), selectedCount: z.number().int().min(0).max(1000) }).strict(),
]);

const RunRowSchema = z.object({
  id: z.string().regex(/^run_[0-9a-f-]{36}$/), startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
  status: RunStatusSchema, reasonCode: RunReasonCodeSchema,
  windowHours: z.number().int().positive(), candidateCount: z.number().int().nonnegative(), selectedCount: z.number().int().nonnegative(),
}).strict();
const RejectionRowSchema = z.object({ reasonCode: ObservationReasonCodeSchema, count: z.number().int().nonnegative() }).strict();
const RankingJsonSchema = z.preprocess((value) => typeof value === 'string' ? JSON.parse(value) : value,
  RankingExplanationSchema.nullable());
const ObservationRowSchema = z.object({
  candidateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), fetchedAt: z.string().datetime(), hash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.string().datetime(), stage: ObservationStageSchema, outcome: ObservationOutcomeSchema,
  reasonCode: ObservationReasonCodeSchema, source: z.string().nullable(), hostname: z.string().nullable(),
  canonicalUrl: z.string().url().nullable(), publishedAt: z.string().datetime().nullable(), sourceTier: z.enum(['tier1', 'tier2']).nullable(),
  rank: z.number().int().nullable(), sourcePriority: z.number().int().nullable(), policyRelevance: z.number().int().nullable(),
  recency: z.number().int().nullable(), bodyCompleteness: z.number().int().nullable(), ranking: RankingJsonSchema,
}).strict();
const CandidateTimelineSchema = z.object({
  candidateId: z.string(), fetchedAt: z.string().datetime(), hash: z.string(), source: z.string().nullable(),
  hostname: z.string().nullable(), canonicalUrl: z.string().url().nullable(), timeline: z.array(ObservationRowSchema).max(10_000),
}).strict();
const RunSummarySchema = z.object({ run: RunRowSchema.nullable(), rejections: z.array(RejectionRowSchema),
  candidates: z.array(CandidateTimelineSchema).max(2_000), truncated: z.boolean() }).strict();
const SourceHealthCountSchema = z.object({
  hostname: z.string(), source: z.string().nullable(), candidateCount: z.number().int().nonnegative(),
  originalFetchVerified: z.number().int().nonnegative(), originalFetchFailed: z.number().int().nonnegative(),
  missingPublishedAt: z.number().int().nonnegative(), futurePublishedAt: z.number().int().nonnegative(),
  outsidePublicationWindow: z.number().int().nonnegative(), policyAccepted: z.number().int().nonnegative(),
  policyRejected: z.number().int().nonnegative(), selected: z.number().int().nonnegative(),
  notSelected: z.number().int().nonnegative(),
}).strict();
const SourceHealthRowSchema = SourceHealthCountSchema.extend({
  fetchVerificationRate: z.number().min(0).max(1), policyAcceptanceRate: z.number().min(0).max(1),
  selectionRate: z.number().min(0).max(1),
}).strict();

export interface NewsroomRunLedgerOptions { path: string; now?: () => Date }

export function sourceMetadataHash(value: { candidateId: string; fetchedAt: string; canonicalUrl?: string; publishedAt?: string }): string {
  return createHash('sha256').update(JSON.stringify({ ...value,
    canonicalUrl: value.canonicalUrl ? publicSourceUrl(value.canonicalUrl) : undefined,
  })).digest('hex');
}

export function rankingComponents(story: RankedStory, window: { from: string; to: string }) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!story.publishedAt) throw new Error('Invalid ranking window');
  const published = Date.parse(story.publishedAt);
  if (![from, to, published].every(Number.isFinite) || to <= from) throw new Error('Invalid ranking window');
  const sourceAuthority = story.ranking.sourcePriority === 2 ? 1 : story.ranking.sourcePriority === 1 ? 0.5 : 0;
  const policyRelevance = Math.min((story.ranking.policyRelevance ?? 0) / 6, 1);
  const recency = Math.min(Math.max((published - from) / (to - from), 0), 1);
  const bodyCompleteness = Math.min(story.ranking.bodyCompleteness / 2_000, 1);
  return ObservationInputSchema.parse({
    candidateId: story.id, fetchedAt: story.fetchedAt,
    hash: sourceMetadataHash({ candidateId: story.id, fetchedAt: story.fetchedAt, canonicalUrl: story.canonicalUrl, publishedAt: story.publishedAt }),
    stage: 'ranking', outcome: 'observed', reasonCode: 'RANK_SELECTED', rank: story.rank,
    sourcePriority: story.ranking.sourcePriority,
    policyRelevance: Math.min(story.ranking.policyRelevance ?? 0, 100),
    recency: story.ranking.recency,
    bodyCompleteness: Math.min(story.ranking.bodyCompleteness, 1_000_000),
    source: story.source, hostname: new URL(story.canonicalUrl).hostname,
    canonicalUrl: story.canonicalUrl, publishedAt: story.publishedAt,
    ranking: {
      sourceAuthority, policyRelevance, recency, bodyCompleteness,
      explanationCodes: [
        sourceAuthority === 1 ? 'SOURCE_TIER_1' : sourceAuthority === 0.5 ? 'SOURCE_TIER_2' : 'SOURCE_TIER_UNKNOWN',
        policyRelevance > 0 ? 'POLICY_MATCHES_PRESENT' : 'POLICY_MATCHES_ABSENT',
        recency >= 0.5 ? 'RECENT_WITHIN_WINDOW' : 'OLDER_WITHIN_WINDOW',
        bodyCompleteness >= 1 ? 'BODY_COMPLETE' : 'BODY_PARTIAL',
      ],
    },
  });
}

export class NewsroomRunLedger {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private retentionTimer?: ReturnType<typeof setTimeout>;

  constructor(options: NewsroomRunLedgerOptions) {
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(options.path), { recursive: true });
    this.database = new DatabaseSync(options.path);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const version = Number((this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version);
    if (version > 1) {
      this.database.close();
      throw new Error('Run Ledger uses a newer schema version');
    }
    if (version < 1) this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS research_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running','completed','blocked','failed')),
        reason_code TEXT NOT NULL CHECK (reason_code IN ('STARTED','COMPLETED','NO_ELIGIBLE_STORIES','FACT_GATE_BLOCKED','INTERNAL_FAILURE')),
        window_hours INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        selected_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS story_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        metadata_hash TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('source','original','publication','policy','ranking','fact_gate')),
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','observed','blocked')),
        reason_code TEXT NOT NULL CHECK (reason_code IN (
          'SOURCE_ALLOWED','SOURCE_DOMAIN_NOT_ALLOWED','SOURCE_DOMAIN_EXCLUDED','SOURCE_URL_INVALID',
          'ORIGINAL_FETCHED','ORIGINAL_FETCH_FAILED','PUBLICATION_ACCEPTED','PUBLICATION_MISSING','PUBLICATION_INVALID',
          'PUBLICATION_FUTURE','PUBLICATION_OUT_OF_WINDOW','POLICY_ACCEPTED','POLICY_MISSING_TOPIC',
          'POLICY_MISSING_ANALYSIS','POLICY_EXCLUDED_KEYWORD','RANK_SELECTED','RANK_NOT_SELECTED',
          'FACT_GATE_APPROVED','FACT_GATE_BLOCKED')),
        source TEXT,
        hostname TEXT,
        canonical_url TEXT,
        published_at TEXT,
        source_tier TEXT,
        rank INTEGER,
        source_priority INTEGER,
        policy_relevance INTEGER,
        recency INTEGER,
        body_completeness INTEGER,
        ranking_json TEXT,
        CHECK (
          (stage = 'source' AND ((reason_code = 'SOURCE_ALLOWED' AND outcome = 'accepted') OR
            (reason_code IN ('SOURCE_DOMAIN_NOT_ALLOWED','SOURCE_DOMAIN_EXCLUDED','SOURCE_URL_INVALID') AND outcome = 'rejected'))) OR
          (stage = 'original' AND ((reason_code = 'ORIGINAL_FETCHED' AND outcome = 'accepted') OR
            (reason_code = 'ORIGINAL_FETCH_FAILED' AND outcome = 'rejected'))) OR
          (stage = 'publication' AND ((reason_code = 'PUBLICATION_ACCEPTED' AND outcome = 'accepted') OR
            (reason_code IN ('PUBLICATION_MISSING','PUBLICATION_INVALID','PUBLICATION_FUTURE','PUBLICATION_OUT_OF_WINDOW') AND outcome = 'rejected'))) OR
          (stage = 'policy' AND ((reason_code = 'POLICY_ACCEPTED' AND outcome = 'accepted') OR
            (reason_code IN ('POLICY_MISSING_TOPIC','POLICY_MISSING_ANALYSIS','POLICY_EXCLUDED_KEYWORD') AND outcome = 'rejected'))) OR
          (stage = 'ranking' AND reason_code IN ('RANK_SELECTED','RANK_NOT_SELECTED') AND outcome = 'observed') OR
          (stage = 'fact_gate' AND ((reason_code = 'FACT_GATE_APPROVED' AND outcome = 'accepted') OR
            (reason_code = 'FACT_GATE_BLOCKED' AND outcome = 'blocked')))
        )
      );
      CREATE INDEX IF NOT EXISTS story_observations_run_id ON story_observations(run_id);
      `);
      if (version < 1) {
        this.database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(1, this.now().toISOString());
        this.database.exec('COMMIT');
      }

    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      this.database.close();
      throw error;
    }
    this.cleanupExpired();
  }

  private scheduleRetentionCleanup(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    const oldest = this.database.prepare('SELECT MIN(started_at) AS startedAt FROM research_runs').get() as { startedAt: string | null };
    if (!oldest.startedAt) {
      this.retentionTimer = undefined;
      return;
    }
    const delay = Math.max(1, Date.parse(oldest.startedAt) + RUN_LEDGER_RETENTION_MS - this.now().getTime());
    this.retentionTimer = setTimeout(() => {
      try { this.cleanupExpired(); } catch { /* access-time cleanup remains fail closed */ }
    }, Math.min(delay, 2_147_483_647));
    this.retentionTimer.unref();
  }

  pragmaState(): { journalMode: string; foreignKeys: boolean } {
    const journal = this.database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    return { journalMode: journal.journal_mode, foreignKeys: foreignKeys.foreign_keys === 1 };
  }

  startRun(input: z.input<typeof StartRunInputSchema>): string {
    const value = StartRunInputSchema.parse(input);
    this.cleanupExpired();
    const id = `run_${randomUUID()}`;
    this.database.prepare(`INSERT INTO research_runs
      (id, started_at, status, reason_code, window_hours)
      VALUES (?, ?, 'running', 'STARTED', ?)`)
      .run(id, this.now().toISOString(), value.windowHours);
    this.scheduleRetentionCleanup();
    return id;
  }

  observe(runId: string, input: z.input<typeof ObservationInputSchema>): void {
    const id = z.string().regex(/^run_[0-9a-f-]{36}$/).parse(runId);
    const value = ObservationInputSchema.parse(input);
    this.cleanupExpired();
    this.database.prepare(`INSERT INTO story_observations
      (run_id, observed_at, candidate_id, fetched_at, metadata_hash, stage, outcome, reason_code, source, hostname, canonical_url, published_at,
       source_tier, rank, source_priority, policy_relevance, recency, body_completeness, ranking_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, this.now().toISOString(), value.candidateId, value.fetchedAt, value.hash, value.stage, value.outcome, value.reasonCode,
        value.source ?? null, value.hostname ?? null, value.canonicalUrl ?? null, value.publishedAt ?? null,
        value.sourceTier ?? null, value.rank ?? null, value.sourcePriority ?? null,
        value.policyRelevance ?? null, value.recency ?? null, value.bodyCompleteness ?? null,
        value.ranking ? JSON.stringify(value.ranking) : null);
  }

  finalizeRun(runId: string, input: z.input<typeof FinalizeRunInputSchema>): void {
    const id = z.string().regex(/^run_[0-9a-f-]{36}$/).parse(runId);
    const value = FinalizeRunInputSchema.parse(input);
    this.cleanupExpired();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare(`UPDATE research_runs SET completed_at = ?, status = ?, reason_code = ?,
        candidate_count = ?, selected_count = ? WHERE id = ? AND status = 'running'`)
        .run(this.now().toISOString(), value.status, value.reasonCode, value.candidateCount, value.selectedCount, id);
      if (result.changes !== 1) throw new Error('Run Ledger terminal update matched no run');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  cleanupExpired(): number {
    const cutoff = new Date(this.now().getTime() - RUN_LEDGER_RETENTION_MS).toISOString();
    const deleted = Number(this.database.prepare('DELETE FROM research_runs WHERE started_at <= ?').run(cutoff).changes);
    this.scheduleRetentionCleanup();
    return deleted;
  }

  recentRuns(input: { limit: number }) {
    this.cleanupExpired();
    const { limit } = z.object({ limit: z.number().int().min(1).max(100) }).strict().parse(input);
    return RunRowSchema.array().parse(this.database.prepare(`SELECT id, started_at AS startedAt, completed_at AS completedAt,
      status, reason_code AS reasonCode, window_hours AS windowHours,
      candidate_count AS candidateCount, selected_count AS selectedCount
      FROM research_runs ORDER BY started_at DESC, id DESC LIMIT ?`).all(limit));
  }

  runSummary(runId: string) {
    this.cleanupExpired();
    const id = z.string().regex(/^run_[0-9a-f-]{36}$/).parse(runId);
    const run = this.database.prepare(`SELECT id, started_at AS startedAt, completed_at AS completedAt,
      status, reason_code AS reasonCode, window_hours AS windowHours,
      candidate_count AS candidateCount, selected_count AS selectedCount
      FROM research_runs WHERE id = ?`).get(id);
    if (!run) return RunSummarySchema.parse({ run: null, rejections: [], candidates: [], truncated: false });
    const reasons = RejectionRowSchema.array().parse(this.database.prepare(`SELECT reason_code AS reasonCode, COUNT(*) AS count
      FROM story_observations WHERE run_id = ? AND outcome IN ('rejected','blocked')
      GROUP BY reason_code ORDER BY reason_code`).all(id));
    const observations = ObservationRowSchema.array().parse(this.database.prepare(`SELECT candidate_id AS candidateId,
      fetched_at AS fetchedAt, metadata_hash AS hash, observed_at AS observedAt, stage, outcome,
      reason_code AS reasonCode, source, hostname, canonical_url AS canonicalUrl, published_at AS publishedAt,
      source_tier AS sourceTier, rank, source_priority AS sourcePriority, policy_relevance AS policyRelevance,
      recency, body_completeness AS bodyCompleteness, ranking_json AS ranking
      FROM story_observations WHERE run_id = ? ORDER BY id LIMIT 10000`).all(id));
    const totalObservations = Number((this.database.prepare('SELECT COUNT(*) AS count FROM story_observations WHERE run_id = ?').get(id) as { count: number }).count);
    const candidates = [...new Set(observations.map(({ candidateId }) => candidateId))].map((candidateId) => {
      const timeline = observations.filter((item) => item.candidateId === candidateId);
      const first = timeline[0];
      return { candidateId, fetchedAt: first.fetchedAt, hash: first.hash, source: first.source,
        hostname: first.hostname, canonicalUrl: first.canonicalUrl, timeline };
    });
    return RunSummarySchema.parse({ run: RunRowSchema.parse(run), rejections: reasons,
      candidates: candidates.slice(0, 2_000), truncated: totalObservations > observations.length || candidates.length > 2_000 });
  }

  sourceHealth(input: { limit: number }) {
    this.cleanupExpired();
    const { limit } = z.object({ limit: z.number().int().min(1).max(100) }).strict().parse(input);
    const counts = SourceHealthCountSchema.array().parse(this.database.prepare(`SELECT hostname, source,
      COUNT(DISTINCT run_id || ':' || candidate_id) AS candidateCount,
      COUNT(DISTINCT CASE WHEN reason_code = 'ORIGINAL_FETCHED' THEN run_id || ':' || candidate_id END) AS originalFetchVerified,
      COUNT(DISTINCT CASE WHEN reason_code = 'ORIGINAL_FETCH_FAILED' THEN run_id || ':' || candidate_id END) AS originalFetchFailed,
      COUNT(DISTINCT CASE WHEN reason_code = 'PUBLICATION_MISSING' THEN run_id || ':' || candidate_id END) AS missingPublishedAt,
      COUNT(DISTINCT CASE WHEN reason_code = 'PUBLICATION_FUTURE' THEN run_id || ':' || candidate_id END) AS futurePublishedAt,
      COUNT(DISTINCT CASE WHEN reason_code = 'PUBLICATION_OUT_OF_WINDOW' THEN run_id || ':' || candidate_id END) AS outsidePublicationWindow,
      COUNT(DISTINCT CASE WHEN reason_code = 'POLICY_ACCEPTED' THEN run_id || ':' || candidate_id END) AS policyAccepted,
      COUNT(DISTINCT CASE WHEN reason_code IN ('POLICY_MISSING_TOPIC','POLICY_MISSING_ANALYSIS','POLICY_EXCLUDED_KEYWORD') THEN run_id || ':' || candidate_id END) AS policyRejected,
      COUNT(DISTINCT CASE WHEN reason_code = 'RANK_SELECTED' THEN run_id || ':' || candidate_id END) AS selected,
      COUNT(DISTINCT CASE WHEN reason_code = 'RANK_NOT_SELECTED' THEN run_id || ':' || candidate_id END) AS notSelected
      FROM story_observations WHERE hostname IS NOT NULL
      GROUP BY hostname, source ORDER BY candidateCount DESC, hostname ASC LIMIT ?`).all(limit));
    const rate = (numerator: number, denominator: number): number => denominator === 0 ? 0 : numerator / denominator;
    return SourceHealthRowSchema.array().parse(counts.map((row) => ({
      ...row,
      fetchVerificationRate: rate(row.originalFetchVerified, row.originalFetchVerified + row.originalFetchFailed),
      policyAcceptanceRate: rate(row.policyAccepted, row.policyAccepted + row.policyRejected),
      selectionRate: rate(row.selected, row.selected + row.notSelected),
    })));
  }

  observationCount(): number {
    this.cleanupExpired();
    return Number((this.database.prepare('SELECT COUNT(*) AS count FROM story_observations').get() as { count: number }).count);
  }

  close(): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.database.close();
  }
}
