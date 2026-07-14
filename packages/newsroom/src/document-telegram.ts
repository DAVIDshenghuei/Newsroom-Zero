import { randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  DOCUMENT_MAX_BYTES, DocumentVoiceError, DocumentVoiceJobSchema, DocumentVoiceRepository, DocumentVoiceService,
  type DocumentVoiceJob, type DocumentVoiceLanguage,
} from './document-voice.js';
import type { InlineKeyboardMarkup, TelegramUpdate } from './telegram.js';

interface DocumentTelegram {
  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup, signal?: AbortSignal): Promise<number>;
  editMessage(chatId: string, messageId: number, text: string): Promise<number>;
  downloadFile(fileId: string, maximumBytes?: number): Promise<Uint8Array>;
  sendPrivateAudio(chatId: string, audio: Uint8Array, filename: string, caption: string, signal?: AbortSignal): Promise<number>;
}

export interface DocumentTelegramContext {
  chatId: string;
  userId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  messageId?: number;
}
type TelegramDocument = NonNullable<NonNullable<TelegramUpdate['message']>['document']>;
type Session = { chatId: string; userId: string; nonce: string; jobId?: string; language?: DocumentVoiceLanguage; actionMessageId?: number };
export const TELEGRAM_DOCUMENT_AUDIO_MAX_BYTES = 45_000_000;
export const DOCUMENT_QUEUE_MAX_JOBS = 5;
export const DOCUMENT_PROGRESS_RETRY_DELAY_MS = 500;
export const DOCUMENT_UNKNOWN_NOTIFICATION_TIMEOUT_MS = 5_000;
export const DOCUMENT_DELIVERY_TIMEOUT_MS = 300_000;
class AsyncMutex {
  private tail = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
export interface DocumentQueueTask { jobId: string; ownerSubject: string; language: DocumentVoiceLanguage }
export class DocumentVoiceWorkQueue {
  private readonly tasks: DocumentQueueTask[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private activeJobId?: string;
  private readonly cancelled = new Set<string>();
  private readonly activeCancellation = new Map<string, () => void>();
  private reservations = 0;
  private capacityWaiters: Array<() => void> = [];
  private completionWaiters = new Map<string, Array<() => void>>();
  constructor(private readonly worker: (task: DocumentQueueTask) => Promise<void>, private readonly maximumJobs = DOCUMENT_QUEUE_MAX_JOBS, private readonly onWorkerError?: (error: unknown, task: DocumentQueueTask) => void | Promise<void>) {}
  reserve(): void {
    if (this.size() >= this.maximumJobs) throw new DocumentVoiceError('QUEUE_FULL');
    this.reservations += 1;
  }
  releaseReservation(): void { if (this.reservations > 0) this.reservations -= 1; this.notifyCapacity(); }
  async enqueue(task: DocumentQueueTask, reserved = false): Promise<void> {
    if (reserved) { if (this.reservations < 1) throw new DocumentVoiceError('QUEUE_FULL'); this.reservations -= 1; }
    else if (this.size() >= this.maximumJobs) throw new DocumentVoiceError('QUEUE_FULL');
    this.tasks.push(task);
    void this.drain();
  }
  registerActiveCancellation(jobId: string, cancel: () => void): void {
    if (this.activeJobId === jobId) this.activeCancellation.set(jobId, cancel);
  }
  async waitForIdle(): Promise<void> {
    if (!this.running && !this.tasks.length) return;
    await new Promise<void>((resolveIdle) => this.idleWaiters.push(resolveIdle));
  }
  cancel(jobId: string): boolean {
    const index = this.tasks.findIndex((task) => task.jobId === jobId);
    if (index >= 0) { this.tasks.splice(index, 1); this.notifyCapacity(); return true; }
    if (this.activeJobId === jobId) { this.cancelled.add(jobId); this.activeCancellation.get(jobId)?.(); return true; }
    return false;
  }
  async cancelAndWait(jobId: string): Promise<boolean> {
    const running = this.activeJobId === jobId;
    const cancelled = this.cancel(jobId);
    if (!cancelled || !running) return cancelled;
    await new Promise<void>((resolve) => {
      const waiters = this.completionWaiters.get(jobId) ?? [];
      waiters.push(resolve); this.completionWaiters.set(jobId, waiters);
    });
    return true;
  }
  async waitForCompletion(jobId: string): Promise<void> {
    if (this.activeJobId !== jobId) return;
    await new Promise<void>((resolve) => {
      const waiters = this.completionWaiters.get(jobId) ?? [];
      waiters.push(resolve); this.completionWaiters.set(jobId, waiters);
    });
  }
  isCancelled(jobId: string): boolean { return this.cancelled.has(jobId); }
  isRunning(jobId: string): boolean { return this.activeJobId === jobId; }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length) {
        const task = this.tasks.shift()!;
        this.activeJobId = task.jobId;
        try { if (!this.cancelled.has(task.jobId)) await this.worker(task); }
        catch (error) { try { await this.onWorkerError?.(error, task); } catch { /* Error reporting must not escape detached drain. */ } }
        finally {
          this.activeCancellation.delete(task.jobId);
          this.cancelled.delete(task.jobId);
          this.activeJobId = undefined;
          for (const resolve of this.completionWaiters.get(task.jobId) ?? []) resolve();
          this.completionWaiters.delete(task.jobId);
          this.notifyCapacity();
        }
      }
    } finally {
      this.running = false;
      for (const resolveIdle of this.idleWaiters.splice(0)) resolveIdle();
    }
  }
  private size(): number { return this.tasks.length + (this.running ? 1 : 0) + this.reservations; }
  async waitForCapacity(): Promise<void> {
    if (this.size() < this.maximumJobs) return;
    await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
  }
  private notifyCapacity(): void {
    if (this.size() >= this.maximumJobs) return;
    for (const resolve of this.capacityWaiters.splice(0)) resolve();
  }
}
const languageLabels: Record<DocumentVoiceLanguage, string> = { english: 'English', chinese_traditional: 'Traditional Chinese' };
const languageKeyboard = (nonce: string): InlineKeyboardMarkup => ({ inline_keyboard: [
  [{ text: 'English', callback_data: `dv:${nonce}:lang:en` }],
  [{ text: 'Traditional Chinese', callback_data: `dv:${nonce}:lang:zh` }],
] });
const confirmationKeyboard = (nonce: string): InlineKeyboardMarkup => ({ inline_keyboard: [
  [{ text: 'Generate Voice', callback_data: `dv:${nonce}:generate` }],
  [{ text: 'Change Language', callback_data: `dv:${nonce}:change` }, { text: 'Cancel', callback_data: `dv:${nonce}:cancel` }],
] });
const retryDeliveryKeyboard = (nonce: string): InlineKeyboardMarkup => ({ inline_keyboard: [[
  { text: 'Retry Delivery', callback_data: `dv:${nonce}:retry` },
]] });
const cancelKeyboard = (nonce: string): InlineKeyboardMarkup => ({ inline_keyboard: [[{ text: 'Cancel', callback_data: `dv:${nonce}:cancel` }]] });

