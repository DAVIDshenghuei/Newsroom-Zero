import { describe, expect, it } from 'vitest';
import { BOT_COPY, WELCOME_MESSAGE } from '../bot-copy.js';

describe('bot copy', () => {
  it('uses the exact English welcome message', () => {
    expect(WELCOME_MESSAGE).toBe(
      'Welcome to Newsroom Zero.\n\n' +
      'I search the latest AI news, analyze trends, and turn them into actionable insights.\n\n' +
      'What AI topics should I research? Send comma-separated topics or free text.\n' +
      'Examples: AI Agents, AI Glasses, Claude Code, OpenAI API, AI x Blockchain, AI Travel',
    );
  });

  it('contains no CJK characters in any exported UI copy', () => {
    expect(Object.values(BOT_COPY).join('\n')).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u);
  });
});
