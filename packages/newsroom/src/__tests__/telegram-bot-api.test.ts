import { describe, expect, it, vi } from 'vitest';
import { TelegramClient, type TelegramFetch } from '../telegram.js';

describe('Telegram bot APIs', () => {
  it('gets updates, sends messages, and answers callbacks with JSON requests', async () => {
    const fetch = vi.fn<TelegramFetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: [{ update_id: 9 }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 10 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }));
    const client = new TelegramClient({ token: 'secret', fetch });

    await expect(client.getUpdates(8, 30)).resolves.toEqual([{ update_id: 9 }]);
    await expect(client.sendMessage('42', 'Hello', { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] }))
      .resolves.toBe(10);
    await expect(client.answerCallbackQuery('callback-1')).resolves.toBeUndefined();

    expect(fetch.mock.calls.map((call: Parameters<TelegramFetch>) => call[0])).toEqual([
      'https://api.telegram.org/botsecret/getUpdates',
      'https://api.telegram.org/botsecret/sendMessage',
      'https://api.telegram.org/botsecret/answerCallbackQuery',
    ]);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ offset: 8, timeout: 30 });
  });

  it('redacts the bot token from transport failures', async () => {
    const client = new TelegramClient({
      token: 'top-secret',
      fetch: async () => { throw new Error('failed at /bottop-secret/getUpdates'); },
    });
    const error = await client.getUpdates(0).catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected getUpdates to fail');
    expect(error.message).not.toContain('top-secret');
    expect(error.message).toContain('[REDACTED]');
  });
});
