import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { BOT_COPY, WELCOME_MESSAGE } from './bot-copy.js';
import {
  runAnalysisFactGate, writeAnalysisBulletinScript, type AnalysisGenerator,
} from './analysis.js';
import { StoryCandidateSchema, type StoryCandidate } from './index.js';
import {
  LinkupEvidenceSchema, extractPublishedAt, gatherLinkupSearchEvidence,
  type LinkupResearchClient, type LinkupSearchResult,
} from './linkup.js';
import {
  EditionArtifactSchema, filterCandidatesByPublicationWindow, rankStories,
} from './pipeline.js';
import type { InlineKeyboardMarkup, TelegramClient, TelegramUpdate } from './telegram.js';
import { concise, DEFAULT_ELEVENLABS_VOICE_ID, EpisodeMetadataSchema, type VoiceSynthesizer } from './voice.js';
import type { SynthesizeOutcomeFunction, VoiceSynthesisOutcome } from './pocket-tts.js';
import { buildSearchQuery, composeSearchPolicy, filterBySearchPolicy, filterBySourceDomain } from './search-policy.js';
import { getOutputLanguage, OUTPUT_LANGUAGES, OUTPUT_LANGUAGE_VALUES, type OutputLanguage } from './languages.js';

export const TIME_RANGES = ['Past 24 Hours', 'Past 3 Days', 'Past 7 Days'] as const;
export type TimeRange = typeof TIME_RANGES[number];

export function resolvePublicationWindow(timeRange: TimeRange, now: Date): { from: string; to: string } {
  const days = timeRange === 'Past 24 Hours' ? 1 : timeRange === 'Past 3 Days' ? 3 : 7;
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() };
}

export const DELIVERY_MODES = ['Text Only', 'Text + Audio'] as const;
export type DeliveryMode = typeof DELIVERY_MODES[number];
export const DELIVERY_MODE_VALUES: Record<DeliveryMode, 'text_only' | 'text_and_audio'> = {
  'Text Only': 'text_only',
  'Text + Audio': 'text_and_audio',
};
export type DeliveryModeValue = 'text_only' | 'text_and_audio';
export const TOPIC_OPTIONS = ['AI Agents', 'AI Glasses', 'Claude Code', 'OpenAI API', 'AI x Blockchain', 'AI Travel'] as const;
export const ANGLE_OPTIONS = ['Startup Opportunities', 'Product Strategy', 'Technical Trends', 'Investment Signals'] as const;

