import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DocumentVoiceJobSchema, DocumentVoiceRepository, DocumentVoiceService, type DocumentVoiceEvent } from '../document-voice.js';
import { DOCUMENT_DELIVERY_TIMEOUT_MS, DOCUMENT_PROGRESS_RETRY_DELAY_MS, DOCUMENT_UNKNOWN_NOTIFICATION_TIMEOUT_MS, DocumentVoiceTelegramFlow, DocumentVoiceWorkQueue } from '../document-telegram.js';

describe('Telegram Document to Voice tracer bullet', () => {
  it('bounds and serializes queued work without blocking enqueue', async () => {
    const order: string[] = [];
    let release!: () => void;
    const queue = new DocumentVoiceWorkQueue(async ({ jobId }) => {
      order.push(`start:${jobId}`);
      if (jobId === 'one') await new Promise<void>((resolve) => { release = resolve; });
      order.push(`end:${jobId}`);
    }, 2);
    await queue.enqueue({ jobId: 'one', ownerSubject: '1', language: 'english' });
    await queue.enqueue({ jobId: 'two', ownerSubject: '2', language: 'english' });
    await expect(queue.enqueue({ jobId: 'three', ownerSubject: '3', language: 'english' })).rejects.toThrow('QUEUE_FULL');
    expect(order).toEqual(['start:one']);
    release();
    await queue.waitForIdle();
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });
  it('reserves capacity before persistence and releases a failed reservation', async () => {
    const queue = new DocumentVoiceWorkQueue(async () => undefined, 1);
    queue.reserve();
    expect(() => queue.reserve()).toThrow('QUEUE_FULL');
    queue.releaseReservation();
    expect(() => queue.reserve()).not.toThrow();
    queue.releaseReservation();
  });
  it('leaves a queue-full job retryable without persisting queued state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-queue-full-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn() } });
    const queue = new DocumentVoiceWorkQueue(async () => undefined, 1);
    queue.reserve();
    let message = 10;
    const telegram = {
      sendMessage: vi.fn(async () => message++), editMessage: vi.fn(),
      downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode('Retryable words.')), sendPrivateAudio: vi.fn(),
    };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram, queue });
    const context = { chatId: '42', userId: '7', chatType: 'private' as const };
    await flow.begin(context);
    await flow.handleDocument(context, { file_id: 'f', file_name: 'x.txt', mime_type: 'text/plain' });
    const languageMarkup = (telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const language = languageMarkup.inline_keyboard[0][0].callback_data;
    await flow.handleCallback({ ...context, messageId: 11 }, language);
    const confirmationMarkup = (telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const generate = confirmationMarkup.inline_keyboard[0][0].callback_data;
    await flow.handleCallback({ ...context, messageId: 12 }, generate);
    const [retryable] = await repository.list();
    expect(retryable.status).toBe('ready_for_language');
    expect(retryable.synthesis).toBeUndefined();
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining('queue is full'));
    queue.releaseReservation();
  });
  it('cancels pending queued work before it starts', async () => {
    const started: string[] = [];
    let release!: () => void;
    const queue = new DocumentVoiceWorkQueue(async ({ jobId }) => {
      started.push(jobId);
      if (jobId === 'one') await new Promise<void>((resolve) => { release = resolve; });
    }, 3);
    await queue.enqueue({ jobId: 'one', ownerSubject: '1', language: 'english' });
    await queue.enqueue({ jobId: 'two', ownerSubject: '2', language: 'english' });
    expect(queue.cancel('two')).toBe(true);
    release();
    await queue.waitForIdle();
    expect(started).toEqual(['one']);
  });
  it('waits for active cancellation completion and clears cancellation state', async () => {
    let queue!: DocumentVoiceWorkQueue;
    let stopped = false;
    queue = new DocumentVoiceWorkQueue(async ({ jobId }) => {
      await new Promise<void>((resolve) => queue.registerActiveCancellation(jobId, () => { stopped = true; resolve(); }));
    });
    await queue.enqueue({ jobId: 'active', ownerSubject: '1', language: 'english' });
    await expect(queue.cancelAndWait('active')).resolves.toBe(true);
    expect(stopped).toBe(true);
    expect(queue.isCancelled('active')).toBe(false);
  });
  it('contains worker and error-reporter failures and continues draining', async () => {
    const ran: string[] = [];
    const queue = new DocumentVoiceWorkQueue(async ({ jobId }) => { if (jobId === 'bad') throw new Error('worker'); ran.push(jobId); }, 3, async () => { throw new Error('reporter'); });
    await queue.enqueue({ jobId: 'bad', ownerSubject: '1', language: 'english' });
    await queue.enqueue({ jobId: 'good', ownerSubject: '2', language: 'english' });
    await queue.waitForIdle();
    expect(ran).toEqual(['good']);
  });

  it('exports a bounded five-minute delivery deadline', () => {
    expect(DOCUMENT_DELIVERY_TIMEOUT_MS).toBe(300_000);
  });

  it('times out a hanging delivery and releases the worker for the next job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-delivery-timeout-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) }, finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }) });
    const jobs = [];
    for (const owner of ['1', '2']) {
      const job = await repository.create({ ownerSubject: owner, name: `${owner}.txt`, mimeType: 'text/plain', bytes: new TextEncoder().encode(owner) });
      jobs.push(await service.generate(job.id, 'english'));
    }
    let delivery = 0;
    const telegram = { sendMessage: vi.fn().mockResolvedValue(1), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn(() => { delivery += 1; return delivery === 1 ? new Promise<number>(() => undefined) : Promise.resolve(22); }) };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram, deliveryTimeoutMs: 5 });
    await flow.recover(); await flow.waitForIdle();
    expect(await repository.get(jobs[0].id)).toMatchObject({ status: 'delivery_unknown' });
    expect(await repository.get(jobs[1].id)).toMatchObject({ status: 'delivered' });
    expect(telegram.sendPrivateAudio).toHaveBeenCalledTimes(2);
  });
  it('runs upload → language → privacy confirmation → progress edit → private MP3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-telegram-'));
    const events: DocumentVoiceEvent[] = [];
    const repository = new DocumentVoiceRepository({ root, emit: (event) => { events.push(event); } });
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    const telegram = {
      sendMessage: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(20).mockResolvedValueOnce(21).mockResolvedValueOnce(22),
      editMessage: vi.fn().mockResolvedValue(22),
      downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode('Exact private words.')),
      sendPrivateAudio: vi.fn().mockResolvedValue(21),
    };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    const context = { chatId: '42', userId: '7', chatType: 'private' as const };

    await flow.begin(context);
    expect(events.map(({ name }) => name)).toEqual(['document_flow_started']);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining('TXT or Markdown'));
    await flow.handleDocument(context, { file_id: 'file-1', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 20 });
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining('Extracted 20 characters'), expect.objectContaining({ inline_keyboard: expect.any(Array) }));
    const languageKeyboard = telegram.sendMessage.mock.calls.at(-1)?.[2];
    expect(languageKeyboard.inline_keyboard.flat().map((button: { text: string }) => button.text)).toEqual(['English', 'Traditional Chinese']);

    const languageData = languageKeyboard.inline_keyboard[0][0].callback_data;
    await expect(flow.handleCallback({ ...context, userId: '8', messageId: 20 }, languageData)).resolves.toBe(false);
    await flow.handleCallback({ ...context, messageId: 20 }, languageData);
    const confirmation = telegram.sendMessage.mock.calls.at(-1)?.[1] as string;
    expect(confirmation).toContain('File: notes.txt');
    expect(confirmation).toContain('Voice language: English');
    expect(confirmation).toContain('Transport: Telegram');
    expect(confirmation).toContain('Processing: Local');
    expect(confirmation).toContain('External fallback: Off');
    expect(confirmation).toContain('Translation: Off');
    const retention = 'Retention target: 24 hours · Cleanup: startup and every 60 seconds while the local bot is online.';
    expect(confirmation).toContain(retention);
    expect(confirmation).not.toContain('Auto-delete: 24 hours');
    expect(confirmation).not.toContain('end-to-end');

    await expect(flow.handleCallback({ ...context, messageId: 20 }, languageData)).resolves.toBe(false);
    const confirmationKeyboard = telegram.sendMessage.mock.calls.at(-1)?.[2];
    const generateData = confirmationKeyboard.inline_keyboard[0][0].callback_data;
    await flow.handleCallback({ ...context, messageId: 21 }, generateData);
    await flow.waitForIdle();
    expect(telegram.editMessage).toHaveBeenCalledWith('42', 22, expect.stringContaining('Delivered'));
    const deliveryCaption = telegram.sendPrivateAudio.mock.calls.at(-1)?.[3] as string;
    expect(deliveryCaption).toContain('Transport: Telegram');
    expect(deliveryCaption).toContain('Processing: Local');
    expect(deliveryCaption).toContain('External fallback: Off');
    expect(deliveryCaption).toContain('Translation: Off');
    expect(deliveryCaption).toContain(retention);
    expect(deliveryCaption).not.toContain('Auto-delete: 24 hours');
    expect(deliveryCaption).not.toMatch(/\bPrivate\b/);
    expect(events.map(({ name }) => name)).toContain('audio_delivered');
  });

  it('rejects uploads outside the alpha contract without downloading them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-telegram-'));
    const repository = new DocumentVoiceRepository({ root });
    const telegram = { sendMessage: vi.fn().mockResolvedValue(1), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
    const flow = new DocumentVoiceTelegramFlow({ repository, service: {} as DocumentVoiceService, telegram });
    const context = { chatId: '42', userId: '7', chatType: 'private' as const };
    await flow.begin(context);
    await flow.handleDocument(context, { file_id: 'x', file_name: 'scan.pdf', mime_type: 'application/pdf', file_size: 100 });
    expect(telegram.downloadFile).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('42', expect.stringContaining('not supported'));
  });

  it('retries delivery of already generated audio without a second synthesis run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-delivery-'));
    const repository = new DocumentVoiceRepository({ root });
    const synthesizeWithOutcome = vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false });
    const service = new DocumentVoiceService({
      repository, synthesizer: { synthesizeWithOutcome },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    let messageId = 10;
    const telegram = {
      sendMessage: vi.fn(async () => messageId++), editMessage: vi.fn().mockResolvedValue(1),
      downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode('Exact words.')),
      sendPrivateAudio: vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(99),
    };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    const context = { chatId: '42', userId: '7', chatType: 'private' as const };
    await flow.begin(context);
    await flow.handleDocument(context, { file_id: 'f', file_name: 'x.txt', mime_type: 'text/plain' });
    const languageMessage = (telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    await flow.handleCallback({ ...context, messageId: 11 }, languageMessage.inline_keyboard[0][0].callback_data);
    const confirmation = (telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const generate = confirmation.inline_keyboard[0][0].callback_data;
    await flow.handleCallback({ ...context, messageId: 12 }, generate);
    await flow.waitForIdle();
    expect((await repository.list())[0]).toMatchObject({ status: 'delivery_unknown', error: { code: 'DELIVERY_STATUS_UNKNOWN' } });
    const recovered = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    await recovered.recover();
    expect(telegram.sendPrivateAudio).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect((telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2]).toBeDefined());
    const retryMarkup = (telegram.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    await recovered.handleCallback({ chatId: '7', userId: '7', chatType: 'private', messageId: 14 }, retryMarkup.inline_keyboard[0][0].callback_data);
    await recovered.waitForIdle();
    expect(synthesizeWithOutcome).toHaveBeenCalledTimes(1);
    expect(telegram.sendPrivateAudio).toHaveBeenCalledTimes(2);
    const [job] = await repository.list();
    expect(job.status).toBe('delivered');
  });

  it('recovers persisted queued jobs in FIFO order with bounded refill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-recovery-'));
    const repository = new DocumentVoiceRepository({ root, maxDailyJobsPerOwner: 10, maxStoredJobsPerOwner: 10 });
    const order: string[] = [];
    const synthesizer = { synthesizeWithOutcome: vi.fn(async (text: string) => {
      order.push(text); return { audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false } as const;
    }) };
    const service = new DocumentVoiceService({ repository, synthesizer, finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }) });
    let crashed: Awaited<ReturnType<DocumentVoiceService['prepare']>> | undefined;
    for (let index = 0; index < 7; index += 1) {
      const job = await repository.create({ ownerSubject: String(index), name: `${index}.txt`, mimeType: 'text/plain', bytes: new TextEncoder().encode(`job-${index}`) });
      const queued = await service.prepare(job.id, 'english');
      if (index === 0) crashed = queued;
    }
    await repository.save(DocumentVoiceJobSchema.parse({ ...crashed!, status: 'generating', synthesis: { ...crashed!.synthesis!, completedChunks: 1, provider: 'pocket-tts', durationSeconds: 3 } }));
    let message = 1;
    const telegram = { sendMessage: vi.fn(async () => message++), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn().mockResolvedValue(1) };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    await flow.recover();
    await flow.waitForIdle();
    expect(order).toEqual(Array.from({ length: 7 }, (_, index) => `job-${index}`));
    expect((await repository.list()).every((job) => job.status === 'delivered')).toBe(true);
  });

  it('persists a safe terminal failure after three progress-message attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-progress-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn() } });
    const job = await repository.create({ ownerSubject: '42', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Words.') });
    await service.prepare(job.id, 'english');
    const telegram = { sendMessage: vi.fn().mockRejectedValue(new Error('offline')), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
    const progressDelay = vi.fn().mockResolvedValue(undefined);
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram, progressDelay });
    await flow.recover(); await flow.waitForIdle();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(3);
    expect(progressDelay).toHaveBeenCalledTimes(2);
    expect(DOCUMENT_PROGRESS_RETRY_DELAY_MS).toBe(500);
    expect(await repository.get(job.id)).toMatchObject({ status: 'failed', error: { code: 'PROGRESS_MESSAGE_FAILED' } });
  });

  it('keeps delivery unknown and continues recovery when the manual retry prompt is offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-unknown-offline-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({
      repository,
      synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) },
      finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }),
    });
    const unknownJob = await repository.create({ ownerSubject: '1', name: 'one.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('One.') });
    const generated = await service.generate(unknownJob.id, 'english');
    await repository.save(DocumentVoiceJobSchema.parse({ ...generated, status: 'delivering', delivery: { attemptId: 'attempt-1' } }));
    const queuedJob = await repository.create({ ownerSubject: '2', name: 'two.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Two.') });
    await service.prepare(queuedJob.id, 'english');
    const telegram = { sendMessage: vi.fn().mockRejectedValue(new Error('offline')), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram, progressDelay: async () => undefined });
    await expect(flow.recover()).resolves.toBeUndefined();
    await flow.waitForIdle();
    expect(await repository.get(unknownJob.id)).toMatchObject({ status: 'delivery_unknown', error: { code: 'DELIVERY_STATUS_UNKNOWN' } });
    expect(await repository.get(queuedJob.id)).toMatchObject({ status: 'failed', error: { code: 'PROGRESS_MESSAGE_FAILED' } });
    expect(flow.isActive('1')).toBe(false);
    expect(telegram.sendPrivateAudio).not.toHaveBeenCalled();
  });

  it('does not await a hanging unknown-delivery notification', async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), 'document-unknown-hang-'));
      const repository = new DocumentVoiceRepository({ root });
      const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) }, finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }) });
      const job = await repository.create({ ownerSubject: '1', name: 'one.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('One.') });
      const generated = await service.generate(job.id, 'english');
      await repository.save(DocumentVoiceJobSchema.parse({ ...generated, status: 'delivery_unknown', delivery: { attemptId: 'a' } }));
      let notificationSignal: AbortSignal | undefined;
      const telegram = { sendMessage: vi.fn((_chat, _text, _markup, signal) => { notificationSignal = signal; return new Promise<number>(() => undefined); }), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
      const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
      await expect(flow.recover()).resolves.toBeUndefined();
      expect(await repository.get(job.id)).toMatchObject({ status: 'delivery_unknown' });
      await vi.advanceTimersByTimeAsync(DOCUMENT_UNKNOWN_NOTIFICATION_TIMEOUT_MS);
      expect(notificationSignal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('serializes cancellation before the delivering transition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-delivery-race-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), provider: 'pocket-tts', fallbackUsed: false }) }, finalizeAudio: vi.fn().mockResolvedValue({ audio: new Uint8Array([0x49, 0x44, 0x33, 1]), durationSeconds: 1 }) });
    let release!: () => void; let reached!: () => void;
    const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let message = 10;
    const telegram = { sendMessage: vi.fn(async () => message++), editMessage: vi.fn(), downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode('Words.')), sendPrivateAudio: vi.fn().mockResolvedValue(99) };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram, beforeDeliveryTransition: async () => { reached(); await barrier; } });
    const context = { chatId: '7', userId: '7', chatType: 'private' as const };
    await flow.begin(context); await flow.handleDocument(context, { file_id: 'f', file_name: 'x.txt', mime_type: 'text/plain' });
    const language = (telegram.sendMessage.mock.calls.at(-1) as unknown[])[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    await flow.handleCallback({ ...context, messageId: 11 }, language.inline_keyboard[0][0].callback_data);
    const controls = (telegram.sendMessage.mock.calls.at(-1) as unknown[])[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    await flow.handleCallback({ ...context, messageId: 12 }, controls.inline_keyboard[0][0].callback_data);
    await atBarrier;
    const cancelling = flow.handleCallback({ ...context, messageId: 12 }, controls.inline_keyboard[1][1].callback_data);
    release(); await cancelling; await flow.waitForIdle();
    expect(telegram.sendPrivateAudio).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('7', 'Document conversion cancelled and deleted.');
  });

  it('reconstructs controls for an existing queued owner job on re-entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-reentry-'));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn() } });
    const job = await repository.create({ ownerSubject: '7', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Words.') });
    await service.prepare(job.id, 'english');
    const telegram = { sendMessage: vi.fn().mockResolvedValue(20), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    await flow.begin({ chatId: '7', userId: '7', chatType: 'private' });
    expect(telegram.sendMessage).toHaveBeenCalledWith('7', expect.stringContaining('queued or generating'), expect.objectContaining({ inline_keyboard: expect.any(Array) }));
    expect((await repository.list())).toHaveLength(1);
  });

  it.each(['get', 'delete'] as const)('fails closed when cancellation %s verification fails', async (failure) => {
    const root = await mkdtemp(join(tmpdir(), `document-cancel-${failure}-`));
    const repository = new DocumentVoiceRepository({ root });
    const service = new DocumentVoiceService({ repository, synthesizer: { synthesizeWithOutcome: vi.fn() } });
    const job = await repository.create({ ownerSubject: '7', name: 'x.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('Words.') });
    await service.prepare(job.id, 'english');
    const telegram = { sendMessage: vi.fn().mockResolvedValue(20), editMessage: vi.fn(), downloadFile: vi.fn(), sendPrivateAudio: vi.fn() };
    const flow = new DocumentVoiceTelegramFlow({ repository, service, telegram });
    await flow.begin({ chatId: '7', userId: '7', chatType: 'private' });
    const controls = (telegram.sendMessage.mock.calls.at(-1) as unknown[])[2] as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    if (failure === 'get') {
      const original = repository.get.bind(repository); let calls = 0;
      vi.spyOn(repository, 'get').mockImplementation(async (id) => { calls += 1; if (calls === 2) throw new Error('io'); return original(id); });
    } else vi.spyOn(repository, 'delete').mockRejectedValue(new Error('permission'));
    await flow.handleCallback({ chatId: '7', userId: '7', chatType: 'private', messageId: 20 }, controls.inline_keyboard[0][0].callback_data);
    expect(telegram.sendMessage).toHaveBeenLastCalledWith('7', 'Cancellation could not be confirmed. Your document may still be retained. Please try again.');
    expect(flow.isActive('7')).toBe(true);
    expect(telegram.sendMessage).not.toHaveBeenCalledWith('7', 'Document conversion cancelled and deleted.');
  });
});
