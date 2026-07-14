import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { NewsroomRunLedger } from './run-ledger.js';

const LimitSchema = z.coerce.number().int().min(1).max(100);
const RunIdSchema = z.string().regex(/^run_[0-9a-f-]{36}$/);
export type RunLedgerCliArgs =
  | { command: 'recent' | 'sources'; limit: number }
  | { command: 'run'; runId: string };

export function parseRunLedgerCliArgs(args: string[]): RunLedgerCliArgs {
  if (args[0] === 'run' && args.length === 2) return { command: 'run', runId: RunIdSchema.parse(args[1]) };
  if ((args[0] === 'recent' || args[0] === 'sources') && (args.length === 1 || (args.length === 3 && args[1] === '--limit'))) {
    return { command: args[0], limit: LimitSchema.parse(args[2] ?? 20) };
  }
  throw new Error('Usage: newsroom:ledger recent|sources [--limit 1..100] | run <run_id>');
}

export function queryRunLedger(ledger: NewsroomRunLedger, args: RunLedgerCliArgs): unknown {
  if (args.command === 'run') return ledger.runSummary(args.runId);
  if (args.command === 'recent') return ledger.recentRuns({ limit: args.limit });
  return ledger.sourceHealth({ limit: args.limit });
}

type CliBody = { ok: true; data: unknown } | { ok: false; error: { code: 'INVALID_ARGUMENTS' | 'LEDGER_UNAVAILABLE' | 'RUN_NOT_FOUND' | 'QUERY_FAILED' } };
export function executeRunLedgerCli(
  args: string[],
  openLedger: () => NewsroomRunLedger = () => new NewsroomRunLedger({ path: resolve(process.cwd(), 'artifacts/newsroom-ledger.sqlite') }),
): { exitCode: number; body: CliBody } {
  let parsed: RunLedgerCliArgs;
  try { parsed = parseRunLedgerCliArgs(args); }
  catch { return { exitCode: 2, body: { ok: false, error: { code: 'INVALID_ARGUMENTS' } } }; }
  let ledger: NewsroomRunLedger;
  try { ledger = openLedger(); }
  catch { return { exitCode: 1, body: { ok: false, error: { code: 'LEDGER_UNAVAILABLE' } } }; }
  try {
    const data = queryRunLedger(ledger, parsed);
    if (parsed.command === 'run' && (data as { run?: unknown }).run === null) {
      return { exitCode: 1, body: { ok: false, error: { code: 'RUN_NOT_FOUND' } } };
    }
    return { exitCode: 0, body: { ok: true, data } };
  }
  catch { return { exitCode: 1, body: { ok: false, error: { code: 'QUERY_FAILED' } } }; }
  finally { try { ledger.close(); } catch { /* fixed JSON result remains authoritative */ } }
}

export function main(args = process.argv.slice(2)): void {
  const result = executeRunLedgerCli(args);
  process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
