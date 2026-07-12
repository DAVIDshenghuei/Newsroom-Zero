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

  it('includes delivery mode options', () => {
    expect(BOT_COPY.askDelivery).toContain('How would you like');
    expect(BOT_COPY.textOnly).toMatch(/text\s*only/i);
    expect(BOT_COPY.textAndAudio).toMatch(/text.*audio|audio.*text/i);
  });

  it('includes audio-unavailable fallback message', () => {
    expect(BOT_COPY.audioUnavailable).toMatch(/audio.*unavailable|unable.*audio|text.*briefing/i);
  });

  it('contains no CJK characters in any exported UI copy', () => {
    expect(Object.values(BOT_COPY).join('\n')).not.toMatch(/[぀-ヿ㐀-鿿豈-﫿]/u);
  });
});