const ChatStateSchema = z.object({
  step: z.enum(['topics', 'angles', 'range', 'language', 'delivery', 'confirm']),
  topics: z.string().min(1).optional(),
  analysisAngles: z.string().min(1).optional(),
  timeRange: z.enum(TIME_RANGES).optional(),
  deliveryMode: z.enum(['text_only', 'text_and_audio']).optional(),
  outputLanguage: z.enum(OUTPUT_LANGUAGE_VALUES).optional(),
  selectedTopics: z.array(z.enum(TOPIC_OPTIONS)).optional(),
  selectedAngles: z.array(z.enum(ANGLE_OPTIONS)).optional(),
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
      const state = StateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      for (const chat of Object.values(state.chats)) {
        if ((chat.step === 'delivery' || chat.step === 'confirm') && !chat.outputLanguage) chat.outputLanguage = 'english';
      }
      return state;
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
  deliveryMode: DeliveryModeValue;
  outputLanguage: OutputLanguage;
}

export function createResearchQuery(preferences: ResearchPreferences): string {
  return `Latest AI news about ${preferences.topics}. Focus analysis on ${preferences.analysisAngles}. Time range: ${preferences.timeRange}. Output language: ${getOutputLanguage(preferences.outputLanguage).label}. Return concrete, source-backed developments.`;
}

export function splitTelegramText(text: string, limit = 4_000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < limit / 2) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit / 2) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt < 1) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
const selectionKeyboard = (kind: 'topic' | 'angle', options: readonly string[]): InlineKeyboardMarkup => ({
  inline_keyboard: options.map((text, index) => [{ text, callback_data: `${kind}:${index}` }]),
});
const topicKeyboard = () => selectionKeyboard('topic', TOPIC_OPTIONS);
const angleKeyboard = () => selectionKeyboard('angle', ANGLE_OPTIONS);
const deliveryKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: BOT_COPY.textOnly, callback_data: 'delivery:text_only' }, { text: BOT_COPY.textAndAudio, callback_data: 'delivery:text_and_audio' }]],
};
const languageKeyboard: InlineKeyboardMarkup = {
  inline_keyboard: OUTPUT_LANGUAGES.map(({ label, value }) => [{ text: label, callback_data: `language:${value}` }]),
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
      await this.options.telegram.sendMessage(chatId, WELCOME_MESSAGE, topicKeyboard());
      return;
    }
    const chat = (await this.options.store.snapshot()).chats[chatId];
    if (!chat) {
      await this.options.store.setOffset(offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.expired);
      return;
    }
    if (chat.step === 'topics') {
      return this.rejectText(chatId, BOT_COPY.invalidTopics, offset, topicKeyboard());
    } else if (chat.step === 'angles') {
      return this.rejectText(chatId, BOT_COPY.invalidAngles, offset, angleKeyboard());
    } else if (chat.step === 'range') {
      if (!TIME_RANGES.includes(text as TimeRange)) return this.rejectText(chatId, BOT_COPY.invalidRange, offset);
      await this.options.store.updateChatAndOffset(chatId, { ...chat, step: 'language', timeRange: text as TimeRange }, offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.askLanguage, languageKeyboard);
    } else if (chat.step === 'language') {
      return this.rejectText(chatId, BOT_COPY.invalidLanguage, offset, languageKeyboard);
    } else if (chat.step === 'delivery') {
      if (!DELIVERY_MODES.includes(text as DeliveryMode)) return this.rejectText(chatId, BOT_COPY.invalidDelivery, offset);
      await this.confirm(chatId, { ...chat, step: 'confirm', deliveryMode: DELIVERY_MODE_VALUES[text as DeliveryMode] }, offset);
    } else {
      await this.options.store.setOffset(offset);
      await this.options.telegram.sendMessage(chatId, this.confirmation(chat as Required<ChatState>), generateKeyboard);
    }
  }

  private async rejectText(chatId: string, message: string, offset: number, keyboard?: InlineKeyboardMarkup): Promise<void> {
    await this.options.store.setOffset(offset);
    await this.options.telegram.sendMessage(chatId, message, keyboard);
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
    if (data?.startsWith('topic:')) {
      if (chat?.step !== 'topics') return this.rejectText(chatId, BOT_COPY.invalidTopics, offset, topicKeyboard());
      const match = /^topic:(\d+)$/.exec(data);
      const option = match ? TOPIC_OPTIONS[Number(match[1])] : undefined;
      if (!option) return this.rejectText(chatId, BOT_COPY.invalidTopics, offset, topicKeyboard());
      await this.options.store.updateChatAndOffset(chatId, { step: 'angles', topics: option }, offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.askAngles, angleKeyboard());
      return;
    }
    if (data?.startsWith('angle:')) {
      if (chat?.step !== 'angles') return this.rejectText(chatId, BOT_COPY.invalidAngles, offset, angleKeyboard());
      const match = /^angle:(\d+)$/.exec(data);
      const option = match ? ANGLE_OPTIONS[Number(match[1])] : undefined;
      if (!option) return this.rejectText(chatId, BOT_COPY.invalidAngles, offset, angleKeyboard());
      await this.options.store.updateChatAndOffset(chatId, { ...chat, step: 'range', analysisAngles: option }, offset);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.askRange, rangeKeyboard);
      return;
    }
    if (data?.startsWith('range:')) {
      const range = data.slice(6);
      if (chat?.step === 'range' && TIME_RANGES.includes(range as TimeRange)) {
        await this.options.store.updateChatAndOffset(chatId, { ...chat, step: 'language', timeRange: range as TimeRange }, offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.askLanguage, languageKeyboard);
      } else {
        await this.options.store.setOffset(offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.invalidRange);
      }
      return;
    }
    if (data?.startsWith('language:')) {
      const value = data.slice(9) as OutputLanguage;
      if (chat?.step === 'language' && OUTPUT_LANGUAGES.some((item) => item.value === value)) {
        await this.options.store.updateChatAndOffset(chatId, { ...chat, step: 'delivery', outputLanguage: value }, offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.askDelivery, deliveryKeyboard);
      } else {
        await this.options.store.setOffset(offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.invalidLanguage, languageKeyboard);
      }
      return;
    }
    if (data?.startsWith('delivery:')) {
      const value = data.slice(9);
      if (chat?.step === 'delivery' && (value === 'text_only' || value === 'text_and_audio')) {
        await this.confirm(chatId, { ...chat, step: 'confirm', deliveryMode: value as DeliveryModeValue }, offset);
      } else {
        await this.options.store.setOffset(offset);
        await this.options.telegram.sendMessage(chatId, BOT_COPY.invalidDelivery);
      }
      return;
    }
    await this.options.store.setOffset(offset);
    if (data !== 'generate_now') return;
    let effectiveChat = chat;
    if (chat?.step === 'confirm' && chat.topics && chat.analysisAngles && chat.timeRange && !chat.deliveryMode) {
      effectiveChat = { ...chat, deliveryMode: 'text_and_audio' };
      await this.options.store.setChat(chatId, effectiveChat);
    }
    if (!effectiveChat || effectiveChat.step !== 'confirm' || !effectiveChat.topics || !effectiveChat.analysisAngles || !effectiveChat.timeRange || !effectiveChat.deliveryMode || !effectiveChat.outputLanguage) {
      this.generating.delete(chatId);
      await this.options.telegram.sendMessage(chatId, BOT_COPY.expired);
      return;
    }
    await this.options.telegram.sendMessage(chatId, BOT_COPY.generating);
    void this.runGeneration(chatId, effectiveChat as ResearchPreferences & ChatState);
  }

  private async runGeneration(chatId: string, preferences: ResearchPreferences): Promise<void> {
    try {
      await this.options.generate(chatId, preferences);
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('No stories were published within')
        ? BOT_COPY.noRecentStories : error instanceof Error && error.message.startsWith('No stories matched')
          ? BOT_COPY.noPolicyStories : BOT_COPY.generationFailed;
      await this.options.telegram.sendMessage(chatId, message);
    } finally {
      this.generating.delete(chatId);
    }
  }

  private async confirm(chatId: string, chat: ChatState, offset: number): Promise<void> {
    await this.options.store.updateChatAndOffset(chatId, chat, offset);
    await this.options.telegram.sendMessage(chatId, this.confirmation(chat as Required<ChatState>), generateKeyboard);
  }

  private confirmation(chat: Required<ChatState>): string {
    const deliveryLabel = chat.deliveryMode === 'text_and_audio' ? 'Text + Audio' : 'Text Only';
    return `${BOT_COPY.confirmation}\n\nTopics: ${chat.topics}\nAnalysis Angles: ${chat.analysisAngles}\nNews Range: ${chat.timeRange}\nOutput Language: ${getOutputLanguage(chat.outputLanguage).label}\nDelivery: ${deliveryLabel}`;
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
    const now = (options.now ?? (() => new Date()))();
    const createdAt = now.toISOString();
    const publicationWindow = resolvePublicationWindow(preferences.timeRange, now);
    const searchPolicy = await composeSearchPolicy(preferences.topics, preferences.analysisAngles, publicationWindow);
    const searchQuery = buildSearchQuery(searchPolicy);
    const searchOptions = {
      ...publicationWindow,
      includeDomains: [...new Set(searchPolicy.activeSources.map(({ domain }) => domain))],
      excludeDomains: [...new Set(searchPolicy.excludedSources.map(({ domain }) => domain))],
    };
    const candidates = linkupResultsToCandidates(
      await options.linkup.search(searchQuery, searchOptions), createdAt,
    );
    const sourceReport = filterBySourceDomain(candidates, searchPolicy);
    const sourceEligible = new Set(sourceReport.eligibleIds);
    const fetchedOriginals = new Map<string, { markdown?: string; error?: string }>();
    const sourceCandidates = candidates.filter(({ id }) => sourceEligible.has(id));
    const datedCandidates = await Promise.all(sourceCandidates.map(async (candidate) => {
      try {
        const document = options.linkup.fetchDocument
          ? await options.linkup.fetchDocument(candidate.url!)
          : { markdown: await options.linkup.fetch(candidate.url!) };
        const { markdown } = document;
        fetchedOriginals.set(candidate.id, { markdown });
        const publishedAt = (document.rawHtml ? extractPublishedAt(document.rawHtml) : undefined)
          ?? extractPublishedAt(markdown);
        return { ...candidate, publishedAt };
      } catch (error) {
        fetchedOriginals.set(candidate.id, { error: error instanceof Error ? error.message : 'Original fetch failed' });
        return candidate;
      }
    }));
    const filterReport = filterCandidatesByPublicationWindow(datedCandidates, publicationWindow);
    const artifactsDirectory = options.artifactsDirectory ?? resolve(process.cwd(), 'artifacts');
    const policyReport = filterBySearchPolicy(candidates.map((candidate) => ({
      id: candidate.id, url: candidate.url, name: candidate.headline, content: candidate.body,
      original: fetchedOriginals.get(candidate.id)?.markdown,
    })), searchPolicy);
    await writeArtifacts(artifactsDirectory, {
      'search-policy.json': searchPolicy, 'search-policy-filter-report.json': policyReport,
      'story-candidates.json': datedCandidates, 'publication-filter-report.json': filterReport,
    });
    const policyEligible = new Set(policyReport.eligibleIds);
    const eligible = filterReport.eligible.filter(({ id }) => policyEligible.has(id));
    const policyRanking = new Map(policyReport.evaluated.filter(({ accepted }) => accepted).map((item) => [item.id, {
      sourceTier: item.sourceTier!, matchedTerms: [...item.matchedTopicTerms, ...item.matchedAnalysisTerms, ...item.matchedPreferredTerms],
    }]));
    const stories = rankStories(eligible, policyRanking);
    if (!stories.length) {
      if (sourceCandidates.length > 0 && !filterReport.eligible.length) throw new Error(`No stories were published within ${preferences.timeRange}. Please try a broader news range.`);
      throw new Error('No stories matched the selected topic and analysis policy. Please try another selection.');
    }
    const rundown = { id: `rundown-${createdAt}`, createdAt, stories };
    const searchedEvidence = await gatherLinkupSearchEvidence(stories, options.linkup, publicationWindow);
    const evidence = searchedEvidence.map((item) => {
      const fetched = fetchedOriginals.get(item.storyId);
      return LinkupEvidenceSchema.parse({
        ...item,
        original: { ...item.original, ...(fetched?.markdown?.trim() ? { markdown: fetched.markdown } : {}) },
        verificationStatus: fetched?.markdown?.trim() ? 'verified' : 'failed',
        errors: fetched?.error ? [...item.errors, fetched.error] : item.errors,
      });
    });
    const analysis = await options.analysisGenerator.generate({ preferences, stories, evidence });
    const factGate = runAnalysisFactGate(analysis, stories, evidence, createdAt, publicationWindow);
    const script = writeAnalysisBulletinScript(analysis, stories, createdAt, factGate.scriptStatus);
    const edition = EditionArtifactSchema.parse({
      id: `edition-${createdAt}`, createdAt, status: factGate.scriptStatus, rundownId: rundown.id,
      scriptId: script.id, factGateId: factGate.id, storyIds: stories.map(({ id }) => id),
    });
    await writeArtifacts(artifactsDirectory, {
      'search-policy.json': searchPolicy, 'search-policy-filter-report.json': policyReport,
      'story-candidates.json': datedCandidates, 'publication-filter-report.json': filterReport,
      'rundown.json': rundown, 'linkup-evidence.json': evidence,
      'llm-analysis.json': analysis, 'script.json': script, 'fact-gate.json': factGate, 'edition.json': edition,
    });
    if (!factGate.approved) throw new Error(`Fact Gate blocked the briefing: ${factGate.reasons.join('; ')}`);
    if (script.status !== 'ready_for_voice') throw new Error('Voice generation refused: script must be ready_for_voice and Fact Gate must be approved');

    const bulletin = script.segments.map(({ text }) => concise(text)).filter(Boolean).join('\n\n');
    const language = getOutputLanguage(preferences.outputLanguage);
    const title = analysis.title;
    const storyMetadata = stories.map(({ headline, source, canonicalUrl }) => ({
      headline, source, url: canonicalUrl,
    }));

    let outcome: VoiceSynthesisOutcome | undefined;
    if (preferences.deliveryMode === 'text_and_audio') {
      const withOutcome = options.synthesizer as (VoiceSynthesizer & Partial<SynthesizeOutcomeFunction>);
      if (withOutcome.synthesizeWithOutcome) {
        try {
          outcome = await withOutcome.synthesizeWithOutcome(bulletin, {
            language: language.ttsLanguage,
            voiceId: language.ttsVoice,
            provider: language.ttsProvider,
          });
        }
        catch { /* both TTS providers failed — fall through to text-only publication */ }
      } else {
        try {
          const audio = await options.synthesizer.synthesize(
            options.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
            bulletin,
            { language: language.ttsLanguage },
          );
          outcome = { audio, provider: 'elevenlabs', fallbackUsed: false };
        } catch { /* TTS failed — fall through to text-only publication */ }
      }
    }

    const episode = EpisodeMetadataSchema.parse({
      title, generatedAt: createdAt,
      audioUrl: outcome ? '/episodes/latest.mp3' : undefined,
      audioRequested: preferences.deliveryMode === 'text_and_audio', audioGenerated: !!outcome,
      provider: outcome?.provider, fallbackUsed: outcome?.fallbackUsed,
      outputLanguage: preferences.outputLanguage,
      stories: storyMetadata, factGate,
    });
    const updatedEdition = outcome
      ? EditionArtifactSchema.parse({ ...edition, status: 'voiced' })
      : edition;
    const episodesDirectory = options.episodesDirectory ?? resolve(process.cwd(), 'apps/web/public/episodes');
    await mkdir(episodesDirectory, { recursive: true });

    const audioOutcome = {
      audioRequested: preferences.deliveryMode === 'text_and_audio',
      audioGenerated: !!outcome,
      provider: outcome?.provider ?? null,
      fallbackUsed: outcome?.fallbackUsed ?? false,
      outputLanguage: preferences.outputLanguage,
    };
    const writes: Promise<void>[] = [
      writeFile(resolve(episodesDirectory, 'latest.json'), `${JSON.stringify(episode, null, 2)}\n`, 'utf8'),
      writeFile(resolve(artifactsDirectory, 'audio-outcome.json'), `${JSON.stringify(audioOutcome, null, 2)}\n`, 'utf8'),
      writeFile(resolve(artifactsDirectory, 'edition.json'), `${JSON.stringify(updatedEdition, null, 2)}\n`, 'utf8'),
    ];
    if (outcome) writes.unshift(writeFile(resolve(episodesDirectory, 'latest.mp3'), outcome.audio));
    await Promise.all(writes);

    if (outcome) {
      await options.telegram.publish({ chatId, metadata: episode, audio: outcome.audio });
    } else {
      const sources = storyMetadata.map((story, index) =>
        `${index + 1}. ${story.headline}\n${story.url}`).join('\n\n');
      const fallbackNote = preferences.deliveryMode === 'text_and_audio' ? `${BOT_COPY.audioUnavailable}\n\n` : '';
      const textBriefing = `${fallbackNote}${bulletin}\n\nSources\n${sources}`;
      for (const chunk of splitTelegramText(textBriefing)) {
        await options.telegram.sendMessage(chatId, chunk);
      }
    }
    await options.telegram.sendMessage(chatId, BOT_COPY.generationComplete);
  };
}

async function writeArtifacts(directory: string, artifacts: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(artifacts).map(([name, value]) =>
    writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')));
}
