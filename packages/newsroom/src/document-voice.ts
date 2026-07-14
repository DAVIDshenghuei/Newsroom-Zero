import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { LocalAudioProvider, SynthesizeOutcomeFunction } from './pocket-tts.js';

export const DOCUMENT_MAX_BYTES = 5_000_000;
export const DOCUMENT_MAX_CHARACTERS = 10_000;
export const DOCUMENT_RETENTION_HOURS = 24;
export const DOCUMENT_DEFAULT_CHUNK_CHARACTERS = 1_500;
/** Keeps each CPU-bound Kokoro request below the observed per-request timeout boundary. */
export const DOCUMENT_KOKORO_MAX_CHUNK_CHARACTERS = 450;
export const DOCUMENT_JOB_TIMEOUT_MS = 45 * 60_000;
export const DOCUMENT_MAX_DAILY_JOBS_PER_OWNER = 3;
export const DOCUMENT_MAX_STORED_JOBS_PER_OWNER = 5;
export interface DocumentVoiceQuotaConfig {
  maxDailyJobsPerOwner: number;
  maxStoredJobsPerOwner: number;
}
const parsePositiveSafeInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a finite positive safe integer`);
  }
  return parsed;
};
export const parseDocumentVoiceQuotaConfig = (environment: Readonly<Record<string, string | undefined>>): DocumentVoiceQuotaConfig => ({
  maxDailyJobsPerOwner: parsePositiveSafeInteger('DOCUMENT_VOICE_MAX_DAILY_JOBS_PER_OWNER', environment.DOCUMENT_VOICE_MAX_DAILY_JOBS_PER_OWNER, DOCUMENT_MAX_DAILY_JOBS_PER_OWNER),
  maxStoredJobsPerOwner: parsePositiveSafeInteger('DOCUMENT_VOICE_MAX_STORED_JOBS_PER_OWNER', environment.DOCUMENT_VOICE_MAX_STORED_JOBS_PER_OWNER, DOCUMENT_MAX_STORED_JOBS_PER_OWNER),
});
export const DOCUMENT_MAX_TOTAL_STORAGE_BYTES = 50_000_000;

export const DocumentVoiceStatus = z.enum([
  'ready_for_language', 'queued', 'generating', 'generated', 'delivery_failed', 'delivering', 'delivery_unknown', 'delivered', 'failed', 'cancelled', 'expired',
]);
export type DocumentVoiceStatus = z.infer<typeof DocumentVoiceStatus>;
export const DocumentVoiceLanguage = z.enum(['english', 'chinese_traditional']);
export type DocumentVoiceLanguage = z.infer<typeof DocumentVoiceLanguage>;

export const DocumentVoiceJobSchema = z.object({
  id: z.string().startsWith('dv_'),
  owner: z.object({ channel: z.literal('telegram'), subject: z.string().min(1) }),
  status: DocumentVoiceStatus,
  source: z.object({ safeName: z.string().min(1), mimeType: z.enum(['text/plain', 'text/markdown']), sizeBytes: z.number().int().nonnegative() }),
  extraction: z.object({ characterCount: z.number().int().positive(), detectedLanguage: DocumentVoiceLanguage.optional(), preview: z.string() }),
  privacy: z.object({ processing: z.literal('local'), externalFallback: z.literal(false), translation: z.literal(false), retentionHours: z.literal(24) }),
  synthesis: z.object({
    ttsLanguage: DocumentVoiceLanguage, voice: z.string(), provider: z.enum(['pocket-tts', 'kokoro']).optional(),
    completedChunks: z.number().int().nonnegative(), totalChunks: z.number().int().positive(), durationSeconds: z.number().nonnegative().optional(),
  }).optional(),
  error: z.object({ code: z.string(), safeMessage: z.string().optional() }).optional(),
  delivery: z.object({ attemptId: z.string().min(1), telegramMessageId: z.number().int().positive().optional() }).optional(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
});
export type DocumentVoiceJob = z.infer<typeof DocumentVoiceJobSchema>;

export const DOCUMENT_EVENT_NAMES = [
  'document_flow_started', 'document_uploaded', 'document_extracted', 'voice_language_selected',
  'generation_started', 'generation_completed', 'generation_failed', 'audio_delivered',
  'audio_downloaded', 'job_deleted', 'worker_failed',
] as const;
export interface DocumentVoiceEvent {
  name: typeof DOCUMENT_EVENT_NAMES[number];
  at: string;
  properties: Record<string, string | number | boolean>;
}

export class DocumentVoiceError extends Error {
  constructor(public readonly code: string, message = code) { super(message); }
}

const allowedType = (name: string, mimeType: string): 'text/plain' | 'text/markdown' | undefined => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') && (mimeType === 'text/markdown' || mimeType === 'text/plain' || mimeType === 'application/octet-stream')) return 'text/markdown';
  if (lower.endsWith('.txt') && (mimeType === 'text/plain' || mimeType === 'application/octet-stream')) return 'text/plain';
  return undefined;
};

export function extractDocumentText(input: { name: string; mimeType: string; bytes: Uint8Array }): {
  text: string; mimeType: 'text/plain' | 'text/markdown'; characterCount: number; detectedLanguage?: DocumentVoiceLanguage;
} {
  const mimeType = allowedType(input.name, input.mimeType);
  if (!mimeType) throw new DocumentVoiceError('UNSUPPORTED_FILE');
  if (input.bytes.byteLength > DOCUMENT_MAX_BYTES) throw new DocumentVoiceError('FILE_TOO_LARGE');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes); }
  catch { throw new DocumentVoiceError('INVALID_TEXT_ENCODING'); }
  if (!text.trim()) throw new DocumentVoiceError('NO_EXTRACTABLE_TEXT');
  if (text.length > DOCUMENT_MAX_CHARACTERS) throw new DocumentVoiceError('TEXT_TOO_LONG');
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const detectedLanguage = cjk > latin ? 'chinese_traditional' : latin ? 'english' : undefined;
  return { text, mimeType, characterCount: text.length, detectedLanguage };
}

export function chunkDocumentText(text: string, maximumCharacters = 1_500): string[] {
  if (maximumCharacters < 1) throw new Error('maximumCharacters must be positive');
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + maximumCharacters, text.length);
    if (end === text.length) { chunks.push(text.slice(cursor)); break; }
    const window = text.slice(cursor, end);
    let split = -1;
    for (const match of window.matchAll(/[.!?。！？](?:["'”’)]*)[ \t]*(?:\r?\n| )|\r?\n\r?\n/g)) split = (match.index ?? 0) + match[0].length;
    if (split < Math.floor(maximumCharacters / 3)) split = end - cursor;
    const splitIndex = cursor + split;
    if (splitIndex < text.length && /[\uD800-\uDBFF]/.test(text[splitIndex - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[splitIndex] ?? '')) split -= 1;
    chunks.push(text.slice(cursor, cursor + split));
    cursor += split;
  }
  return chunks;
}

export interface DocumentVoiceRepositoryOptions {
  root: string;
  now?: () => Date;
  emit?: (event: DocumentVoiceEvent) => void | Promise<void>;
  maxDailyJobsPerOwner?: number;
  maxStoredJobsPerOwner?: number;
  maxTotalStorageBytes?: number;
}

export class DocumentVoiceRepository {
  private readonly root: string;
  private canonicalRoot?: string;
  private readonly ready: Promise<void>;
  private readonly now: () => Date;
  private readonly emitEvent: (event: DocumentVoiceEvent) => void | Promise<void>;
  readonly limits: Readonly<DocumentVoiceQuotaConfig>;
  private readonly maxTotalStorageBytes: number;
  constructor(options: DocumentVoiceRepositoryOptions) {
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.emitEvent = options.emit ?? (() => undefined);
    this.limits = Object.freeze({
      maxDailyJobsPerOwner: options.maxDailyJobsPerOwner ?? DOCUMENT_MAX_DAILY_JOBS_PER_OWNER,
      maxStoredJobsPerOwner: options.maxStoredJobsPerOwner ?? DOCUMENT_MAX_STORED_JOBS_PER_OWNER,
    });
    this.maxTotalStorageBytes = options.maxTotalStorageBytes ?? DOCUMENT_MAX_TOTAL_STORAGE_BYTES;
    this.ready = this.initializeRoot();
  }
  private async initializeRoot(): Promise<void> {
    if (this.root.split(sep).some((part) => part.toLowerCase() === 'public')) throw new Error('Document jobs cannot be stored under a public directory');
    await mkdir(this.root, { recursive: true });
    let cursor = this.root;
    const filesystemRoot = parse(cursor).root;
    while (cursor !== filesystemRoot) {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Document job storage cannot use symbolic links');
      cursor = dirname(cursor);
    }
    const canonical = await realpath(this.root);
    if (canonical.split(sep).some((part) => part.toLowerCase() === 'public')) throw new Error('Document jobs cannot be stored under a public directory');
    this.canonicalRoot = canonical;
  }
  private directory(id: string): string {
    if (!/^dv_[a-f0-9-]+$/.test(id)) throw new DocumentVoiceError('JOB_NOT_FOUND');
    const directory = resolve(this.root, id);
    if (!directory.startsWith(`${this.root}${sep}`)) throw new DocumentVoiceError('JOB_NOT_FOUND');
    return directory;
  }
  private async assertJobDirectory(id: string): Promise<string> {
    const directory = this.directory(id);
    if ((await lstat(directory)).isSymbolicLink()) throw new DocumentVoiceError('JOB_NOT_FOUND');
    const canonical = await realpath(directory);
    const root = this.canonicalRoot!;
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new DocumentVoiceError('JOB_NOT_FOUND');
    return directory;
  }
  private async emit(name: DocumentVoiceEvent['name'], properties: DocumentVoiceEvent['properties']): Promise<void> {
    await this.emitEvent({ name, at: this.now().toISOString(), properties });
  }
  async recordEvent(name: DocumentVoiceEvent['name'], properties: DocumentVoiceEvent['properties'] = {}): Promise<void> {
    await this.emit(name, properties);
  }
  async list(): Promise<DocumentVoiceJob[]> {
    await this.ready;
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name).catch(() => undefined))))
        .filter((job): job is DocumentVoiceJob => Boolean(job));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async create(input: { ownerSubject: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<DocumentVoiceJob> {
    await this.ready;
    const jobs = await this.list();
    const ownerJobs = jobs.filter((job) => job.owner.subject === input.ownerSubject);
    const active = ownerJobs.some((job) => !['delivered', 'failed', 'cancelled', 'expired'].includes(job.status));
    if (active) throw new DocumentVoiceError('ACTIVE_JOB_EXISTS');
    if (ownerJobs.length >= this.limits.maxStoredJobsPerOwner) throw new DocumentVoiceError('STORED_JOB_QUOTA_EXCEEDED');
    const dailyBoundary = this.now().getTime() - 86_400_000;
    if (ownerJobs.filter((job) => Date.parse(job.createdAt) >= dailyBoundary).length >= this.limits.maxDailyJobsPerOwner) throw new DocumentVoiceError('DAILY_QUOTA_EXCEEDED');
    if (jobs.reduce((sum, job) => sum + job.source.sizeBytes, 0) + input.bytes.byteLength > this.maxTotalStorageBytes) throw new DocumentVoiceError('STORAGE_QUOTA_EXCEEDED');
    const extraction = extractDocumentText(input);
    const now = this.now();
    const id = `dv_${randomUUID()}`;
    const safeName = basename(input.name.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'document.txt';
    const job = DocumentVoiceJobSchema.parse({
      id, owner: { channel: 'telegram', subject: input.ownerSubject }, status: 'ready_for_language',
      source: { safeName, mimeType: extraction.mimeType, sizeBytes: input.bytes.byteLength },
      extraction: { characterCount: extraction.characterCount, detectedLanguage: extraction.detectedLanguage, preview: extraction.text.slice(0, 240) },
      privacy: { processing: 'local', externalFallback: false, translation: false, retentionHours: 24 },
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + DOCUMENT_RETENTION_HOURS * 3_600_000).toISOString(),
    });
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true });
    await this.assertJobDirectory(id);
    await writeFile(joinPath(directory, 'source.txt'), input.bytes);
    await this.save(job);
    await this.emit('document_uploaded', { fileType: extraction.mimeType, byteBucket: byteBucket(input.bytes.byteLength) });
    await this.emit('document_extracted', { characterBucket: characterBucket(extraction.characterCount), language: extraction.detectedLanguage ?? 'unknown' });
    return job;
  }
  async get(id: string): Promise<DocumentVoiceJob> {
    await this.ready;
    try { return DocumentVoiceJobSchema.parse(JSON.parse(await readFile(joinPath(await this.assertJobDirectory(id), 'job.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentVoiceError('JOB_NOT_FOUND'); throw error; }
  }
  async readText(id: string): Promise<string> { await this.ready; return readFile(joinPath(await this.assertJobDirectory(id), 'source.txt'), 'utf8'); }
  async readAudio(id: string): Promise<Uint8Array> { await this.ready; return new Uint8Array(await readFile(joinPath(await this.assertJobDirectory(id), 'audio.mp3'))); }
  async writeAudio(id: string, audio: Uint8Array): Promise<void> {
    await this.ready;
    let used = (await this.list()).reduce((sum, job) => sum + job.source.sizeBytes, 0);
    for (const job of await this.list()) {
      try { used += (await stat(joinPath(this.directory(job.id), 'audio.mp3'))).size; } catch { /* No audio yet. */ }
    }
    if (used + audio.byteLength > this.maxTotalStorageBytes) throw new DocumentVoiceError('STORAGE_QUOTA_EXCEEDED');
    await writeFile(joinPath(await this.assertJobDirectory(id), 'audio.mp3'), audio);
  }
  async save(job: DocumentVoiceJob): Promise<void> {
    await this.ready;
    const parsed = DocumentVoiceJobSchema.parse(job);
    const path = joinPath(await this.assertJobDirectory(job.id), 'job.json');
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }
  async delete(id: string): Promise<void> { await this.ready; await rm(await this.assertJobDirectory(id), { recursive: true, force: true }); await this.emit('job_deleted', {}); }
  async cleanupExpired(): Promise<string[]> {
    const expired = (await this.list()).filter((job) => Date.parse(job.expiresAt) <= this.now().getTime());
    for (const job of expired) await this.delete(job.id);
    return expired.map(({ id }) => id);
  }
}

const joinPath = (directory: string, file: string): string => resolve(directory, file);
const byteBucket = (size: number): string => size <= 100_000 ? '0-100KB' : size <= 1_000_000 ? '100KB-1MB' : '1-5MB';
const characterBucket = (count: number): string => count <= 1_000 ? '0-1K' : count <= 5_000 ? '1K-5K' : '5K-10K';

const languageRoute: Record<DocumentVoiceLanguage, { voice: string; provider: LocalAudioProvider }> = {
  english: { voice: 'alba', provider: 'pocket-tts' },
  chinese_traditional: { voice: 'zf_xiaoxiao', provider: 'kokoro' },
};
const validMp3 = (audio: Uint8Array): boolean =>
  (audio.length >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33)
  || (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);

export interface FinalizedDocumentAudio { audio: Uint8Array; durationSeconds: number }
export type FinalizeDocumentAudio = (chunks: Uint8Array[], control?: { signal?: AbortSignal; deadlineAt?: number }) => Promise<FinalizedDocumentAudio>;

export const DOCUMENT_AUDIO_PROCESS_TIMEOUT_MS = 120_000;

export const runDocumentAudioProcess = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DOCUMENT_AUDIO_PROCESS_TIMEOUT_MS,
  control: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<string> => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const succeed = (value: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveRun(value);
  };
  let terminationRequested = false;
  const fail = (): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    reject(new DocumentVoiceError('TTS_FAILED'));
  };
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  child.once('error', fail);
  child.once('close', (code) => code === 0 && !terminationRequested
    ? succeed(Buffer.concat(output).toString('utf8'))
    : fail());
  const terminate = (): void => { terminationRequested = true; child.kill(); };
  control.signal?.addEventListener('abort', terminate, { once: true });
  timer = setTimeout(() => {
    terminate();
  }, Math.max(0, Math.min(timeoutMs, control.deadlineAt === undefined ? timeoutMs : control.deadlineAt - Date.now())));
});

export const mergeAndValidateDocumentAudio: FinalizeDocumentAudio = async (chunks, control = {}) => {
  if (!chunks.length || chunks.some((chunk) => !validMp3(chunk))) throw new DocumentVoiceError('TTS_FAILED');
  const directory = await mkdtemp(join(tmpdir(), 'document-voice-merge-'));
  try {
    const names = chunks.map((_, index) => `chunk-${index}.mp3`);
    await Promise.all(chunks.map((chunk, index) => writeFile(join(directory, names[index]), chunk)));
    await writeFile(join(directory, 'concat.txt'), `${names.map((name) => `file '${name}'`).join('\n')}\n`, 'utf8');
    await runDocumentAudioProcess(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', 'output.mp3'],
      directory,
      DOCUMENT_AUDIO_PROCESS_TIMEOUT_MS,
      control,
    );
    const probeText = await runDocumentAudioProcess(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', 'output.mp3'],
      directory,
      30_000,
      control,
    );
    let probe: { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
    try { probe = JSON.parse(probeText) as typeof probe; }
    catch { throw new DocumentVoiceError('TTS_FAILED'); }
    const hasAudioStream = probe.streams?.some(({ codec_type: codecType }) => codecType === 'audio') ?? false;
    const durationSeconds = Number(probe.format?.duration);
    const audio = new Uint8Array(await readFile(join(directory, 'output.mp3')));
    if (!hasAudioStream || !validMp3(audio) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new DocumentVoiceError('TTS_FAILED');
    return { audio, durationSeconds };
  } finally { await rm(directory, { recursive: true, force: true }); }
};

export class DocumentVoiceService {
  private readonly chunkCharacters: number;
  private readonly finalizeAudio: FinalizeDocumentAudio;
  private readonly jobTimeoutMs: number;
  constructor(private readonly options: {
    repository: DocumentVoiceRepository;
    synthesizer: SynthesizeOutcomeFunction;
    chunkCharacters?: number;
    finalizeAudio?: FinalizeDocumentAudio;
    jobTimeoutMs?: number;
  }) {
    this.chunkCharacters = options.chunkCharacters ?? DOCUMENT_DEFAULT_CHUNK_CHARACTERS;
    this.finalizeAudio = options.finalizeAudio ?? mergeAndValidateDocumentAudio;
    this.jobTimeoutMs = options.jobTimeoutMs ?? DOCUMENT_JOB_TIMEOUT_MS;
  }

  async prepare(id: string, languageInput: DocumentVoiceLanguage): Promise<DocumentVoiceJob> {
    const language = DocumentVoiceLanguage.parse(languageInput);
    const job = await this.options.repository.get(id);
    if (job.status !== 'ready_for_language') throw new DocumentVoiceError('JOB_NOT_READY');
    const route = languageRoute[language];
    const effectiveChunkCharacters = route.provider === 'kokoro' ? Math.min(this.chunkCharacters, DOCUMENT_KOKORO_MAX_CHUNK_CHARACTERS) : this.chunkCharacters;
    const chunks = chunkDocumentText(await this.options.repository.readText(id), effectiveChunkCharacters);
    const queued = DocumentVoiceJobSchema.parse({ ...job, status: 'queued', synthesis: {
      ttsLanguage: language, voice: route.voice, completedChunks: 0, totalChunks: chunks.length,
    } });
    await this.options.repository.save(queued);
    await this.options.repository.recordEvent('voice_language_selected', { language });
    return queued;
  }

  async rollbackPreparation(id: string): Promise<DocumentVoiceJob> {
    const job = await this.options.repository.get(id);
    if (job.status !== 'queued' || job.synthesis?.completedChunks !== 0) throw new DocumentVoiceError('JOB_NOT_READY');
    const ready = DocumentVoiceJobSchema.parse({ ...job, status: 'ready_for_language', synthesis: undefined });
    await this.options.repository.save(ready);
    return ready;
  }

  async generate(id: string, languageInput: DocumentVoiceLanguage, control: { shouldCancel?: () => boolean; registerAbort?: (abort: () => void) => void } = {}): Promise<DocumentVoiceJob> {
    const language = DocumentVoiceLanguage.parse(languageInput);
    let job = await this.options.repository.get(id);
    if (job.status === 'ready_for_language') job = await this.prepare(id, language);
    if (job.status !== 'queued' || job.synthesis?.ttsLanguage !== language) throw new DocumentVoiceError('JOB_NOT_READY');
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.jobTimeoutMs;
    const timer = setTimeout(() => controller.abort(new DocumentVoiceError('JOB_TIMEOUT')), this.jobTimeoutMs);
    control.registerAbort?.(() => controller.abort(new DocumentVoiceError('JOB_CANCELLED')));
    const assertActive = (): void => {
      if (control.shouldCancel?.() && !controller.signal.aborted) controller.abort(new DocumentVoiceError('JOB_CANCELLED'));
      if (controller.signal.aborted) throw controller.signal.reason instanceof DocumentVoiceError
        ? controller.signal.reason : new DocumentVoiceError('JOB_CANCELLED');
    };
    const route = languageRoute[language];
    const effectiveChunkCharacters = route.provider === 'kokoro'
      ? Math.min(this.chunkCharacters, DOCUMENT_KOKORO_MAX_CHUNK_CHARACTERS)
      : this.chunkCharacters;
    const chunks = chunkDocumentText(await this.options.repository.readText(id), effectiveChunkCharacters);
    let current = job;
    await this.options.repository.recordEvent('generation_started', { language, provider: route.provider, chunkCount: chunks.length });
    try {
      current = DocumentVoiceJobSchema.parse({ ...current, status: 'generating' });
      await this.options.repository.save(current);
      const outputs: Uint8Array[] = [];
      for (const chunk of chunks) {
        assertActive();
        const outcome = await this.options.synthesizer.synthesizeWithOutcome(chunk, {
          language, voiceId: route.voice, provider: route.provider, signal: controller.signal,
        });
        assertActive();
        if (outcome.fallbackUsed || outcome.provider !== route.provider || !validMp3(outcome.audio)) throw new DocumentVoiceError('TTS_FAILED');
        outputs.push(outcome.audio);
        current = DocumentVoiceJobSchema.parse({
          ...current, synthesis: { ...current.synthesis!, completedChunks: current.synthesis!.completedChunks + 1, provider: route.provider },
        });
        await this.options.repository.save(current);
      }
      assertActive();
      const finalized = await this.finalizeAudio(outputs, { signal: controller.signal, deadlineAt });
      assertActive();
      if (!validMp3(finalized.audio) || !Number.isFinite(finalized.durationSeconds) || finalized.durationSeconds <= 0) throw new DocumentVoiceError('TTS_FAILED');
      await this.options.repository.writeAudio(id, finalized.audio);
      current = DocumentVoiceJobSchema.parse({
        ...current, status: 'generated', synthesis: { ...current.synthesis!, durationSeconds: finalized.durationSeconds },
      });
      await this.options.repository.save(current);
      await this.options.repository.recordEvent('generation_completed', { language, provider: route.provider, chunkCount: chunks.length });
      return current;
    } catch (error) {
      const code = error instanceof DocumentVoiceError && ['JOB_CANCELLED', 'JOB_TIMEOUT'].includes(error.code)
        ? error.code : controller.signal.reason instanceof DocumentVoiceError ? controller.signal.reason.code : 'TTS_FAILED';
      current = DocumentVoiceJobSchema.parse({
        ...current, status: 'failed', error: { code, safeMessage: 'Voice generation failed. Your document was not published.' },
      });
      await this.options.repository.save(current);
      await this.options.repository.recordEvent('generation_failed', { language, provider: route.provider, errorCode: code });
      throw new DocumentVoiceError(code);
    } finally { clearTimeout(timer); }
  }
}
