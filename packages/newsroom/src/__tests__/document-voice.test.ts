import { mkdtemp, mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_JOB_TIMEOUT_MS,
  DocumentVoiceJobSchema,
  DocumentVoiceRepository,
  DocumentVoiceService,
  chunkDocumentText,
  extractDocumentText,
  mergeAndValidateDocumentAudio,
  runDocumentAudioProcess,
  type DocumentVoiceEvent,
} from '../document-voice.js';

describe('Document Voice Release A core', () => {
  it('uses a 45-minute default whole-job deadline', () => {
    expect(DOCUMENT_JOB_TIMEOUT_MS).toBe(45 * 60_000);
  });
  it('aborts an honoring provider and settles at the whole-job deadline', async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), 'document-deadline-'));
      const repository = new DocumentVoiceRepository({ root });
      const job = await repository.create({ ownerSubject: 'deadline', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Words.') });
      let started!: () => void;
      const providerStarted = new Promise<void>((resolve) => { started = resolve; });
      let deliveredSignal: AbortSignal | undefined;
      const synthesizeWithOutcome = vi.fn(async (_text: string, options?: { signal?: AbortSignal }) => {
        deliveredSignal = options?.signal;
        started();
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
        throw new Error('unreachable');
      });
      const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome }, jobTimeoutMs: 1_000 });
      const result = service.generate(job.id, 'english');
      await providerStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deliveredSignal?.aborted).toBe(true);
      await expect(result).rejects.toThrow('JOB_TIMEOUT');
      expect(await repository.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'JOB_TIMEOUT' } });
    } finally { vi.useRealTimers(); }
  });
  it('aborts active synthesis through the job signal and preserves JOB_CANCELLED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-cancel-signal-'));
    const events: DocumentVoiceEvent[] = [];
    const repository = new DocumentVoiceRepository({ root, emit: (event) => { events.push(event); } });
    const job = await repository.create({ ownerSubject: 'cancel', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Words.') });
    let cancel!: () => void;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn(async (_text, options) => {
        started();
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
        throw new Error('unreachable');
      }) },
    });
    const result = service.generate(job.id, 'english', { registerAbort: (abort) => { cancel = abort; } });
    await providerStarted;
    cancel();
    await expect(result).rejects.toThrow('JOB_CANCELLED');
    expect(await repository.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'JOB_CANCELLED' } });
    expect(events).toContainEqual(expect.objectContaining({ name: 'generation_failed', properties: expect.objectContaining({ errorCode: 'JOB_CANCELLED' }) }));
  });
  it('validates the private local no-translation contract', () => {
    const job = DocumentVoiceJobSchema.parse({
      id: 'dv_test', owner: { channel: 'telegram', subject: '42' }, status: 'ready_for_language',
      source: { safeName: 'notes.md', mimeType: 'text/markdown', sizeBytes: 12 },
      extraction: { characterCount: 12, detectedLanguage: 'english', preview: 'Hello world.' },
      privacy: { processing: 'local', externalFallback: false, translation: false, retentionHours: 24 },
      createdAt: '2026-07-14T10:00:00.000Z', expiresAt: '2026-07-15T10:00:00.000Z',
    });
    expect(job.privacy).toEqual({ processing: 'local', externalFallback: false, translation: false, retentionHours: 24 });
  });

  it.each([
    ['notes.txt', 'text/plain'], ['notes.md', 'text/markdown'],
  ])('extracts exact UTF-8 wording and order from %s', (name, mimeType) => {
    const source = 'Heading\n\nFirst sentence.  Second sentence!\n最後一行。';
    const result = extractDocumentText({ name, mimeType, bytes: new TextEncoder().encode(source) });
    expect(result.text).toBe(source);
    expect(result.characterCount).toBe(source.length);
  });

  it('rejects unsupported, invalid UTF-8, oversized, empty, and overlong documents safely', () => {
    expect(() => extractDocumentText({ name: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) })).toThrow('UNSUPPORTED_FILE');
    expect(() => extractDocumentText({ name: 'x.txt', mimeType: 'text/plain', bytes: new Uint8Array([0xff]) })).toThrow('INVALID_TEXT_ENCODING');
    expect(() => extractDocumentText({ name: 'x.txt', mimeType: 'text/plain', bytes: new Uint8Array(5_000_001) })).toThrow('FILE_TOO_LARGE');
    expect(() => extractDocumentText({ name: 'x.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('  \n') })).toThrow('NO_EXTRACTABLE_TEXT');
    expect(() => extractDocumentText({ name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('x'.repeat(10_001)) })).toThrow('TEXT_TOO_LONG');
  });

  it('chunks on sentence boundaries while preserving every character exactly once', () => {
    const text = 'First sentence. Second sentence!\n\n第三句。第四句？\nFinal line without punctuation';
    const chunks = chunkDocumentText(text, 24);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
  });

  it('never splits a Unicode surrogate pair at a hard chunk boundary', () => {
    const text = `${'字'.repeat(449)}😀${'文'.repeat(20)}`;
    const chunks = chunkDocumentText(text, 450);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 450)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
  });

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0)('merges multiple MP3 chunks into one duration-validated playable file', async () => {
    const chunks: Uint8Array[] = [];
    for (const frequency of [440, 660]) {
      const result = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.1`, '-f', 'mp3', 'pipe:1',
      ]);
      expect(result.status).toBe(0);
      chunks.push(new Uint8Array(result.stdout));
    }
    const merged = await mergeAndValidateDocumentAudio(chunks);
    expect(merged.audio.slice(0, 3)).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(merged.durationSeconds).toBeGreaterThan(0.15);
  });

  it('terminates an audio subprocess that exceeds its deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-audio-timeout-'));
    await expect(runDocumentAudioProcess(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      root,
      50,
    )).rejects.toThrow('TTS_FAILED');
  }, 2_000);

  it('stores jobs outside public paths, expires them at 24 hours, and emits prose-free events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const events: DocumentVoiceEvent[] = [];
    const repository = new DocumentVoiceRepository({
      root, now: () => new Date('2026-07-14T10:00:00.000Z'), emit: (event) => { events.push(event); },
    });
    const job = await repository.create({ ownerSubject: '42', name: '../private.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Private prose.') });
    expect(job.source.safeName).toBe('private.txt');
    expect(job.expiresAt).toBe('2026-07-15T10:00:00.000Z');
    expect(await readFile(join(root, job.id, 'source.txt'), 'utf8')).toBe('Private prose.');
    await expect(stat(join(root, job.id, 'job.json'))).resolves.toBeDefined();
    expect(JSON.stringify(events)).not.toContain('Private prose');
    expect(JSON.stringify(events)).not.toContain('private.txt');
    expect(events.map(({ name }) => name)).toEqual(['document_uploaded', 'document_extracted']);
  });

  it('rejects case-insensitive public roots and symlinked storage roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'document-root-'));
    const publicRoot = join(base, 'Public', 'jobs');
    const publicRepository = new DocumentVoiceRepository({ root: publicRoot });
    await expect(publicRepository.list()).rejects.toThrow('Document jobs cannot be stored under a public directory');

    const target = join(base, 'target');
    const linked = join(base, 'linked');
    await mkdir(target);
    await symlink(target, linked, 'junction');
    const linkedRepository = new DocumentVoiceRepository({ root: linked });
    await expect(linkedRepository.list()).rejects.toThrow('Document job storage cannot use symbolic links');
  });

  it('allows only one active job per Telegram user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const input = { ownerSubject: '42', name: 'one.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('One.') };
    await repository.create(input);
    await expect(repository.create({ ...input, name: 'two.txt' })).rejects.toThrow('ACTIVE_JOB_EXISTS');
  });

  it('enforces per-owner daily and retained-job quotas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-quotas-'));
    const repository = new DocumentVoiceRepository({ root, maxDailyJobsPerOwner: 1, maxStoredJobsPerOwner: 2 });
    const first = await repository.create({ ownerSubject: '42', name: 'one.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('One.') });
    await repository.save(DocumentVoiceJobSchema.parse({ ...first, status: 'failed', error: { code: 'TEST', safeMessage: 'Test.' } }));
    await expect(repository.create({ ownerSubject: '42', name: 'two.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Two.') })).rejects.toThrow('DAILY_QUOTA_EXCEEDED');
  });

  it('deletes all job data once the 24-hour retention expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    let now = new Date('2026-07-14T10:00:00.000Z');
    const repository = new DocumentVoiceRepository({ root, now: () => now });
    const job = await repository.create({ ownerSubject: '42', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Private.') });
    now = new Date('2026-07-15T10:00:01.000Z');
    await expect(repository.cleanupExpired()).resolves.toEqual([job.id]);
    await expect(repository.get(job.id)).rejects.toThrow('JOB_NOT_FOUND');
  });

  it('never changes protected latest episode artifacts during a document job', async () => {
    const paths = ['apps/web/public/episodes/latest.json', 'apps/web/public/episodes/latest.mp3'];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const job = await repository.create({ ownerSubject: '42', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Exact words.') });
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    await service.generate(job.id, 'english');
    const after = await Promise.all(paths.map((path) => readFile(path)));
    expect(after).toEqual(before);
  });

  it.each([
    ['english', 'alba', 'pocket-tts'],
    ['chinese_traditional', 'zf_xiaoxiao', 'kokoro'],
  ] as const)('generates %s sequentially through the required local provider', async (language, voice, provider) => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const events: DocumentVoiceEvent[] = [];
    const repository = new DocumentVoiceRepository({ root, emit: (event) => { events.push(event); } });
    const job = await repository.create({
      ownerSubject: '42', name: 'long.txt', mimeType: 'text/plain',
      bytes: new TextEncoder().encode('First exact sentence. Second exact sentence. Third exact sentence.'),
    });
    const active = { count: 0, maximum: 0 };
    const synthesizeWithOutcome = vi.fn(async (text: string, options?: Record<string, string>) => {
      active.count += 1; active.maximum = Math.max(active.maximum, active.count);
      await Promise.resolve(); active.count -= 1;
      return { audio: new Uint8Array([0x49, 0x44, 0x33, text.length]), provider, fallbackUsed: false } as const;
    });
    const finalizeAudio = vi.fn(async (chunks: Uint8Array[]) => ({
      audio: new Uint8Array([0x49, 0x44, 0x33, chunks.length]), durationSeconds: chunks.length,
    }));
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome }, chunkCharacters: 25, finalizeAudio });
    const completed = await service.generate(job.id, language);
    expect(active.maximum).toBe(1);
    expect(synthesizeWithOutcome.mock.calls.length).toBeGreaterThan(1);
    expect(synthesizeWithOutcome.mock.calls.every((call) => {
      const options = call[1] as Record<string, string> | undefined;
      return options?.language === language && options?.voiceId === voice && options?.provider === provider;
    })).toBe(true);
    expect(completed).toMatchObject({ status: 'generated', synthesis: { ttsLanguage: language, voice, provider } });
    expect(completed.synthesis?.durationSeconds).toBe(synthesizeWithOutcome.mock.calls.length);
    expect(finalizeAudio).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Uint8Array)]), expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }));
    expect((await repository.readAudio(job.id)).slice(0, 3)).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(events.map(({ name }) => name)).toContain('generation_completed');
  });

  it('caps Traditional Chinese Kokoro requests at 450 characters without changing text or order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const original = '繁體中文內容依照原文順序朗讀。'.repeat(80);
    expect(original.length).toBeGreaterThan(900);
    const job = await repository.create({
      ownerSubject: 'chinese-limit', name: 'traditional.txt', mimeType: 'text/plain',
      bytes: new TextEncoder().encode(original),
    });
    const emitted: string[] = [];
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn(async (text: string) => {
        emitted.push(text);
        return { audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'kokoro', fallbackUsed: false } as const;
      }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });

    const completed = await service.generate(job.id, 'chinese_traditional');

    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((chunk) => chunk.length <= 450)).toBe(true);
    expect(emitted.join('')).toBe(original);
    expect(completed.synthesis).toMatchObject({
      provider: 'kokoro', totalChunks: emitted.length, completedChunks: emitted.length,
    });
  });

  it('preserves a configured Traditional Chinese chunk limit smaller than 450', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const original = '中文原文。'.repeat(200);
    const job = await repository.create({ ownerSubject: 'small-limit', name: 'small.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode(original) });
    const emitted: string[] = [];
    const service = new DocumentVoiceService({
      repository, chunkCharacters: 320,
      synthesizer: { synthesizeWithOutcome: vi.fn(async (text: string) => {
        emitted.push(text);
        return { audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'kokoro', fallbackUsed: false } as const;
      }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    await service.generate(job.id, 'chinese_traditional');
    expect(emitted.every((chunk) => chunk.length <= 320)).toBe(true);
    expect(emitted.join('')).toBe(original);
  });

  it('keeps the default English request limit at 1500 characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const original = 'a'.repeat(2_100);
    const job = await repository.create({ ownerSubject: 'english-limit', name: 'english.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode(original) });
    const emitted: string[] = [];
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn(async (text: string) => {
        emitted.push(text);
        return { audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false } as const;
      }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    await service.generate(job.id, 'english');
    expect(emitted.map((chunk) => chunk.length)).toEqual([1_500, 600]);
    expect(emitted.join('')).toBe(original);
  });

  it('fails safely on invalid/local failed audio and never reports completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-jobs-'));
    const repository = new DocumentVoiceRepository({ root });
    const job = await repository.create({ ownerSubject: '42', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Private prose.') });
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), provider: 'pocket-tts', fallbackUsed: false }) },
      finalizeAudio: vi.fn(),
    });
    await expect(service.generate(job.id, 'english')).rejects.toThrow('TTS_FAILED');
    expect(await repository.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'TTS_FAILED' } });
    await expect(repository.readAudio(job.id)).rejects.toThrow();
  });
});
