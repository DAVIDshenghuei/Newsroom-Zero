import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  NewsroomRunLedger,
  RUN_LEDGER_RETENTION_MS,
  rankingComponents,
  publicSourceUrl,
} from '../run-ledger.js';
import { executeRunLedgerCli, parseRunLedgerCliArgs } from '../run-ledger-cli.js';
import { rankStories, type StoryCandidate } from '../index.js';

describe('Newsroom Run Ledger storage contract', () => {
  it('stores a source URL without credentials, query data, or fragments', () => {
    expect(publicSourceUrl('https://news.example/story?token=private#quote')).toBe('https://news.example/story');
    expect(() => publicSourceUrl('https://user:password@news.example/story')).toThrow();
  });

  it('creates a missing artifacts parent on first production-style open', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-parent-'));
    const ledger = new NewsroomRunLedger({ path: join(directory, 'missing', 'artifacts', 'newsroom-ledger.sqlite') });
    expect(ledger.pragmaState().foreignKeys).toBe(true);
    ledger.close();
  });

  it('fails closed when the database has a newer unknown migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-future-'));
    const path = join(directory, 'ledger.sqlite');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(99, '2026-07-14T12:00:00.000Z');
    database.close();
    expect(() => new NewsroomRunLedger({ path })).toThrow('newer schema version');
  });

  it('fails terminal finalization when the run does not exist', () => {
    const ledger = new NewsroomRunLedger({ path: ':memory:' });
    expect(() => ledger.finalizeRun('run_00000000-0000-4000-8000-000000000000', {
      status: 'completed', reasonCode: 'COMPLETED', candidateCount: 0, selectedCount: 0,
    })).toThrow('Run Ledger terminal update matched no run');
    ledger.close();
  });

  it('deletes a live-process run at its exact retention deadline without waiting for the fallback sweep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
    const ledger = new NewsroomRunLedger({ path: ':memory:' });
    ledger.startRun({ windowHours: 24 });
    expect(ledger.recentRuns({ limit: 1 })).toHaveLength(1);
    vi.advanceTimersByTime(RUN_LEDGER_RETENTION_MS);
    expect(ledger.recentRuns({ limit: 1 })).toEqual([]);
    ledger.close();
    vi.useRealTimers();
  });

  it('rejects stage, outcome, and reason-code combinations that contradict the fixed contract', () => {
    const ledger = new NewsroomRunLedger({ path: ':memory:' });
    const runId = ledger.startRun({ windowHours: 24 });
    expect(() => ledger.observe(runId, {
      candidateId: 'candidate1', fetchedAt: '2026-07-14T11:00:00.000Z', hash: 'a'.repeat(64),
      stage: 'source', outcome: 'blocked', reasonCode: 'FACT_GATE_BLOCKED',
    })).toThrow();
    ledger.close();
  });

  it('rejects contradictory terminal status and reason combinations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-status-'));
    const ledger = new NewsroomRunLedger({ path: join(directory, 'ledger.sqlite') });
    const runId = ledger.startRun({ windowHours: 72 });
    expect(() => ledger.finalizeRun(runId, {
      status: 'completed', reasonCode: 'FACT_GATE_BLOCKED', candidateCount: 1, selectedCount: 1,
    } as never)).toThrow();
    ledger.close();
  });

  it('returns validated candidate timelines and candidate-level source health with full epoch recency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-timeline-'));
    const ledger = new NewsroomRunLedger({ path: join(directory, 'ledger.sqlite'), now: () => new Date('2026-07-14T12:00:00.000Z') });
    const runId = ledger.startRun({ windowHours: 72 });
    const identity = {
      candidateId: 'linkup-0123456789abcdef0123', fetchedAt: '2026-07-14T11:00:00.000Z',
      hash: 'a'.repeat(64), source: 'news.example', hostname: 'news.example', canonicalUrl: 'https://news.example/story',
    };
    ledger.observe(runId, { ...identity, stage: 'source', outcome: 'accepted', reasonCode: 'SOURCE_ALLOWED' });
    ledger.observe(runId, { ...identity, stage: 'ranking', outcome: 'observed', reasonCode: 'RANK_SELECTED',
      rank: 1, recency: 1_752_490_000_000, bodyCompleteness: 100 });
    ledger.finalizeRun(runId, { status: 'completed', reasonCode: 'COMPLETED', candidateCount: 1, selectedCount: 1 });
    const summary = ledger.runSummary(runId);
    expect(summary.candidates).toEqual([{ candidateId: identity.candidateId, fetchedAt: identity.fetchedAt,
      hash: identity.hash, source: 'news.example', hostname: 'news.example', canonicalUrl: 'https://news.example/story',
      timeline: [expect.objectContaining({ reasonCode: 'SOURCE_ALLOWED' }), expect.objectContaining({ reasonCode: 'RANK_SELECTED', recency: 1_752_490_000_000 })] }]);
    expect(ledger.sourceHealth({ limit: 10 })).toEqual([expect.objectContaining({
      hostname: 'news.example', candidateCount: 1, selected: 1, notSelected: 0, selectionRate: 1,
    })]);
    ledger.close();
  });

  it('computes source health from distinct candidates with stage-specific denominators', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-health-'));
    const ledger = new NewsroomRunLedger({ path: join(directory, 'ledger.sqlite'), now: () => new Date('2026-07-14T12:00:00.000Z') });
    const runId = ledger.startRun({ windowHours: 24 });
    const base = (candidateId: string) => ({ candidateId, fetchedAt: '2026-07-14T11:00:00.000Z',
      hash: 'a'.repeat(64), source: 'news.example', hostname: 'news.example',
      canonicalUrl: `https://news.example/${candidateId}` });
    const observe = (candidateId: string, stage: 'source' | 'original' | 'publication' | 'policy' | 'ranking',
      outcome: 'accepted' | 'rejected' | 'observed', reasonCode: Parameters<typeof ledger.observe>[1]['reasonCode']) =>
      ledger.observe(runId, { ...base(candidateId), stage, outcome, reasonCode });
    for (const id of ['candidate1', 'candidate2', 'candidate3', 'candidate4', 'candidate5']) observe(id, 'source', 'accepted', 'SOURCE_ALLOWED');
    observe('candidate1', 'original', 'accepted', 'ORIGINAL_FETCHED');
    observe('candidate1', 'publication', 'accepted', 'PUBLICATION_ACCEPTED');
    observe('candidate1', 'policy', 'accepted', 'POLICY_ACCEPTED');
    observe('candidate1', 'ranking', 'observed', 'RANK_SELECTED');
    observe('candidate2', 'original', 'rejected', 'ORIGINAL_FETCH_FAILED');
    observe('candidate2', 'publication', 'rejected', 'PUBLICATION_MISSING');
    observe('candidate3', 'original', 'accepted', 'ORIGINAL_FETCHED');
    observe('candidate3', 'publication', 'rejected', 'PUBLICATION_FUTURE');
    observe('candidate4', 'original', 'accepted', 'ORIGINAL_FETCHED');
    observe('candidate4', 'publication', 'accepted', 'PUBLICATION_ACCEPTED');
    observe('candidate4', 'policy', 'rejected', 'POLICY_MISSING_TOPIC');
    observe('candidate5', 'original', 'accepted', 'ORIGINAL_FETCHED');
    observe('candidate5', 'publication', 'accepted', 'PUBLICATION_ACCEPTED');
    observe('candidate5', 'policy', 'accepted', 'POLICY_ACCEPTED');
    observe('candidate5', 'ranking', 'observed', 'RANK_NOT_SELECTED');
    expect(ledger.sourceHealth({ limit: 10 })).toEqual([{
      hostname: 'news.example', source: 'news.example', candidateCount: 5,
      originalFetchVerified: 4, originalFetchFailed: 1, fetchVerificationRate: 0.8,
      missingPublishedAt: 1, futurePublishedAt: 1, outsidePublicationWindow: 0,
      policyAccepted: 2, policyRejected: 1, policyAcceptanceRate: 2 / 3,
      selected: 1, notSelected: 1, selectionRate: 0.5,
    }]);
    ledger.close();
  });

  it('counts the same candidate independently across runs in source-health rates', () => {
    const ledger = new NewsroomRunLedger({ path: ':memory:' });
    const identity = { candidateId: 'same-candidate', fetchedAt: '2026-07-14T11:00:00.000Z',
      hash: 'a'.repeat(64), source: 'news.example', hostname: 'news.example' };
    for (const reasonCode of ['ORIGINAL_FETCHED', 'ORIGINAL_FETCHED', 'ORIGINAL_FETCH_FAILED'] as const) {
      const runId = ledger.startRun({ windowHours: 24 });
      ledger.observe(runId, { ...identity, stage: 'original',
        outcome: reasonCode === 'ORIGINAL_FETCHED' ? 'accepted' : 'rejected', reasonCode });
    }
    expect(ledger.sourceHealth({ limit: 10 })[0]).toEqual(expect.objectContaining({
      originalFetchVerified: 2, originalFetchFailed: 1, fetchVerificationRate: 2 / 3,
    }));
    ledger.close();
  });

  it('returns a bounded timeline instead of failing when one candidate has more than sixteen observations', () => {
    const ledger = new NewsroomRunLedger({ path: ':memory:' });
    const runId = ledger.startRun({ windowHours: 24 });
    const identity = { candidateId: 'repeated-candidate', fetchedAt: '2026-07-14T11:00:00.000Z', hash: 'a'.repeat(64) };
    for (let index = 0; index < 17; index += 1) {
      ledger.observe(runId, { ...identity, stage: 'source', outcome: 'accepted', reasonCode: 'SOURCE_ALLOWED' });
    }
    expect(ledger.runSummary(runId).candidates[0].timeline).toHaveLength(17);
    ledger.close();
  });

  it('migrates with WAL/FK, stores only validated public metadata, and cascades fixed 24-hour retention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'run-ledger-'));
    const path = join(directory, 'ledger.sqlite');
    let now = new Date('2026-07-14T12:00:00.000Z');
    const ledger = new NewsroomRunLedger({ path, now: () => now });

    expect(ledger.pragmaState()).toEqual({ journalMode: 'wal', foreignKeys: true });
    const schemaReader = new DatabaseSync(path, { readOnly: true });
    const runColumns = schemaReader.prepare('PRAGMA table_info(research_runs)').all()
      .map((column) => String(column.name));
    const schemaVersion = Number((schemaReader.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version);
    schemaReader.close();
    expect(schemaVersion).toBe(1);
    expect(runColumns).not.toEqual(expect.arrayContaining(['topic_id', 'analysis_id', 'chat_id', 'owner_id']));
    const runId = ledger.startRun({ windowHours: 72 });
    ledger.observe(runId, {
      candidateId: 'candidate-1', fetchedAt: '2026-07-14T12:00:00.000Z', hash: 'b'.repeat(64),
      stage: 'source', outcome: 'accepted', reasonCode: 'SOURCE_ALLOWED',
      source: 'Meta', hostname: 'meta.com', canonicalUrl: 'https://meta.com/public-story',
    });
    expect(() => ledger.observe(runId, {
      stage: 'source', outcome: 'accepted', reasonCode: 'SOURCE_ALLOWED', source: 'Meta', hostname: 'meta.com',
      canonicalUrl: 'https://meta.com/public-story', articleBody: 'private body',
    } as never)).toThrow();
    ledger.finalizeRun(runId, { status: 'completed', reasonCode: 'COMPLETED', candidateCount: 1, selectedCount: 1 });
    expect(ledger.runSummary(runId)).toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'completed', candidateCount: 1 }),
    }));
    expect(ledger.sourceHealth({ limit: 10 })).toEqual([
      expect.objectContaining({ hostname: 'meta.com', candidateCount: 1, selected: 0, notSelected: 0, selectionRate: 0 }),
    ]);

    now = new Date(now.getTime() + RUN_LEDGER_RETENTION_MS + 1);
    expect(() => ledger.observe(runId, {
      candidateId: 'candidate-2', fetchedAt: now.toISOString(), hash: 'c'.repeat(64),
      stage: 'source', outcome: 'accepted', reasonCode: 'SOURCE_ALLOWED',
    })).toThrow();
    expect(ledger.recentRuns({ limit: 10 })).toEqual([]);
    expect(ledger.observationCount()).toBe(0);
    ledger.close();
  });

  it('reports normalized deterministic ranking components without changing ranking order', () => {
    const candidates: StoryCandidate[] = ['b', 'a'].map((id) => ({
      id, source: id, headline: `Headline ${id}`, body: 'Body', url: `https://${id}.example/story`,
      fetchedAt: '2026-07-14T12:00:00.000Z', publishedAt: '2026-07-14T11:00:00.000Z', status: 'pending',
    }));
    const before = rankStories(candidates);
    const window = { from: '2026-07-13T12:00:00.000Z', to: '2026-07-14T12:00:00.000Z' };
    const observations = before.map((story) => rankingComponents(story, window));
    expect(rankStories(candidates).map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    for (const observation of observations) {
      expect(observation).toEqual(expect.objectContaining({
        reasonCode: 'RANK_SELECTED',
        ranking: {
          sourceAuthority: expect.any(Number), policyRelevance: expect.any(Number),
          recency: expect.any(Number), bodyCompleteness: expect.any(Number),
          explanationCodes: expect.any(Array),
        },
      }));
      expect(Object.values(observation.ranking!).filter((value) => typeof value === 'number')
        .every((value) => value >= 0 && value <= 1)).toBe(true);
    }
    expect(JSON.stringify(observations)).not.toContain('Body');
  });

  it('strictly validates CLI limits and run IDs', () => {
    expect(parseRunLedgerCliArgs(['recent', '--limit', '25'])).toEqual({ command: 'recent', limit: 25 });
    expect(() => parseRunLedgerCliArgs(['recent', '--limit', '0'])).toThrow();
    expect(() => parseRunLedgerCliArgs(['run', '42 OR 1=1'])).toThrow();
  });

  it('returns fixed JSON error envelopes without reflecting invalid input or internal errors', () => {
    expect(executeRunLedgerCli(['recent', '--limit', 'private-value'])).toEqual({
      exitCode: 2, body: { ok: false, error: { code: 'INVALID_ARGUMENTS' } },
    });
    expect(JSON.stringify(executeRunLedgerCli(['run', 'secret']))).not.toContain('secret');
    expect(executeRunLedgerCli(['recent'], () => { throw new Error('database secret'); })).toEqual({
      exitCode: 1, body: { ok: false, error: { code: 'LEDGER_UNAVAILABLE' } },
    });
    expect(executeRunLedgerCli(['run', 'run_00000000-0000-4000-8000-000000000000'],
      () => new NewsroomRunLedger({ path: ':memory:' }))).toEqual({
      exitCode: 1, body: { ok: false, error: { code: 'RUN_NOT_FOUND' } },
    });
  });
});
