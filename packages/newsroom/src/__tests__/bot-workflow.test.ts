import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotStateStore, NewsroomBot, createResearchQuery, linkupResultsToCandidates, resolvePublicationWindow, splitTelegramText } from '../bot.js';
import type { LinkupSearchResult } from '../linkup.js';

const results: LinkupSearchResult[] = [{
  name: 'Agents ship new tools', url: 'https://news.example/a', content: 'A detailed report.', type: 'text',
}];

describe('topic-aware bot workflow', () => {
  it.each([
    ['Past 24 Hours', '2026-07-10T12:34:56.000Z'],
    ['Past 3 Days', '2026-07-08T12:34:56.000Z'],
    ['Past 7 Days', '2026-07-04T12:34:56.000Z'],
  ] as const)('resolves %s to an exact UTC publication window', (range, from) => {
    expect(resolvePublicationWindow(range, new Date('2026-07-11T12:34:56.000Z'))).toEqual({
      from, to: '2026-07-11T12:34:56.000Z',
    });
  });
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

  it('single-selects topic and angle, advances once per tap, and confirms their values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-bot-'));
    const path = join(directory, 'bot-state.json');
    const store = new BotStateStore(path);
    const telegram = {
      sendMessage: vi.fn().mockResolvedValue(1), answerCallbackQuery: vi.fn(), publish: vi.fn(),
    };
    const bot = new NewsroomBot({ store, telegram, generate: vi.fn() });

    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/start' } });
    const topicMarkup = telegram.sendMessage.mock.calls[0]?.[2];
    expect(topicMarkup.inline_keyboard.flat()).toHaveLength(6);
    expect(topicMarkup.inline_keyboard.flat().map((button: { text: string; callback_data: string }) => button.text)).toEqual([
      'AI Agents', 'AI Glasses', 'Claude Code', 'OpenAI API', 'AI x Blockchain', 'AI Travel',
    ]);
    expect(JSON.stringify(topicMarkup)).not.toMatch(/done|âœ…|â¬œ/i);

    const callback = (update_id: number, data: string) => bot.handleUpdate({ update_id, callback_query: { id: `cb-${update_id}`, data, message: { chat: { id: 42 } } } });
    await callback(2, 'topic:0');
    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', 'Choose an analysis angle:', expect.any(Object));
    const angleMarkup = telegram.sendMessage.mock.calls[1]?.[2];
    expect(angleMarkup.inline_keyboard.flat()).toHaveLength(4);
    expect(JSON.stringify(angleMarkup)).not.toMatch(/done|âœ…|â¬œ/i);

    await callback(3, 'angle:1');
    expect(telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', 'Choose a news range:', expect.any(Object));
    await callback(4, 'range:Past 7 Days');
    await callback(5, 'delivery:text_and_audio');

    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining(
      'Topics: AI Agents\nAnalysis Angles: Product Strategy\nNews Range: Past 7 Days',
    ), expect.any(Object));
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      offset: 6, chats: { '42': { step: 'confirm', topics: 'AI Agents', analysisAngles: 'Product Strategy', deliveryMode: 'text_and_audio' } },
    });

    await bot.handleUpdate({ update_id: 6, message: { chat: { id: 42 }, text: '/start' } });
    expect((await store.snapshot()).chats['42']).toEqual({ step: 'topics' });
  });

  it('keeps invalid and stale selection callbacks safe without advancing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-bot-'));
    const store = new BotStateStore(join(directory, 'state.json'));
    const telegram = { sendMessage: vi.fn().mockResolvedValue(1), answerCallbackQuery: vi.fn(), publish: vi.fn() };
    const bot = new NewsroomBot({ store, telegram, generate: vi.fn() });
    const callback = (update_id: number, data: string) => bot.handleUpdate({ update_id, callback_query: { id: `cb-${update_id}`, data, message: { chat: { id: 42 } } } });

    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/start' } });
    await callback(2, 'topic:99');
    expect((await store.snapshot()).chats['42'].step).toBe('topics');
    await callback(3, 'topic:0');
    await callback(4, 'topic:1');
    expect((await store.snapshot()).chats['42']).toMatchObject({ step: 'angles', topics: 'AI Agents' });
    await callback(5, 'angle:done');
    expect((await store.snapshot()).chats['42'].step).toBe('angles');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(4);
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

  it('reports a useful English message when the strict window has no stories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-bot-'));
    const store = new BotStateStore(join(directory, 'state.json'));
    await store.setChat('42', {
      step: 'confirm', topics: 'AI Agents', analysisAngles: 'Technical Trends', timeRange: 'Past 24 Hours', deliveryMode: 'text_only',
    });
    const telegram = { sendMessage: vi.fn().mockResolvedValue(1), answerCallbackQuery: vi.fn(), publish: vi.fn() };
    const bot = new NewsroomBot({
      store, telegram,
      generate: vi.fn().mockRejectedValue(new Error('No stories were published within Past 24 Hours. Please try a broader news range.')),
    });
    await bot.handleUpdate({ update_id: 11, callback_query: { id: 'cb', data: 'generate_now', message: { chat: { id: 42 } } } });
    await vi.waitFor(() => expect(telegram.sendMessage).toHaveBeenCalledWith('42', expect.stringContaining('broader news range')));
  });
});
