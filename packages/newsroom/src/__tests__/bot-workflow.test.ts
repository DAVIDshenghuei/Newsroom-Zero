import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotStateStore, NewsroomBot, createResearchQuery, linkupResultsToCandidates } from '../bot.js';
import type { LinkupSearchResult } from '../linkup.js';

const results: LinkupSearchResult[] = [{
  name: 'Agents ship new tools', url: 'https://news.example/a', content: 'A detailed report.', type: 'text',
}];

describe('topic-aware bot workflow', () => {
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
    await bot.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: 'AI Agents, AI Travel' } });
    await bot.handleUpdate({ update_id: 3, message: { chat: { id: 42 }, text: 'Startup Opportunities' } });
    await bot.handleUpdate({ update_id: 4, message: { chat: { id: 42 }, text: 'Past 7 Days' } });
    await bot.handleUpdate({ update_id: 5, message: { chat: { id: 42 }, text: 'Text + Audio' } });

    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining(
      'Topics: AI Agents, AI Travel\nAnalysis Angles: Startup Opportunities\nNews Range: Past 7 Days',
    ), expect.any(Object));
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      offset: 6, chats: { '42': { step: 'confirm', topics: 'AI Agents, AI Travel', deliveryMode: 'text_and_audio' } },
    });

    await bot.handleUpdate({ update_id: 6, message: { chat: { id: 42 }, text: '/start' } });
    expect((await store.snapshot()).chats['42']).toEqual({ step: 'topics' });
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
