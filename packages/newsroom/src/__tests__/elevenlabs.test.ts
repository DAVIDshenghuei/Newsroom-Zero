import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsClient, type Fetch } from '../elevenlabs.js';

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

describe('ElevenLabsClient', () => {
  it('posts multilingual text-to-speech with the API key and returns MP3 bytes', async () => {
    const fetch = vi.fn<Fetch>().mockResolvedValue(new Response(mp3.buffer, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }));
    const client = new ElevenLabsClient({ apiKey: 'secret', fetch });

    await expect(client.synthesize('voice/id', 'Today in the newsroom.')).resolves.toEqual(mp3);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': 'secret',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'Today in the newsroom.',
      model_id: 'eleven_multilingual_v2',
    });
  });

  it('rejects a successful response that is not an MP3', async () => {
    const fetch: Fetch = async () => new Response('not audio', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    await expect(new ElevenLabsClient({ apiKey: 'secret', fetch }).synthesize('voice', 'News'))
      .rejects.toThrow('Expected an MP3 response');
  });

  it('surfaces the service error without treating it as audio', async () => {
    const fetch: Fetch = async () => new Response('{"detail":"quota exceeded"}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    await expect(new ElevenLabsClient({ apiKey: 'secret', fetch }).synthesize('voice', 'News'))
      .rejects.toThrow('ElevenLabs request failed (429)');
  });
});
