import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { BOT_COPY, WELCOME_MESSAGE } from './bot-copy.js';
import {
  runAnalysisFactGate, writeAnalysisBulletinScript, type AnalysisGenerator,
} from './analysis.js';
import { StoryCandidateSchema, type StoryCandidate } from './index.js';
import { type LinkupResearchClient, type LinkupSearchResult, gatherLinkupEvidence } from './linkup.js';
import {
  EditionArtifactSchema, rankStories,
} from './pipeline.js';
import type { InlineKeyboardMarkup, TelegramClient, TelegramUpdate } from './telegram.js';
import { createVoiceEpisode, DEFAULT_ELEVENLABS_VOICE_ID, type VoiceSynthesizer } from './voice.js';

export const TIME_RANGES = ['Past 24 Hours', 'Past 3 Days', 'Past 7 Days'] as const;
export type TimeRange = typeof TIME_RANGES[number];

const ChatStateSchema = z.object({
  step: z.enum(['topics', 'angles', 'range', 'confirm']),
  topics: z.string().min(1).optional(),
  analysisAngles: z.string().min(1).optional(),
  timeRange: z.enum(TIME_RANGES).optional(),
});
export type ChatState = z.infer<typeof ChatStateSchema>;

const StateSchema = z.object({
  offset: z.number().int().nonnegative(),
  chats: z.record(ChatStateSchema),
});
type PersistedState = z.infer<typeof StateSchema>;

/** A serialized, atomic JSON state store safe against overlapping update handlers. */
export class BotStateStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<PersistedState> {
    try {
      return StateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { offset: 0, chats: {} };
      throw error;
    }
  }

  private async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }

  private mutate<T>(work: (state: PersistedState) => T | Promise<T>): Promise<T> {
    const result = this.operation.then(async () => {
      const state = await this.read();
      const value = await work(state);
      await this.write(state);
      return value;
    });
    this.operation = result.catch(() => undefined);
    return result;
  }

  async snapshot(): Promise<PersistedState> {
    await this.operation;
    return this.read();
  }

  async setChat(chatId: string, chat: ChatState): Promise<void> {
    await this.mutate((state) => { state.chats[chatId] = ChatStateSchema.parse(chat); });
  }

  async setOffset(offset: number): Promise<void> {
    await this.mutate((state) => { state.offset = Math.max(state.offset, offset); });
  }

  async updateChatAndOffset(chatId: string, chat: ChatState, offset: number): Promise<void> {
    await this.mutate((state) => {
      state.chats[chatId] = ChatStateSchema.parse(chat);
      state.offset = Math.max(state.offset, offset);
    });
  }
}

export interface ResearchPreferences {
  topics: string;
  analysisAngles: string;
  timeRange: TimeRange;
}

export function createResearchQuery(preferences: ResearchPreferences): string {
  return `Latest AI news about ${preferences.topics}. Focus analysis on ${preferences.analysisAngles}. Time range: ${preferences.timeRange}. Return concrete, source-backed developments in English only.`;
}

export function linkupResultsToCandidates(results: LinkupSearchResult[], fetchedAt: string): StoryCandidate[] {
  return results.map((result) => {
    const url = new URL(result.url);
    return StoryCandidateSchema.parse({
      id: `linkup-${createHash('sha256').update(`${result.url}\n${result.name}`).digest('hex').slice(0, 20)}`,
      source: url.hostname.replace(/^www\./, ''), headline: result.name.trim(), body: result.content.trim(),
      url: result.url, fetchedAt, status: 'pending',
    });
  });
}

interface BotTelegram {
  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<number>;
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
  publish: TelegramClient['publish'];
}

export interface NewsroomBotOptions {
  store: BotStateStore;
  telegram: BotTelegram;
  generate: (chatId: string, preferences: ResearchPreferences) => Promise<void>;
}

const rangeKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: TIME_RANGES.map((text) => [{ text, callback_data: `range:${text}` }]),
};
const generateKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: BOT_COPY.generateNow, callback_data: 'generate_now' }]],
};
const cleanText = (value?: string): string => value?.replace(/\s+/g, ' ').trim() ?? '';

