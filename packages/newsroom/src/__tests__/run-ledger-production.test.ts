import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production Run Ledger wiring', () => {
  it('opens the artifacts ledger and exposes the root operator command', async () => {
    const [bot, rootPackage, readme] = await Promise.all([
      readFile(resolve(process.cwd(), 'packages/newsroom/src/bot-cli.ts'), 'utf8'),
      readFile(resolve(process.cwd(), 'package.json'), 'utf8'),
      readFile(resolve(process.cwd(), 'README.md'), 'utf8'),
    ]);
    expect(bot).toContain("artifacts/newsroom-ledger.sqlite");
    expect(bot).toContain('ledger,');
    expect(bot).toContain('ledger?.cleanupExpired()');
    expect(bot).toContain('[RunLedger] OPEN_FAILED');
    expect(bot).toContain('[RunLedger] CLEANUP_FAILED');
    expect(bot).toContain('[RunLedger] CLOSE_FAILED');
    expect(JSON.parse(rootPackage).scripts['newsroom:ledger']).toContain('run-ledger-cli.js');
    expect(readme).toContain('Newsroom Run Ledger');
    expect(readme).toContain('24 hours');
  });
});
