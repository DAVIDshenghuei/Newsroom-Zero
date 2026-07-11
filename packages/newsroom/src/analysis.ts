import { z } from 'zod';
import type { LinkupEvidence } from './linkup.js';
import {
  BulletinScriptSchema, FactGateDecisionSchema, runResearchFactGate, writeBulletinScript,
  type BulletinScript, type FactGateDecision, type RankedStory,
} from './pipeline.js';

const SourceIdsSchema = z.array(z.string().min(1)).min(1);

export const CitedAnalysisItemSchema = z.object({
  text: z.string().min(1),
  sourceStoryIds: SourceIdsSchema,
}).strict();
export type CitedAnalysisItem = z.infer<typeof CitedAnalysisItemSchema>;

export const StoryBriefSchema = z.object({
  storyId: z.string().min(1),
  headline: z.string().min(1),
  summary: z.string().min(1),
  sourceStoryIds: SourceIdsSchema,
}).strict();

export const LlmAnalysisSchema = z.object({
  title: z.string().min(1),
  executiveSummary: CitedAnalysisItemSchema,
  storyBriefs: z.array(StoryBriefSchema).min(1),
  crossStoryTrends: z.array(CitedAnalysisItemSchema).min(1),
  strategicImplications: z.array(CitedAnalysisItemSchema).min(1),
  actionableRecommendations: z.array(CitedAnalysisItemSchema).min(1),
}).strict();
export type LlmAnalysis = z.infer<typeof LlmAnalysisSchema>;

export interface AnalysisPreferences {
  topics: string;
  analysisAngles: string;
  timeRange: 'Past 24 Hours' | 'Past 3 Days' | 'Past 7 Days';
}

export interface AnalysisInput {
  preferences: AnalysisPreferences;
  stories: RankedStory[];
  evidence: LinkupEvidence[];
}

export interface AnalysisGenerator {
  generate(input: AnalysisInput): Promise<LlmAnalysis>;
}

const sourceTextLimit = 14_000;

export function buildAnalysisPrompt(input: AnalysisInput): string {
  const evidenceByStory = new Map(input.evidence.map((item) => [item.storyId, item]));
  const sources = input.stories.map((story) => {
    const evidence = evidenceByStory.get(story.id);
    return {
      storyId: story.id,
      source: story.source,
      headline: story.headline,
      canonicalUrl: story.canonicalUrl,
      verifiedOriginalText: evidence?.original.markdown?.slice(0, sourceTextLimit) ?? '',
    };
  });
  return [
    'Create a concise, natural English audio-news analysis using only the verified sources below.',
    'Do not use outside knowledge. Do not invent facts, numbers, quotations, entities, or sources.',
    'Every factual item must cite one or more sourceStoryIds from the supplied sources.',
    'Return JSON only. Do not add commentary before or after the JSON.',
    `Listener topics: ${input.preferences.topics}`,
    `Requested analysis angle: ${input.preferences.analysisAngles}`,
    `News range: ${input.preferences.timeRange}`,
    'Required exact JSON shape:',
    JSON.stringify({
      title: 'string',
      executiveSummary: { text: 'string', sourceStoryIds: ['story-id'] },
      storyBriefs: [{ storyId: 'story-id', headline: 'string', summary: 'string', sourceStoryIds: ['story-id'] }],
      crossStoryTrends: [{ text: 'string', sourceStoryIds: ['story-id'] }],
      strategicImplications: [{ text: 'string', sourceStoryIds: ['story-id'] }],
      actionableRecommendations: [{ text: 'string', sourceStoryIds: ['story-id'] }],
    }),
    'Verified sources:',
    JSON.stringify(sources),
  ].join('\n\n');
}

const AnthropicResponseSchema = z.object({
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  }).passthrough()).min(1),
}).passthrough();

const stripFence = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
};

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';

export interface AnthropicAnalysisGeneratorOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