export class NewsroomBot {
  private readonly generating = new Set<string>();
  constructor(private readonly options: NewsroomBotOptions) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chatIdValue = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatIdValue === undefined) {
      await this.options.store.setOffset(update.update_id + 1);
      return;
    }
    const chatId = String(chatIdValue);
    const offset = update.update_id + 1;

    if (update.callback_query) {
      await this.handleCallback(chatId, update.callback_query.id, update.callback_query.data, offset);
      return;
    }

    const text = cleanText(update.message?.text);
    if (text === '/start' || text.startsWith('/start ')) {
      await this.options.store.updateChatAndOffset(chatId, { step: 'topics' }, offset);
      await this.options.telegram.sendMessage(chatId, WELCOME_MESSAGE);
      return;
    }
    const chat = (await this.options.store.snapshot()).chats[chatId];
    if (!chat) {
      await this.options.store.setOffset(offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.expired);
      return;
    }
    if (chat.step === 'topics') {
      if (!text || text.startsWith('/')) return this.rejectText(chatId, BOT_COPY.invalidTopics, offset);
      await this.options.store.updateChatAndOffset(chatId, { step: 'angles', topics: text }, offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.askAngles);
    } else if (chat.step === 'angles') {
      if (!text || text.startsWith('/')) return this.rejectText(chatId, BOT_COPY.invalidAngles, offset);
      await this.options.store.updateChatAndOffset(chatId, { ...chat, step: 'range', analysisAngles: text }, offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.askRange, rangeKeyboard);
    } else if (chat.step === 'range') {
      if (!TIME_RANGES.includes(text as TimeRange)) return this.rejectText(chatId, BOT_COPY.invalidRange, offset);
      await this.confirm(chatId, { ...chat, step: 'confirm', timeRange: text as TimeRange }, offset);
    } else {
      await this.options.store.setOffset(offset);
      await this.options.telegram.sendMessage(chatId, this.confirmation(chat as Required<ChatState>), generateKeyboard);
    }
  }

  private async rejectText(chatId: string, message: string, offset: number): Promise<void> {
    await this.options.store.setOffset(offset);
    await this.options.telegram.sendMessage(chatId, message);
  }

  private async handleCallback(chatId: string, callbackId: string, data: string | undefined, offset: number): Promise<void> {
    await this.options.telegram.answerCallbackQuery(callbackId);
    if (data === 'generate_now' && this.generating.has(chatId)) {
      await this.options.store.setOffset(offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.alreadyGenerating);
      return;
    }
    if (data === 'generate_now') this.generating.add(chatId);
    const chat = (await this.options.store.snapshot()).chats[chatId];
    if (data?.startsWith('range:')) {
      const range = data.slice(6);
      if (chat?.step === 'range' && TIME_RANGES.includes(range as TimeRange)) {
        await this.confirm(chatId, { ...chat, step: 'confirm', timeRange: range as TimeRange }, offset);
      } else {
        await this.options.store.setOffset(offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.invalidRange);
      }
      return;
    }
    await this.options.store.setOffset(offset);
    if (data !== 'generate_now') return;
    if (!chat || chat.step !== 'confirm' || !chat.topics || !chat.analysisAngles || !chat.timeRange) {
      this.generating.delete(chatId);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.expired);
      return;
    }
    await this.options.telegram.sendMessage(chatId, BOT_COPY.generating);
    void this.runGeneration(chatId, chat as ResearchPreferences & ChatState);
  }

  private async runGeneration(chatId: string, preferences: ResearchPreferences): Promise<void> {
    try {
      await this.options.generate(chatId, preferences);
    } catch {
      await this.options.telegram.sendMessage(chatId, BOT_COPY.generationFailed);
    } finally {
      this.generating.delete(chatId);
    }
  }

  private async confirm(chatId: string, chat: ChatState, offset: number): Promise<void> {
    await this.options.store.updateChatAndOffset(chatId, chat, offset);
    await this.options.telegram.sendMessage(chatId, this.confirmation(chat as Required<ChatState>), generateKeyboard);
  }

  private confirmation(chat: Required<ChatState>): string {
    return `${BOT_COPY.confirmation}\n\nTopics: ${chat.topics}\nAnalysis Angles: ${chat.analysisAngles}\nNews Range: ${chat.timeRange}`;
  }
}

export interface GeneratorOptions {
  linkup: LinkupResearchClient;
  analysisGenerator: AnalysisGenerator;
  synthesizer: VoiceSynthesizer;
  telegram: Pick<BotTelegram, 'publish' | 'sendMessage'>;
  artifactsDirectory?: string;
  episodesDirectory?: string;
  voiceId?: string;
  now?: () => Date;
}

export function createBriefingGenerator(options: GeneratorOptions) {
  return async (chatId: string, preferences: ResearchPreferences): Promise<void> => {
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const candidates = linkupResultsToCandidates(await options.linkup.search(createResearchQuery(preferences)), createdAt);
    const stories = rankStories(candidates);
    if (!stories.length) throw new Error('No usable stories were returned');
    const rundown = { id: `rundown-${createdAt}`, createdAt, stories };
    const evidence = await gatherLinkupEvidence(stories, options.linkup);
    const analysis = await options.analysisGenerator.generate({ preferences, stories, evidence });
    const factGate = runAnalysisFactGate(analysis, stories, evidence, createdAt);
    const script = writeAnalysisBulletinScript(analysis, stories, createdAt, factGate.scriptStatus);
    const edition = EditionArtifactSchema.parse({
      id: `edition-${createdAt}`, createdAt, status: factGate.scriptStatus, rundownId: rundown.id,
      scriptId: script.id, factGateId: factGate.id, storyIds: stories.map(({ id }) => id),
    });
    const artifactsDirectory = options.artifactsDirectory ?? resolve(process.cwd(), 'artifacts');
    await writeArtifacts(artifactsDirectory, {
      'story-candidates.json': candidates, 'rundown.json': rundown, 'linkup-evidence.json': evidence,
      'llm-analysis.json': analysis, 'script.json': script, 'fact-gate.json': factGate, 'edition.json': edition,
    });
    if (!factGate.approved) throw new Error(`Fact Gate blocked the briefing: ${factGate.reasons.join('; ')}`);
    const output = await createVoiceEpisode({
      script, factGate, rundown, edition, synthesizer: options.synthesizer,
      voiceId: options.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID, generatedAt: createdAt,
      title: `${analysis.title} — ${preferences.analysisAngles}`,
    });
    const episodesDirectory = options.episodesDirectory ?? resolve(process.cwd(), 'apps/web/public/episodes');
    await mkdir(episodesDirectory, { recursive: true });
    await Promise.all([
      writeFile(resolve(episodesDirectory, 'latest.mp3'), output.audio),
      writeFile(resolve(episodesDirectory, 'latest.json'), `${JSON.stringify(output.episode, null, 2)}\n`, 'utf8'),
      writeFile(resolve(artifactsDirectory, 'edition.json'), `${JSON.stringify(output.edition, null, 2)}\n`, 'utf8'),
    ]);
    await options.telegram.publish({ chatId, metadata: output.episode, audio: output.audio });
    await options.telegram.sendMessage(chatId, BOT_COPY.generationComplete);
  };
}

async function writeArtifacts(directory: string, artifacts: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(artifacts).map(([name, value]) =>
    writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')));
}
