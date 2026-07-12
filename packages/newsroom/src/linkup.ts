import { z } from 'zod';
import type { RankedStory } from './pipeline.js';

export const LinkupSearchResultSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  content: z.string(),
  type: z.string().min(1),
  favicon: z.string().url().optional(),
}).strict();
export type LinkupSearchResult = z.infer<typeof LinkupSearchResultSchema>;

const LinkupSearchResponseSchema = z.object({
  results: z.array(LinkupSearchResultSchema),
}).strict();

const LinkupFetchResponseSchema = z.object({
  markdown: z.string(),
  images: z.array(z.object({ alt: z.string(), url: z.string().url() })).optional(),
  rawHtml: z.string().optional(),
}).strict();

export const LinkupEvidenceSchema = z.object({
  storyId: z.string().min(1),
  query: z.string().min(1),
  searchResults: z.array(LinkupSearchResultSchema),
  original: z.object({
    url: z.string().url(),
    markdown: z.string().min(1).optional(),
  }).strict(),
  verificationStatus: z.enum(['pending', 'verified', 'failed']),
  errors: z.array(z.string()),
}).strict();
export type LinkupEvidence = z.infer<typeof LinkupEvidenceSchema>;
export interface LinkupFetchedDocument { markdown: string; rawHtml?: string }

export interface PublicationWindow { from: string; to: string }

export interface LinkupResearchClient {
  search(query: string, window?: PublicationWindow): Promise<LinkupSearchResult[]>;
  fetch(url: string): Promise<string>;
  fetchDocument?(url: string): Promise<LinkupFetchedDocument>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinkupClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class LinkupClient implements LinkupResearchClient {
  private readonly apiKey: string;
  private readonly fetchImplementation: FetchLike;
  private readonly baseUrl: string;

  constructor(options: LinkupClientOptions) {
    if (!options.apiKey.trim()) throw new Error('Linkup API key is required');
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.linkup.so').replace(/\/$/, '');
  }

  async search(query: string, window?: PublicationWindow): Promise<LinkupSearchResult[]> {
    const value = await this.post('/v1/search', {
      q: query, depth: 'standard', outputType: 'searchResults',
      ...(window ? { fromDate: window.from.slice(0, 10), toDate: window.to.slice(0, 10) } : {}),
    }, LinkupSearchResponseSchema, 'search');
    return value.results;
  }

  async fetch(url: string): Promise<string> {
    return (await this.fetchWithRetries(url, false)).markdown;
  }

  async fetchDocument(url: string): Promise<LinkupFetchedDocument> {
    return this.fetchWithRetries(url, true);
  }

  private async fetchWithRetries(url: string, includeRawHtml: boolean): Promise<LinkupFetchedDocument> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const value = await this.post('/v1/fetch', {
          url, extractImages: false, includeRawHtml, renderJs: false,
        }, LinkupFetchResponseSchema, 'fetch');
        return { markdown: value.markdown, ...(value.rawHtml ? { rawHtml: value.rawHtml } : {}) };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : '';
        const transient = message.startsWith('Linkup fetch request failed:')
          || /Linkup fetch request failed with status 5\d\d/.test(message);
        if (!transient || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>, operation: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(this.safeMessage(`Linkup ${operation} request failed`, error));
    }
    if (!response.ok) throw new Error(`Linkup ${operation} request failed with status ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`Invalid Linkup ${operation} response`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`Invalid Linkup ${operation} response`);
    return parsed.data;
  }

  private safeMessage(fallback: string, error: unknown): string {
    if (!(error instanceof Error) || !error.message) return fallback;
    return `${fallback}: ${error.message.replaceAll(this.apiKey, '[REDACTED]')}`;
  }
}

const toIso = (value: string): string | undefined => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

/** Extract only explicitly labelled or machine-readable publication dates. */
export function extractPublishedAt(content: string): string | undefined {
  const machinePatterns = [
    /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
    /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|datePublished)["'][^>]*>/i,
    /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i,
  ];
  for (const pattern of machinePatterns) {
    const match = content.match(pattern);
    if (match) return toIso(match[1]);
  }
  const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const visiblePatterns = [
    new RegExp(`\\b(?:Published|Posted)\\s*(?:on)?[:\\s]+(${month}\\s+\\d{1,2},\\s+\\d{4})\\b`, 'i'),
    new RegExp(`\\b(?:Published|Posted)\\s*(?:on)?[:\\s]+(\\d{1,2}\\s+${month}\\s+\\d{4})\\b`, 'i'),
  ];
  for (const pattern of visiblePatterns) {
    const match = content.match(pattern);
    if (match) return toIso(`${match[1]} UTC`);
  }
  return undefined;
}

const safeEvidenceError = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Unknown Linkup error';

export async function gatherLinkupSearchEvidence(
  stories: RankedStory[], client: Pick<LinkupResearchClient, 'search'>,
  window?: PublicationWindow,
): Promise<LinkupEvidence[]> {
  return Promise.all(stories.map(async (story) => {
    const query = `${story.headline.trim()} ${story.source.trim()}`;
    try {
      return LinkupEvidenceSchema.parse({
        storyId: story.id, query, searchResults: await client.search(query, window),
        original: { url: story.canonicalUrl }, verificationStatus: 'pending', errors: [],
      });
    } catch (error) {
      return LinkupEvidenceSchema.parse({
        storyId: story.id, query, searchResults: [], original: { url: story.canonicalUrl },
        verificationStatus: 'pending', errors: [safeEvidenceError(error)],
      });
    }
  }));
}

export async function verifyLinkupOriginals(
  evidence: LinkupEvidence[], client: Pick<LinkupResearchClient, 'fetch'>,
): Promise<LinkupEvidence[]> {
  return Promise.all(evidence.map(async (item) => {
    try {
      const markdown = await client.fetch(item.original.url);
      return LinkupEvidenceSchema.parse({
        ...item, original: { ...item.original, markdown },
        verificationStatus: markdown.trim() ? 'verified' : 'failed',
        errors: markdown.trim() ? item.errors : [...item.errors, 'Linkup fetch returned empty markdown'],
      });
    } catch (error) {
      return LinkupEvidenceSchema.parse({
        ...item, verificationStatus: 'failed', errors: [...item.errors, safeEvidenceError(error)],
      });
    }
  }));
}

export async function gatherLinkupEvidence(
  stories: RankedStory[], client: LinkupResearchClient,
): Promise<LinkupEvidence[]> {
  return verifyLinkupOriginals(await gatherLinkupSearchEvidence(stories, client), client);
}