export class DocumentVoiceTelegramFlow {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: DocumentVoiceWorkQueue;
  private recovery?: Promise<void>;
  private readonly jobLocks = new Map<string, AsyncMutex>();
  constructor(private readonly options: { repository: DocumentVoiceRepository; service: DocumentVoiceService; telegram: DocumentTelegram; queue?: DocumentVoiceWorkQueue; progressDelay?: () => Promise<void>; beforeDeliveryTransition?: () => Promise<void>; deliveryTimeoutMs?: number }) {
    this.queue = options.queue ?? new DocumentVoiceWorkQueue((task) => this.processQueued(task), DOCUMENT_QUEUE_MAX_JOBS, async (_error, _task) => {
      await this.options.repository.recordEvent('worker_failed', { errorCode: 'WORKER_FAILED' });
    });
  }
  async waitForIdle(): Promise<void> { await this.recovery; await this.queue.waitForIdle(); }
  async recover(): Promise<void> {
    const persisted = await this.options.repository.list();
    for (const job of persisted.filter((candidate) => candidate.status === 'generating' && candidate.synthesis)) {
      await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...job, status: 'queued', synthesis: { ...job.synthesis!, completedChunks: 0, provider: undefined, durationSeconds: undefined } }));
    }
    const unknownJobs = persisted.filter((candidate) => ['delivering', 'delivery_unknown'].includes(candidate.status) && candidate.synthesis);
    for (const job of unknownJobs) {
      if (job.status === 'delivering') await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...job, status: 'delivery_unknown', error: { code: 'DELIVERY_STATUS_UNKNOWN' } }));
    }
    const jobs = (await this.options.repository.list())
      .filter((job) => ['queued', 'generated', 'delivery_failed'].includes(job.status) && job.synthesis)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    this.recovery = (async () => {
      for (const job of jobs) {
        await this.queue.waitForCapacity();
        await this.queue.enqueue({ jobId: job.id, ownerSubject: job.owner.subject, language: job.synthesis!.ttsLanguage });
      }
    })();
    for (const job of unknownJobs) void this.notifyUnknown(job);
  }

  private async notifyUnknown(job: DocumentVoiceJob): Promise<void> {
    const nonce = randomBytes(8).toString('hex');
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      const send = this.options.telegram.sendMessage(job.owner.subject, 'Audio delivery status is unknown after restart. It will not be sent again automatically. Retry only if you want another delivery attempt.', retryDeliveryKeyboard(nonce), controller.signal);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('UNKNOWN_NOTIFICATION_TIMEOUT')); }, DOCUMENT_UNKNOWN_NOTIFICATION_TIMEOUT_MS);
      });
      const messageId = await Promise.race([send, deadline]);
      this.sessions.set(job.owner.subject, { chatId: job.owner.subject, userId: job.owner.subject, nonce, jobId: job.id, language: job.synthesis!.ttsLanguage, actionMessageId: messageId });
    } catch { /* Persisted delivery_unknown remains safe and is retried after re-entry/restart. */ }
    finally { clearTimeout(timeout); }
  }

  async begin(context: DocumentTelegramContext): Promise<void> {
    if (context.chatType !== 'private') throw new DocumentVoiceError('PRIVATE_CHAT_REQUIRED');
    const existing = (await this.options.repository.list()).find((job) => job.owner.subject === context.userId && !['delivered', 'failed', 'cancelled', 'expired'].includes(job.status));
    const nonce = randomBytes(8).toString('hex');
    const session: Session = { chatId: context.chatId, userId: context.userId, nonce, jobId: existing?.id, language: existing?.synthesis?.ttsLanguage };
    this.sessions.set(context.userId, session);
    await this.options.repository.recordEvent('document_flow_started', { channel: 'telegram' });
    if (existing) {
      let text = 'Your document is ready for language selection.';
      let controls = languageKeyboard(nonce);
      if (['queued', 'generating'].includes(existing.status)) { text = 'Your document conversion is queued or generating. You can cancel it safely before delivery starts.'; controls = cancelKeyboard(nonce); }
      if (['generated', 'delivery_failed'].includes(existing.status)) { text = 'Your audio is ready. Retry Delivery will reuse it without generating again.'; controls = retryDeliveryKeyboard(nonce); }
      if (existing.status === 'delivery_unknown') { text = 'Audio delivery status is unknown. It will not be sent again automatically.'; controls = retryDeliveryKeyboard(nonce); }
      if (existing.status === 'delivering') { text = 'Audio delivery has started and can no longer be safely cancelled.'; controls = { inline_keyboard: [] }; }
      session.actionMessageId = await this.options.telegram.sendMessage(context.chatId, text, controls);
      return;
    }
    await this.options.telegram.sendMessage(context.chatId, 'Upload a TXT or Markdown document (maximum 5 MB and 10,000 extracted characters).');
  }

  isActive(userId: string): boolean { return this.sessions.has(userId); }

  async handleDocument(context: DocumentTelegramContext, document: TelegramDocument): Promise<void> {
    const session = this.authorizedSession(context);
    if (!session) return;
    const name = basename(document.file_name ?? 'document');
    if (!['.txt', '.md'].includes(extname(name).toLowerCase())) {
      await this.options.telegram.sendMessage(context.chatId, 'This file type is not supported. Upload TXT or Markdown.'); return;
    }
    if ((document.file_size ?? 0) > DOCUMENT_MAX_BYTES) {
      await this.options.telegram.sendMessage(context.chatId, 'This document is larger than the 5 MB limit.'); return;
    }
    try {
      const bytes = await this.options.telegram.downloadFile(document.file_id, DOCUMENT_MAX_BYTES);
      const job = await this.options.repository.create({ ownerSubject: context.userId, name, mimeType: document.mime_type ?? 'application/octet-stream', bytes });
      session.jobId = job.id;
      const messageId = await this.options.telegram.sendMessage(context.chatId, this.extractionSummary(job), languageKeyboard(session.nonce));
      session.actionMessageId = messageId;
    } catch (error) { await this.options.telegram.sendMessage(context.chatId, safeError(error)); }
  }

  async handleCallback(context: DocumentTelegramContext, data: string): Promise<boolean> {
    const match = /^dv:([a-f0-9]{16}):(lang:(en|zh)|generate|retry|change|cancel)$/.exec(data);
    const session = this.authorizedSession(context);
    if (!match || !session || match[1] !== session.nonce || context.messageId !== session.actionMessageId) return false;
    const action = match[2];
    if (action === 'change') {
      session.actionMessageId = await this.options.telegram.sendMessage(context.chatId, 'Choose a voice language. The document text will not be translated.', languageKeyboard(session.nonce));
      return true;
    }
    if (action === 'cancel') {
      if (session.jobId) {
        const jobId = session.jobId;
        let refused = false;
        let running = false;
        let authorized = false;
        await this.lockFor(jobId).run(async () => {
          const job = await this.options.repository.get(jobId);
          if (job.owner.subject !== context.userId) return;
          authorized = true;
          if (['delivering', 'delivery_unknown', 'delivered'].includes(job.status)) { refused = true; return; }
          running = this.queue.isRunning(jobId);
          this.queue.cancel(jobId);
        });
        if (!authorized) return false;
        if (refused) {
          await this.options.telegram.sendMessage(context.chatId, 'Delivery has already started or its result is unknown, so cancellation cannot safely guarantee that no audio was sent.');
          return true;
        }
        if (running) await this.queue.waitForCompletion(jobId);
        let latest: DocumentVoiceJob | undefined;
        try { latest = await this.options.repository.get(jobId); }
        catch (error) {
          if (!(error instanceof DocumentVoiceError && error.code === 'JOB_NOT_FOUND')) {
            await this.options.telegram.sendMessage(context.chatId, 'Cancellation could not be confirmed. Your document may still be retained. Please try again.');
            return true;
          }
        }
        if (latest && ['delivering', 'delivery_unknown', 'delivered'].includes(latest.status)) {
          await this.options.telegram.sendMessage(context.chatId, 'Delivery has already started or its result is unknown, so cancellation cannot safely guarantee that no audio was sent.');
          return true;
        }
        if (latest) {
          try { await this.options.repository.delete(jobId); }
          catch {
            await this.options.telegram.sendMessage(context.chatId, 'Cancellation could not be confirmed. Your document may still be retained. Please try again.');
            return true;
          }
        }
      }
      this.sessions.delete(context.userId);
      await this.options.telegram.sendMessage(context.chatId, 'Document conversion cancelled and deleted.'); return true;
    }
    if (action.startsWith('lang:') && session.jobId) {
      const job = await this.options.repository.get(session.jobId);
      if (job.owner.subject !== context.userId || job.status !== 'ready_for_language') return false;
      session.language = match[3] === 'en' ? 'english' : 'chinese_traditional';
      session.actionMessageId = await this.options.telegram.sendMessage(context.chatId, confirmation(job, session.language), confirmationKeyboard(session.nonce));
      return true;
    }
    if ((action === 'generate' || action === 'retry') && session.jobId && session.language) {
      const job = await this.options.repository.get(session.jobId);
      if (job.owner.subject !== context.userId || !['ready_for_language', 'generated', 'delivery_failed', 'delivery_unknown'].includes(job.status)) return false;
      let reserved = false;
      try {
        this.queue.reserve(); reserved = true;
        if (job.status === 'ready_for_language') await this.options.service.prepare(session.jobId, session.language);
        await this.queue.enqueue({ jobId: session.jobId, ownerSubject: context.userId, language: session.language }, true);
        reserved = false;
      } catch {
        if (reserved) this.queue.releaseReservation();
        const latest = await this.options.repository.get(session.jobId);
        if (latest.status === 'queued' && latest.synthesis?.completedChunks === 0) await this.options.service.rollbackPreparation(session.jobId);
        await this.options.telegram.sendMessage(context.chatId, 'The document voice queue is full. Please try again later.');
      }
      return true;
    }
    return false;
  }

  private async processQueued(task: DocumentQueueTask): Promise<void> {
    const session = this.sessions.get(task.ownerSubject);
    const chatId = session?.chatId ?? task.ownerSubject;
    let progressId: number | undefined;
    try {
        for (let attempt = 1; attempt <= 3 && progressId === undefined; attempt += 1) {
          try { progressId = await this.options.telegram.sendMessage(chatId, 'Generating audio… 0%'); }
          catch {
            if (attempt === 3) throw new DocumentVoiceError('PROGRESS_MESSAGE_FAILED');
            await (this.options.progressDelay?.() ?? new Promise<void>((resolve) => setTimeout(resolve, DOCUMENT_PROGRESS_RETRY_DELAY_MS)));
          }
        }
        const existing = await this.options.repository.get(task.jobId);
        const generated = ['generated', 'delivery_failed', 'delivery_unknown'].includes(existing.status) ? existing : await this.options.service.generate(task.jobId, task.language, {
          shouldCancel: () => this.queue.isCancelled(task.jobId),
          registerAbort: (abort) => this.queue.registerActiveCancellation(task.jobId, abort),
        });
        if (generated.owner.subject !== task.ownerSubject || !['generated', 'delivery_failed', 'delivery_unknown'].includes(generated.status)) throw new DocumentVoiceError('OWNER_MISMATCH');
        if (this.queue.isCancelled(task.jobId)) throw new DocumentVoiceError('JOB_CANCELLED');
        const audio = await this.options.repository.readAudio(task.jobId);
        if (audio.byteLength > TELEGRAM_DOCUMENT_AUDIO_MAX_BYTES) throw new DocumentVoiceError('AUDIO_TOO_LARGE');
        const name = `${generated.source.safeName.replace(/\.(txt|md)$/i, '')}.mp3`;
        await this.options.beforeDeliveryTransition?.();
        const attemptId = randomBytes(16).toString('hex');
        const deliveryController = new AbortController();
        await this.lockFor(task.jobId).run(async () => {
          if (this.queue.isCancelled(task.jobId)) throw new DocumentVoiceError('JOB_CANCELLED');
          const current = await this.options.repository.get(task.jobId);
          if (!['generated', 'delivery_failed', 'delivery_unknown'].includes(current.status)) throw new DocumentVoiceError('JOB_CANCELLED');
          await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...current, status: 'delivering', delivery: { attemptId }, error: undefined }));
        });
        let timeout!: ReturnType<typeof setTimeout>;
        const send = this.options.telegram.sendPrivateAudio(chatId, audio, name, 'Transport: Telegram · Processing: Local · External fallback: Off · Translation: Off · Retention target: 24 hours · Cleanup: startup and every 60 seconds while the local bot is online.', deliveryController.signal);
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { deliveryController.abort(); reject(new DocumentVoiceError('DELIVERY_TIMEOUT')); }, this.options.deliveryTimeoutMs ?? DOCUMENT_DELIVERY_TIMEOUT_MS);
        });
        let telegramMessageId: number;
        try { telegramMessageId = await Promise.race([send, deadline]); }
        finally { clearTimeout(timeout); }
        const current = await this.options.repository.get(task.jobId);
        if (current.status !== 'delivering' || current.delivery?.attemptId !== attemptId) throw new DocumentVoiceError('DELIVERY_STATUS_UNKNOWN');
        const delivered = DocumentVoiceJobSchema.parse({ ...current, status: 'delivered', delivery: { attemptId, telegramMessageId } });
        await this.options.repository.save(delivered);
        await this.options.telegram.editMessage(chatId, progressId!, `Delivered ${delivered.synthesis?.totalChunks ?? 0} / ${delivered.synthesis?.totalChunks ?? 0} sections.`);
        await this.options.repository.recordEvent('audio_delivered', { channel: 'telegram', provider: delivered.synthesis?.provider ?? 'unknown' });
        this.sessions.delete(task.ownerSubject);
      } catch (error) {
        if (this.queue.isCancelled(task.jobId)) { await this.options.repository.delete(task.jobId); return; }
        const latest = await this.options.repository.get(task.jobId).catch(() => undefined);
        if (latest?.status === 'delivering') {
          await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...latest, status: 'delivery_unknown', error: { code: 'DELIVERY_STATUS_UNKNOWN' } }));
        } else if (latest && ['generated', 'delivery_failed', 'delivery_unknown'].includes(latest.status)) {
          await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...latest, status: 'delivery_failed', error: { code: error instanceof DocumentVoiceError ? error.code : 'TELEGRAM_DELIVERY_FAILED' } }));
        } else if (latest && !['failed', 'delivered'].includes(latest.status)) {
          await this.options.repository.save(DocumentVoiceJobSchema.parse({ ...latest, status: 'failed', error: { code: error instanceof DocumentVoiceError ? error.code : 'WORKER_FAILED' } }));
        }
        const message = latest && ['generated', 'delivery_failed', 'delivering', 'delivery_unknown'].includes(latest.status)
          ? 'Audio is ready, but Telegram delivery failed. Tap Generate Voice to retry delivery.'
          : 'Voice generation failed. Your document was not published.';
        if (progressId !== undefined) await this.options.telegram.editMessage(chatId, progressId, message).catch(() => undefined);
      }
  }

  private authorizedSession(context: DocumentTelegramContext): Session | undefined {
    if (context.chatType !== 'private') return undefined;
    const session = this.sessions.get(context.userId);
    return session?.chatId === context.chatId && session.userId === context.userId ? session : undefined;
  }
  private lockFor(jobId: string): AsyncMutex {
    const existing = this.jobLocks.get(jobId);
    if (existing) return existing;
    const lock = new AsyncMutex(); this.jobLocks.set(jobId, lock); return lock;
  }
  private extractionSummary(job: DocumentVoiceJob): string {
    const detected = job.extraction.detectedLanguage ? languageLabels[job.extraction.detectedLanguage] : 'Unknown';
    return `File: ${job.source.safeName}\nExtracted ${job.extraction.characterCount} characters.\nDetected text language: ${detected}\nTranslation: Off\n\nChoose a voice language:`;
  }
}

