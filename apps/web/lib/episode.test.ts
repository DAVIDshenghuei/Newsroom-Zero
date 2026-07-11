import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLatestEpisode } from './episode';

describe('loadLatestEpisode', () => {
  it('loads valid public episode metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'newsroom-episode-'));
    const path = join(directory, 'latest.json');
    await writeFile(path, JSON.stringify({
      title: 'Daily bulletin', generatedAt: '2026-07-11T15:00:00.000Z',
      audioUrl: '/episodes/latest.mp3',
      stories: [{ headline: 'Headline', source: 'Wire', url: 'https://news.test/story' }],
      factGate: {
        id: 'gate', checkedAt: '2026-07-11T14:59:00.000Z', approved: true,
        scriptStatus: 'ready_for_voice', reasons: [],
      },
    }));
    await expect(loadLatestEpisode(path)).resolves.toMatchObject({ title: 'Daily bulletin' });
  });

  it('returns an empty state for missing or malformed metadata', async () => {
    await expect(loadLatestEpisode('/definitely/missing/latest.json')).resolves.toBeNull();
  });
});
