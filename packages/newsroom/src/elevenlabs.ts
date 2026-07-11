export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ElevenLabsClientOptions {
  apiKey: string;
  fetch?: Fetch;
  baseUrl?: string;
}

const isMp3 = (bytes: Uint8Array): boolean =>
  (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
  || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly baseUrl: string;

  constructor(options: ElevenLabsClientOptions) {
    if (!options.apiKey.trim()) throw new Error('ELEVENLABS_API_KEY is required');
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io';
  }

  async synthesize(voiceId: string, text: string): Promise<Uint8Array> {
    if (!voiceId.trim()) throw new Error('An ElevenLabs voice ID is required');
    if (!text.trim()) throw new Error('Text-to-speech input cannot be empty');

    const response = await this.fetch(
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`ElevenLabs request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!contentType.includes('audio/mpeg') || !isMp3(bytes)) {
      throw new Error(`Expected an MP3 response from ElevenLabs, received ${contentType || 'unknown content type'}`);
    }
    return bytes;
  }
}
