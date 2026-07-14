import { describe, expect, it, vi } from 'vitest';
import { FallbackVoiceSynthesizer, PocketTtsClient, validateLoopbackTtsBaseUrl } from '../pocket-tts.js';

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

describe('PocketTtsClient', () => {
  it.each(['http://127.0.0.1:8001', 'http://localhost:80', 'http://[::1]:9000'])('accepts an explicit loopback document endpoint: %s', (url) => {
    expect(validateLoopbackTtsBaseUrl(url)).toBe(url);
  });

  it.each(['https://127.0.0.1:8001', 'http://127.0.0.1', 'http://192.168.1.2:8001', 'http://10.0.0.2:8001', 'http://8.8.8.8:8001', 'http://user:pass@localhost:8001', 'not-a-url'])('rejects a non-loopback document endpoint: %s', (url) => {
    expect(() => validateLoopbackTtsBaseUrl(url)).toThrow('DOCUMENT_TTS_BASE_URL_INVALID');
  });

  it('rejects redirects for a loopback-only document client', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://example.com' } }));
    const client = new PocketTtsClient({ baseUrl: 'http://127.0.0.1:8001', fetch, loopbackOnly: true });
    await expect(client.synthesize('alba', 'Secret')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
  });
  it('combines a caller abort signal with the request timeout signal', async () => {
    const caller = new AbortController();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      caller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('Aborted', 'AbortError');
    });
    const client = new PocketTtsClient({ baseUrl: 'https://tts.test', fetch });
    await expect(client.synthesize('alba', 'Hello', { signal: caller.signal })).rejects.toThrow('Pocket TTS request failed');
  });
  it('posts authenticated JSON and returns an MP3', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
    const client = new PocketTtsClient({ baseUrl: 'https://tts.test/', apiKey: 'secret', fetch });
    await expect(client.synthesize('alba', 'Hello')).resolves.toEqual(mp3);
    expect(fetch).toHaveBeenCalledWith('https://tts.test/v1/audio/speech', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: 'Hello', voice: 'alba', language: 'english', format: 'mp3' }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects invalid audio and never exposes its secret', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('failed secret'));
    const error = await new PocketTtsClient({ baseUrl: 'https://tts.test', apiKey: 'secret', fetch }).synthesize('alba', 'Hello').catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected Pocket TTS to fail');
    expect(error.message).toBe('Pocket TTS request failed');
    expect(error.message).not.toContain('secret');
  });

  it('uses a per-call language override without mutating configured defaults', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
    const client = new PocketTtsClient({ baseUrl: 'https://tts.test', language: 'english', fetch });
    await client.synthesize('estelle', 'Bonjour', { language: 'french_24l' });
    await client.synthesize('alba', 'Hello');
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({ voice: 'estelle', language: 'french_24l' });
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toMatchObject({ voice: 'alba', language: 'english' });
  });
});

describe('FallbackVoiceSynthesizer', () => {
  it('passes the caller abort signal through and never falls back after cancellation', async () => {
    const controller = new AbortController();
    const primary = { synthesize: vi.fn(async (_voice: string, _text: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBe(controller.signal);
      throw new DOMException('Aborted', 'AbortError');
    }) };
    const fallback = { synthesize: vi.fn() };
    controller.abort();
    await expect(new FallbackVoiceSynthesizer({ primary, fallback }).synthesize('ignored', 'Briefing', { signal: controller.signal })).rejects.toThrow();
    expect(fallback.synthesize).not.toHaveBeenCalled();
  });
  it('uses Pocket first and skips ElevenLabs on success', async () => {
    const primary = { synthesize: vi.fn().mockResolvedValue(mp3) };
    const fallback = { synthesize: vi.fn() };
    const result = await new FallbackVoiceSynthesizer({ primary, fallback, primaryVoiceId: 'alba', fallbackVoiceId: 'eleven' }).synthesizeWithOutcome('Briefing');
    expect(result).toEqual({ audio: mp3, provider: 'pocket-tts', fallbackUsed: false });
    expect(fallback.synthesize).not.toHaveBeenCalled();
  });

  it('records Kokoro as the primary provider for Traditional Chinese', async () => {
    const primary = { synthesize: vi.fn().mockResolvedValue(mp3) };
    const result = await new FallbackVoiceSynthesizer({ primary, primaryVoiceId: 'alba' })
      .synthesizeWithOutcome('繁體中文新聞', {
        language: 'chinese_traditional', voiceId: 'zf_xiaoxiao', provider: 'kokoro',
      });
    expect(result).toEqual({ audio: mp3, provider: 'kokoro', fallbackUsed: false });
    expect(primary.synthesize).toHaveBeenCalledWith(
      'zf_xiaoxiao', '繁體中文新聞', { language: 'chinese_traditional' },
    );
  });

  it('uses ElevenLabs only after the local provider fails', async () => {
    const primary = { synthesize: vi.fn().mockRejectedValue(new Error('down')) };
    const fallback = { synthesize: vi.fn().mockResolvedValue(mp3) };
    const result = await new FallbackVoiceSynthesizer({ primary, fallback, primaryVoiceId: 'alba', fallbackVoiceId: 'eleven' })
      .synthesizeWithOutcome('繁體中文新聞', {
        language: 'chinese_traditional', voiceId: 'zf_xiaoxiao', provider: 'kokoro',
      });
    expect(result).toEqual({ audio: mp3, provider: 'elevenlabs', fallbackUsed: true });
  });

  it('selects the catalog primary voice and language while leaving fallback multilingual auto-language', async () => {
    const primary = { synthesize: vi.fn().mockRejectedValue(new Error('down')) };
    const fallback = { synthesize: vi.fn().mockResolvedValue(mp3) };
    await new FallbackVoiceSynthesizer({ primary, fallback, fallbackVoiceId: 'eleven' })
      .synthesizeWithOutcome('Bonjour', { language: 'french_24l', voiceId: 'estelle' });
    expect(primary.synthesize).toHaveBeenCalledWith('estelle', 'Bonjour', { language: 'french_24l' });
    expect(fallback.synthesize).toHaveBeenCalledWith('eleven', 'Bonjour');
  });
});
