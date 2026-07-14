import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');

describe('Private Listening Studio brand contract', () => {
  it('pins the approved promise, modes, and processing disclosures', async () => {
    const [readme, page, layout] = await Promise.all([
      read('README.md'), read('apps/web/app/page.tsx'), read('apps/web/app/layout.tsx'),
    ]);
    const headline = 'Important reading, ready to listen.';
    const descriptor = 'Trusted news and your own documents, turned into portable audio.';

    expect(readme).toContain(headline);
    expect(readme).toContain(descriptor);
    expect(page).toContain(headline);
    expect(page).toContain(descriptor);
    expect(layout).toContain(descriptor);
    for (const required of [
      'Create a News Briefing', 'Turn a Document into Audio',
      'Transport: Telegram', 'Processing: Local', 'External fallback: Off',
      'Translation: Off',
      'Retention target: 24 hours · Cleanup: startup and every 60 seconds while the local bot is online.',
    ]) expect(page).toContain(required);
    expect(`${readme}\n${page}`).not.toContain('Auto-delete: 24 hours');
    expect(`${readme}\n${page}`.toLowerCase()).not.toMatch(/automatic deletion|automatically deleted|automatically delete/);
  });

  it('rejects inaccurate privacy, document-format, and licensing claims', async () => {
    const content = (await Promise.all([
      read('README.md'), read('apps/web/app/page.tsx'), read('apps/web/app/layout.tsx'),
    ])).join('\n').toLowerCase();

    expect(content).not.toContain('end-to-end private');
    expect(content).not.toContain('never leaves your device');
    expect(content).not.toMatch(/document.{0,50}\b(pdf|docx|ocr)\b|\b(pdf|docx|ocr)\b.{0,50}document/);
    expect(content).not.toMatch(/\bopen[ -]source\b/);
  });
});
