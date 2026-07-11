import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { TelegramClient } from './telegram.js';

const EpisodeMetadataSchema = z.object({
  title: z.string().min(1),
  factGate: z.object({ approved: z.boolean() }),
  stories: z.array(z.object({
    source: z.string().optional(),
    headline: z.string().optional(),
    url: z.string().url(),
  })),
});

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is required');

  const episodes = resolve(process.cwd(), 'apps/web/public/episodes');
  const [metadataJson, audio] = await Promise.all([
    readFile(resolve(episodes, 'latest.json'), 'utf8'),
    readFile(resolve(episodes, 'latest.mp3')),
  ]);
  const metadata = EpisodeMetadataSchema.parse(JSON.parse(metadataJson));
  const messageId = await new TelegramClient({ token }).publish({ chatId, metadata, audio });
  console.log(`Published Telegram message ${messageId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Telegram publication failed');
  process.exitCode = 1;
});
