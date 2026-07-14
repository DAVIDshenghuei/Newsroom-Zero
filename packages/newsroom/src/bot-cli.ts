import { resolve } from 'node:path';
import { NewsroomBot, BotStateStore, createBriefingGenerator } from './bot.js';
import { CodexAnalysisGenerator } from './codex-analysis.js';
import { ElevenLabsClient } from './elevenlabs.js';
import { LinkupClient } from './linkup.js';
import { TelegramClient } from './telegram.js';
import { DEFAULT_ELEVENLABS_VOICE_ID, type VoiceSynthesizer } from './voice.js';
import { FallbackVoiceSynthesizer, PocketTtsClient } from './pocket-tts.js';
import { DocumentVoiceRepository, DocumentVoiceService } from './document-voice.js';
import { DocumentVoiceTelegramFlow } from './document-telegram.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main(): Promise<void> {
  const telegram = new TelegramClient({ token: required('TELEGRAM_BOT_TOKEN') });
  const linkup = new LinkupClient({ apiKey: required('LINKUP_API_KEY') });
  const elevenlabsKey = process.env.ELEVENLABS_API_KEY;
  const elevenlabs = elevenlabsKey ? new ElevenLabsClient({ apiKey: elevenlabsKey }) : undefined;
  const analysisGenerator = new CodexAnalysisGenerator({
    model: process.env.CODEX_ANALYSIS_MODEL || 'gpt-5.6-sol',
    entrypoint: process.env.CODEX_CLI_ENTRYPOINT || undefined,
    timeoutMs: Number(process.env.CODEX_ANALYSIS_TIMEOUT_MS || 300_000),
  });

  let synthesizer: VoiceSynthesizer;
  let pocket: PocketTtsClient | undefined;
  const unavailable: VoiceSynthesizer = { synthesize: async () => { throw new Error('No TTS provider is configured'); } };
  const pocketBaseUrl = process.env.POCKET_TTS_BASE_URL;
  if (pocketBaseUrl) {
    pocket = new PocketTtsClient({
      baseUrl: pocketBaseUrl,
      apiKey: process.env.POCKET_TTS_API_KEY,
      language: process.env.POCKET_TTS_LANGUAGE,
      timeoutMs: process.env.POCKET_TTS_TIMEOUT_MS ? Number(process.env.POCKET_TTS_TIMEOUT_MS) : undefined,
    });
    synthesizer = new FallbackVoiceSynthesizer({
      primary: pocket, fallback: elevenlabs,
      primaryVoiceId: process.env.POCKET_TTS_VOICE || 'alba',
      fallbackVoiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
    });
  } else {
    synthesizer = elevenlabs ?? unavailable;
  }

  const store = new BotStateStore(resolve(process.cwd(), 'artifacts/bot-state.json'));
  const documentRepository = new DocumentVoiceRepository({
    root: resolve(process.cwd(), 'artifacts/document-voice-jobs'),
    emit: (event) => { console.log(JSON.stringify({ type: 'document_voice_event', ...event })); },
  });
  let documentVoice: DocumentVoiceTelegramFlow | undefined;
  if (pocketBaseUrl) {
    try {
      const documentPocket = new PocketTtsClient({
        baseUrl: pocketBaseUrl, apiKey: process.env.POCKET_TTS_API_KEY,
        language: process.env.POCKET_TTS_LANGUAGE,
        timeoutMs: process.env.POCKET_TTS_TIMEOUT_MS ? Number(process.env.POCKET_TTS_TIMEOUT_MS) : undefined,
        loopbackOnly: true,
      });
      const documentSynthesizer = new FallbackVoiceSynthesizer({ primary: documentPocket, primaryVoiceId: process.env.POCKET_TTS_VOICE || 'alba' });
      documentVoice = new DocumentVoiceTelegramFlow({
        repository: documentRepository,
        service: new DocumentVoiceService({ repository: documentRepository, synthesizer: documentSynthesizer }), telegram,
      });
    } catch { console.error('Document Voice disabled: local TTS endpoint is invalid.'); }
  }
  const bot = new NewsroomBot({
    store, telegram, documentVoice,
    generate: createBriefingGenerator({
      telegram, linkup, analysisGenerator, synthesizer,
      voiceId: process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
    }),
  });
  await documentRepository.cleanupExpired();
  await documentVoice?.recover();
  const cleanupTimer = setInterval(() => {
    void documentRepository.cleanupExpired().catch(() => console.error('Document job cleanup failed'));
  }, 60_000);
  cleanupTimer.unref();
  let running = true;
  process.once('SIGINT', () => { running = false; });
  process.once('SIGTERM', () => { running = false; });
  console.log('AI Newsroom Studio Telegram bot is polling for updates.');
  while (running) {
    try {
      const { offset } = await store.snapshot();
      const updates = await telegram.getUpdates(offset, 30);
      for (const update of updates) await bot.handleUpdate(update);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Bot polling failed');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  clearInterval(cleanupTimer);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bot startup failed');
  process.exitCode = 1;
});
