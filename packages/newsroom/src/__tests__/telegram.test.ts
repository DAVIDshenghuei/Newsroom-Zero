import { describe, expect, it, vi } from 'vitest';
import { TelegramClient, type TelegramFetch } from '../telegram.js';

const metadata = {
  title: 'News & <Today>',
  factGate: { approved: true },
  stories: [
    { source: 'Wire & Co', url: 'https://example.com/story?a=1&b=2' },
    { headline: 'Second <source>', url: 'https://example.org/second' },
  ],
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

describe('TelegramClient', () => {
  it('publishes an MP3 as multipart audio and returns the Telegram message id', async () => {
    const fetch = vi.fn<TelegramFetch>().mockResolvedValue(Response.json({
      ok: true,
      result: { message_id: 314 },
    }));

    await expect(new TelegramClient({ token: 'top-secret', fetch }).publish({
      chatId: '-100123', metadata, audio: mp3,
    })).resolves.toBe(314);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottop-secret/sendAudio');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
    const body = init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('-100123');
    expect(body.get('title')).toBe('News & <Today>');
    expect(body.get('parse_mode')).toBe('HTML');
    expect(body.get('caption')).toBe(
      '<b>News &amp; &lt;Today&gt;</b>\n✅ Fact Gate approved\n\nSources:\n' +
      '• <a href="https://example.com/story?a=1&amp;b=2">Wire &amp; Co</a>\n' +
      '• <a href="https://example.org/second">Second &lt;source&gt;</a>',
    );
    const audio = body.get('audio') as Blob;
    expect(audio).toBeInstanceOf(Blob);
    expect(audio.type).toBe('audio/mpeg');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(mp3);
  });

  it('accepts an MPEG frame header', async () => {
    const fetch: TelegramFetch = async () => Response.json({ ok: true, result: { message_id: 1 } });
    await expect(new TelegramClient({ token: 'secret', fetch }).publish({
      chatId: 'chat', metadata, audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
    })).resolves.toBe(1);
  });

  it('refuses publication unless the Fact Gate approved it', async () => {
    const fetch = vi.fn<TelegramFetch>();
    await expect(new TelegramClient({ token: 'secret', fetch }).publish({
      chatId: 'chat', metadata: { ...metadata, factGate: { approved: false } }, audio: mp3,
    })).rejects.toThrow('Fact Gate approval is required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses bytes without an ID3 or MPEG frame signature', async () => {
    const fetch = vi.fn<TelegramFetch>();
    await expect(new TelegramClient({ token: 'secret', fetch }).publish({
      chatId: 'chat', metadata, audio: new Uint8Array([1, 2, 3, 4]),
    })).rejects.toThrow('Audio is not an MP3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-success HTTP responses without exposing the token', async () => {
    const fetch: TelegramFetch = async () => new Response('gateway error', { status: 502 });
    const error = await new TelegramClient({ token: 'top-secret', fetch }).publish({
      chatId: 'chat', metadata, audio: mp3,
    }).catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected Telegram publication to fail');
    expect(error.message).toContain('Telegram request failed (502)');
    expect(error.message).not.toContain('top-secret');
  });

  it('rejects Telegram ok=false responses without exposing the token', async () => {
    const fetch: TelegramFetch = async () => Response.json({ ok: false, description: 'chat not found' });
    const error = await new TelegramClient({ token: 'top-secret', fetch }).publish({
      chatId: 'chat', metadata, audio: mp3,
    }).catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected Telegram publication to fail');
    expect(error.message).toBe('Telegram rejected publication: chat not found');
    expect(error.message).not.toContain('top-secret');
  });
});