const confirmation = (job: DocumentVoiceJob, language: DocumentVoiceLanguage): string => [
  `File: ${job.source.safeName}`, `Extracted characters: ${job.extraction.characterCount}`,
  `Detected text language: ${job.extraction.detectedLanguage ? languageLabels[job.extraction.detectedLanguage] : 'Unknown'}`,
  `Voice language: ${languageLabels[language]}`, 'Transport: Telegram', 'Processing: Local', 'External fallback: Off', 'Translation: Off',
  'Retention target: 24 hours · Cleanup: startup and every 60 seconds while the local bot is online.',
].join('\n');
const safeError = (error: unknown): string => {
  const code = error instanceof DocumentVoiceError ? error.code : '';
  const messages: Record<string, string> = {
    UNSUPPORTED_FILE: 'This file type is not supported. Upload TXT or Markdown.', FILE_TOO_LARGE: 'This document is larger than the 5 MB limit.',
    TEXT_TOO_LONG: 'This document exceeds the 10,000-character limit.', NO_EXTRACTABLE_TEXT: 'No readable text was found.',
    INVALID_TEXT_ENCODING: 'This document is not valid UTF-8 text.', ACTIVE_JOB_EXISTS: 'You already have an active document conversion.',
  };
  return messages[code] ?? 'The document could not be processed safely.';
};