export class AnthropicAnalysisGenerator implements AnalysisGenerator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AnthropicAnalysisGeneratorOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic API credential is required');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async generate(input: AnalysisInput): Promise<LlmAnalysis> {
    let response: Response;
    try {
      response = await this.request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 3_500,
          temperature: 0,
          messages: [{ role: 'user', content: buildAnalysisPrompt(input) }],
        }),
      });
    } catch (error) {
      throw new Error(`Anthropic analysis request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    if (!response.ok) throw new Error(`Anthropic analysis request failed with status ${response.status}`);
    try {
      const message = AnthropicResponseSchema.parse(await response.json());
      const text = message.content.find((item) => item.type === 'text' && item.text)?.text;
      if (!text) throw new Error('missing text content');
      return LlmAnalysisSchema.parse(JSON.parse(stripFence(text)));
    } catch {
      throw new Error('Invalid Anthropic analysis response');
    }
  }
}

const analysisItems = (analysis: LlmAnalysis): Array<CitedAnalysisItem & { label: string }> => [
  { ...analysis.executiveSummary, label: 'Executive summary' },
  ...analysis.storyBriefs.map((item) => ({ text: `${item.headline}. ${item.summary}`, sourceStoryIds: item.sourceStoryIds, label: 'Story brief' })),
  ...analysis.crossStoryTrends.map((item) => ({ ...item, label: 'Cross-story trend' })),
  ...analysis.strategicImplications.map((item) => ({ ...item, label: 'Strategic implication' })),
  ...analysis.actionableRecommendations.map((item) => ({ ...item, label: 'Actionable recommendation' })),
];

export function runAnalysisFactGate(
  value: unknown,
  stories: RankedStory[],
  evidence: LinkupEvidence[],
  checkedAt: string,
): FactGateDecision {
  const sourceGate = runResearchFactGate(writeBulletinScript(stories, checkedAt), stories, evidence, checkedAt);
  const reasons = [...sourceGate.reasons];
  const parsed = LlmAnalysisSchema.safeParse(value);
  if (!parsed.success) reasons.push('invalid structured analysis or missing claim citations');
  if (parsed.success) {
    const known = new Set(stories.map((story) => story.id));
    const verified = new Set(evidence
      .filter((item) => item.verificationStatus === 'verified' && item.original.markdown?.trim())
      .map((item) => item.storyId));
    for (const item of analysisItems(parsed.data)) {
      for (const sourceStoryId of item.sourceStoryIds) {
        if (!known.has(sourceStoryId)) reasons.push(`${item.label}: unknown source story ${sourceStoryId}`);
        else if (!verified.has(sourceStoryId)) reasons.push(`${item.label}: source story ${sourceStoryId} is not verified`);
      }
    }
    for (const brief of parsed.data.storyBriefs) {
      if (!known.has(brief.storyId)) reasons.push(`Story brief: unknown story ${brief.storyId}`);
    }
  }
  const approved = reasons.length === 0;
  return FactGateDecisionSchema.parse({
    id: `analysis-fact-gate-${checkedAt}`,
    checkedAt,
    approved,
    scriptStatus: approved ? 'ready_for_voice' : 'blocked',
    reasons,
  });
}

export function writeAnalysisBulletinScript(
  value: LlmAnalysis,
  stories: RankedStory[],
  createdAt: string,
  status: 'ready_for_voice' | 'blocked' | 'draft' = 'draft',
): BulletinScript {
  const analysis = LlmAnalysisSchema.parse(value);
  const storyById = new Map(stories.map((story) => [story.id, story]));
  const factual = analysisItems(analysis).map((item, index) => ({
    id: `analysis-segment-${index + 1}`,
    kind: 'factual' as const,
    text: `${item.label}. ${item.text}`,
    citations: item.sourceStoryIds.map((storyId) => {
      const story = storyById.get(storyId);
      if (!story) throw new Error(`Unknown analysis source story: ${storyId}`);
      return { storyId, url: story.canonicalUrl, text: item.text };
    }),
  }));
  return BulletinScriptSchema.parse({
    id: `analysis-script-${createdAt}`,
    createdAt,
    status,
    segments: [
      { id: 'analysis-intro', kind: 'transition', text: `${analysis.title}.`, citations: [] },
      ...factual,
    ],
  });
}
