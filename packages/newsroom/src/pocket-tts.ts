import type { VoiceSynthesizer } from './voice.js';

export type LocalAudioProvider = 'pocket-tts' | 'kokoro';
export type AudioProvider = LocalAudioProvider | 'elevenlabs';
export interface VoiceSynthesisOutcome { audio: Uint8Array; provider: AudioProvider; fallbackUsed: boolean }
export type PocketTtsFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SynthesizeOutcomeFunction {
  synthesizeWithOutcome(text: string, options?: { language?: string; voiceId?: string; provider?: LocalAudioProvider }): Promise<VoiceSynthesisOutcome>;
}

export interface PocketTtsOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: PocketTtsFetch;
  language?: string;
  timeoutMs?: number;
}

const isMp3 = (bytes: Uint8Array): boolean =>
  (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
  || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);

export class PocketTtsClient implements VoiceSynthesizer {
  private readonly baseUrl: string;
  private readonly fetch: PocketTtsFetch;
  constructor(private readonly options: PocketTtsOptions) {
    if (!options.baseUrl.trim()) throw new Error('POCKET_TTS_BASE_URL is required');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async synthesize(voiceId: string, text: string, callOptions?: { language?: string }): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ text, voice: voiceId || 'alba', language: callOptions?.language ?? this.options.language ?? 'english', format: 'mp3' }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      });
    } catch {
      throw new Error('Pocket TTS request failed');
    }
    if (!response.ok) throw new Error(`Pocket TTS request failed (${response.status})`);
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('audio/mpeg')) {
      throw new Error('Pocket TTS returned an unsupported content type');
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (!isMp3(audio)) throw new Error('Pocket TTS returned invalid MP3 audio');
    return audio;
  }
}

export interface FallbackVoiceOptions {
  primary: VoiceSynthesizer;
  fallback?: VoiceSynthesizer;
  primaryVoiceId?: string;
  fallbackVoiceId?: string;
}

export class FallbackVoiceSynthesizer implements VoiceSynthesizer {
  constructor(private readonly options: FallbackVoiceOptions) {}
  /** VoiceSynthesizer interface: ignores voiceId (IDs are in constructor options). */
  async synthesize(_voiceId: string, text: string): Promise<Uint8Array> {
    const result = await this.synthesizeWithOutcome(text);
    return result.audio;
  }
  /** Returns enriched outcome with provider and fallbackUsed metadata. */
  async synthesizeWithOutcome(text: string, callOptions?: { language?: string; voiceId?: string; provider?: LocalAudioProvider }): Promise<VoiceSynthesisOutcome> {
    try {
      return {
        audio: await this.options.primary.synthesize(callOptions?.voiceId ?? this.options.primaryVoiceId ?? 'alba', text, callOptions?.language ? { language: callOptions.language } : undefined),
        provider: callOptions?.provider ?? 'pocket-tts', fallbackUsed: false,
      };
    } catch (primaryError) {
      if (!this.options.fallback) throw primaryError;
      return {
        audio: await this.options.fallback.synthesize(this.options.fallbackVoiceId ?? '', text),
        provider: 'elevenlabs', fallbackUsed: true,
      };
    }
  }
}
