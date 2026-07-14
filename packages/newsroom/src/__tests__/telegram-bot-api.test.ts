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

  it('downloads an uploaded file, edits progress, and delivers a private MP3', async () => {
    const fetch = vi.fn<TelegramFetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: 'documents/file_1.txt' } }))
      .mockResolvedValueOnce(new Response('Exact text'))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 12 } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 13 } }));
    const client = new TelegramClient({ token: 'secret', fetch });
    await expect(client.downloadFile('file-id')).resolves.toEqual(new TextEncoder().encode('Exact text'));
    await expect(client.editMessage('42', 10, 'Generating audio…')).resolves.toBe(12);
    await expect(client.sendPrivateAudio('42', new Uint8Array([0x49, 0x44, 0x33, 1]), 'notes.mp3', 'Private · Translation Off')).resolves.toBe(13);
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.telegram.org/botsecret/getFile',
      'https://api.telegram.org/file/botsecret/documents/file_1.txt',
      'https://api.telegram.org/botsecret/editMessageText',
      'https://api.telegram.org/botsecret/sendAudio',
    ]);
    const audioBody = fetch.mock.calls[3][1]?.body as FormData;
    expect(audioBody.get('audio')).toBeInstanceOf(Blob);
    expect(audioBody.get('caption')).toBe('Private · Translation Off');
  });

  it('cancels a chunked download immediately when cumulative bytes exceed 5 MB', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(3_000_000)); controller.enqueue(new Uint8Array(2_000_001)); },
      cancel: cancelled,
    });
    const fetch = vi.fn<TelegramFetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: 'documents/large.txt' } }))
      .mockResolvedValueOnce(new Response(body));
    const client = new TelegramClient({ token: 'secret', fetch });
    await expect(client.downloadFile('large')).rejects.toThrow('maximum size');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
    expect((fetch.mock.calls[1][1]?.signal as AbortSignal).aborted).toBe(true);
  });
});
