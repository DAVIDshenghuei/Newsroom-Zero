import { describe, expect, it, vi } from 'vitest';
import { FallbackVoiceSynthesizer, PocketTtsClient } from '../pocket-tts.js';

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

describe('PocketTtsClient', () => {
  it('posts authenticated JSON and returns an MP3', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
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
});

describe('FallbackVoiceSynthesizer', () => {
  it('uses Pocket first and skips ElevenLabs on success', async () => {
    const primary = { synthesize: vi.fn().mockResolvedValue(mp3) };
    const fallback = { synthesize: vi.fn() };
    const result = await new FallbackVoiceSynthesizer({ primary, fallback, primaryVoiceId: 'alba', fallbackVoiceId: 'eleven' }).synthesizeWithOutcome('Briefing');
    expect(result).toEqual({ audio: mp3, provider: 'pocket-tts', fallbackUsed: false });
    expect(fallback.synthesize).not.toHaveBeenCalled();
  });

  it('uses ElevenLabs only after Pocket fails', async () => {
    const primary = { synthesize: vi.fn().mockRejectedValue(new Error('down')) };
    const fallback = { synthesize: vi.fn().mockResolvedValue(mp3) };
    const result = await new FallbackVoiceSynthesizer({ primary, fallback, primaryVoiceId: 'alba', fallbackVoiceId: 'eleven' }).synthesizeWithOutcome('Briefing');
    expect(result).toEqual({ audio: mp3, provider: 'elevenlabs', fallbackUsed: true });
  });
});
