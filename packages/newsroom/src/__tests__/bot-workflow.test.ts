import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotStateStore, NewsroomBot, createResearchQuery, linkupResultsToCandidates, splitTelegramText } from '../bot.js';
import type { LinkupSearchResult } from '../linkup.js';

const results: LinkupSearchResult[] = [{
  name: 'Agents ship new tools', url: 'https://news.example/a', content: 'A detailed report.', type: 'text',
}];

describe('topic-aware bot workflow', () => {
  it('splits long Telegram text below the platform limit without losing content', () => {
    const text = `${'word '.repeat(1_000)}\n\n${'source '.repeat(700)}`.trim();
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('builds a query from every stored preference and deterministically validates candidates', () => {
    const query = createResearchQuery({
      topics: 'AI Agents, Claude Code', analysisAngles: 'Product Strategy', timeRange: 'Past 3 Days',
      deliveryMode: 'text_and_audio',
    });
    expect(query).toContain('AI Agents, Claude Code');
    expect(query).toContain('Product Strategy');
    expect(query).toContain('Past 3 Days');

    const candidates = linkupResultsToCandidates(results, '2026-07-11T12:00:00.000Z');
    expect(candidates).toEqual([expect.objectContaining({
      id: expect.any(String), source: 'news.example', headline: 'Agents ship new tools',
      body: 'A detailed report.', url: 'https://news.example/a', fetchedAt: '2026-07-11T12:00:00.000Z',
      status: 'pending',
    })]);
    expect(linkupResultsToCandidates(results, '2026-07-11T12:00:00.000Z')).toEqual(candidates);
  });

  it('persists the conversation including delivery mode and resets it with /start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-bot-'));
    const path = join(directory, 'bot-state.json');
    const store = new BotStateStore(path);
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue(1), answerCallbackQuery: vi.fn(), publish: vi.fn(),
    };
    const bot = new NewsroomBot({ store, telegram, generate: vi.fn() });

    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/start' } });
    const callback = (update_id: number, data: string) => bot.handleUpdate({ update_id, callback_query: { id: `cb-${update_id}`, data, message: { chat: { id: 42 } } } });
    await callback(2, 'topic:0');
    await callback(3, 'topic:5');
    await callback(4, 'topic:done');
    await callback(5, 'angle:0');
    await callback(6, 'angle:done');
    await callback(7, 'range:Past 7 Days');
    await callback(8, 'delivery:text_and_audio');

    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining(
      'Topics: AI Agents, AI Travel\nAnalysis Angles: Startup Opportunities\nNews Range: Past 7 Days',
    ), expect.any(Object));
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      offset: 9, chats: { '42': { step: 'confirm', topics: 'AI Agents, AI Travel', deliveryMode: 'text_and_audio' } },
    });

    await bot.handleUpdate({ update_id: 9, message: { chat: { id: 42 }, text: '/start' } });
    expect((await store.snapshot()).chats['42']).toEqual({ step: 'topics', selectedTopics: [] });
  });

  it('acknowledges Generate Now immediately and prevents duplicate generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-bot-'));
    const store = new BotStateStore(join(directory, 'state.json'));
    await store.setChat('42', {
      step: 'confirm', topics: 'AI Agents', analysisAngles: 'Technical Trends', timeRange: 'Past 24 Hours', deliveryMode: 'text_and_audio',
    });
    let release!: () => void;
    const generate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const telegram = { sendMessage: vi.fn().mockResolvedValue(1), answerCallbackQuery: vi.fn(), publish: vi.fn() };
    const bot = new NewsroomBot({ store, telegram, generate });
    const update = { update_id: 9, callback_query: { id: 'cb', data: 'generate_now', message: { chat: { id: 42 } } } };

    const first = bot.handleUpdate(update);
    await vi.waitFor(() => expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('cb'));
    const second = bot.handleUpdate({ ...update, update_id: 10, callback_query: { ...update.callback_query, id: 'cb2' } });
    await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledWith('42', expect.stringContaining('already')));
    release();
    await Promise.all([first, second]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
