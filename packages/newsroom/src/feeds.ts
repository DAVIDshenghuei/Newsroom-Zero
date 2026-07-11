import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { StoryCandidateSchema, type StoryCandidate } from './index.js';

export interface FeedSource {
  id: string;
  name: string;
  url: string;
}

export interface FeedFetcher {
  fetch(source: FeedSource): Promise<string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function text(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const cleaned = stripMarkup(String(value));
    return cleaned || undefined;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    return text(node['#text'] ?? node.__cdata);
  }
  return undefined;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function atomLink(value: unknown): string | undefined {
  const links = list(value as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const alternate = links.find((link) => !link['@_rel'] || link['@_rel'] === 'alternate');
  return text(alternate?.['@_href']) ?? text(alternate);
}

function candidateId(source: FeedSource, externalId: string | undefined, url: string | undefined, headline: string): string {
  const identity = externalId ?? url ?? headline;
  return `feed_${createHash('sha256').update(`${source.id}\0${identity}`).digest('hex')}`;
}

function normalizeEntry(
  entry: Record<string, unknown>,
  source: FeedSource,
  fetchedAt: string,
  format: 'rss' | 'atom',
): StoryCandidate | undefined {
  const headline = text(entry.title);
  const body = text(entry.description ?? entry.summary ?? entry.content ?? entry.encoded);
  if (!headline || !body) return undefined;

  const externalId = text(entry.guid ?? entry.id);
  const url = format === 'atom' ? atomLink(entry.link) : text(entry.link);
  const authorNode = entry.author;
  const author = format === 'atom' && authorNode && typeof authorNode === 'object'
    ? text((authorNode as Record<string, unknown>).name)
    : text(authorNode ?? entry.creator);
  const publishedAt = isoDate(entry.pubDate ?? entry.published ?? entry.updated);
  const result = StoryCandidateSchema.safeParse({
    id: candidateId(source, externalId, url, headline),
    source: source.name,
    sourceUrl: source.url,
    headline,
    body,
    url,
    publishedAt,
    author,
    externalId,
    fetchedAt,
    status: 'pending',
  });
  return result.success ? result.data : undefined;
}

export function normalizeFeed(xml: string, source: FeedSource, fetchedAt: string): StoryCandidate[] {
  const document = parser.parse(xml) as Record<string, unknown>;
  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const atom = document.feed as Record<string, unknown> | undefined;
  const entries = channel ? list(channel.item) : list(atom?.entry);
  const format = channel ? 'rss' : 'atom';
  return entries
    .map((entry) => normalizeEntry(entry as Record<string, unknown>, source, fetchedAt, format))
    .filter((entry): entry is StoryCandidate => entry !== undefined);
}

export async function ingestFeeds(
  sources: FeedSource[],
  fetcher: FeedFetcher,
  now: () => Date = () => new Date(),
): Promise<StoryCandidate[]> {
  const candidates: StoryCandidate[] = [];
  for (const source of sources) {
    const xml = await fetcher.fetch(source);
    candidates.push(...normalizeFeed(xml, source, now().toISOString()));
  }
  return candidates;
}
