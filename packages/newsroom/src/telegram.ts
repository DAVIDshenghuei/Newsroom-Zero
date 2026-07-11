export type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TelegramEpisodeMetadata {
  title: string;
  factGate: { approved: boolean };
  stories: Array<{ source?: string; headline?: string; url: string }>;
}

export interface TelegramClientOptions {
  token: string;
  fetch?: TelegramFetch;
  baseUrl?: string;
}

export interface TelegramPublication {
  chatId: string;
  metadata: TelegramEpisodeMetadata;
  audio: Uint8Array;
}

const isMp3 = (bytes: Uint8Array): boolean =>
  (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
  || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export function createTelegramCaption(metadata: TelegramEpisodeMetadata): string {
  const sources = metadata.stories.map((story) => {
    const label = story.source || story.headline || story.url;
    return `• <a href="${escapeHtml(story.url)}">${escapeHtml(label)}</a>`;
  });
  return [
    `<b>${escapeHtml(metadata.title)}</b>`,
    '✅ Fact Gate approved',
    ...(sources.length ? ['', 'Sources:', ...sources] : []),
  ].join('\n');
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetch: TelegramFetch;
  private readonly baseUrl: string;

  constructor(options: TelegramClientOptions) {
    if (!options.token.trim()) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  }

  async publish(publication: TelegramPublication): Promise<number> {
    if (!publication.metadata.factGate.approved) {
      throw new Error('Fact Gate approval is required for Telegram publication');
    }
    if (!isMp3(publication.audio)) {
      throw new Error('Audio is not an MP3 (expected ID3 or MPEG frame signature)');
    }
    if (!publication.chatId.trim()) throw new Error('TELEGRAM_CHAT_ID is required');

    const bytes = publication.audio.slice().buffer;
    const body = new FormData();
    body.set('chat_id', publication.chatId);
    body.set('audio', new Blob([bytes], { type: 'audio/mpeg' }), 'latest.mp3');
    body.set('title', publication.metadata.title);
    body.set('caption', createTelegramCaption(publication.metadata));
    body.set('parse_mode', 'HTML');

    const response = await this.fetch(`${this.baseUrl}/bot${this.token}/sendAudio`, {
      method: 'POST',
      body,
    });
    if (!response.ok) throw new Error(`Telegram request failed (${response.status})`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Telegram returned an invalid JSON response');
    }
    if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) {
      const description = payload && typeof payload === 'object' && 'description' in payload
        && typeof payload.description === 'string' ? `: ${payload.description}` : '';
      throw new Error(`Telegram rejected publication${description}`);
    }
    const result = 'result' in payload ? payload.result : undefined;
    const messageId = result && typeof result === 'object' && 'message_id' in result
      ? result.message_id : undefined;
    if (typeof messageId !== 'number') throw new Error('Telegram response did not include a message_id');
    return messageId;
  }
}
