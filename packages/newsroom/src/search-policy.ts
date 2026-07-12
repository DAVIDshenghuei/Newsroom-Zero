import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PublicationWindow } from './linkup.js';

const TrimmedNonEmptyStringSchema = z.string().trim().min(1);
const SourceSchema = z.object({
  name: TrimmedNonEmptyStringSchema,
  domain: TrimmedNonEmptyStringSchema,
}).strict();
const SourceTiersSchema = z.object({
  tier1: z.array(SourceSchema).min(1), tier2: z.array(SourceSchema).default([]), tier3: z.array(SourceSchema).default([]),
}).strict();
export const TopicProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), topicLabel: TrimmedNonEmptyStringSchema, menuLabel: TrimmedNonEmptyStringSchema,
  sourceTiers: SourceTiersSchema, activeSearchTiers: z.array(z.enum(['tier1', 'tier2'])).min(1),
  excludedSources: z.array(SourceSchema).default([]), includeKeywords: z.array(TrimmedNonEmptyStringSchema).min(1),
  excludeKeywords: z.array(TrimmedNonEmptyStringSchema), suggestedTimeRange: z.enum(['24h', '3d', '7d']),
}).strict();
export type TopicProfile = z.infer<typeof TopicProfileSchema>;
export const AnalysisPolicySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), menuLabel: TrimmedNonEmptyStringSchema,
  mustInclude: z.array(TrimmedNonEmptyStringSchema).min(1), prefer: z.array(TrimmedNonEmptyStringSchema), exclude: z.array(TrimmedNonEmptyStringSchema),
}).strict();
export type AnalysisPolicy = z.infer<typeof AnalysisPolicySchema>;
export const SearchPolicySchema = z.object({
  topicId: z.string(), topicLabel: z.string(), analysisId: z.string(), analysisLabel: z.string(),
  publicationWindow: z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict(),
  topicKeywords: z.array(z.string()), analysisKeywords: z.array(z.string()), preferredKeywords: z.array(z.string()),
  excludedKeywords: z.array(z.string()), activeSources: z.array(SourceSchema.extend({ tier: z.enum(['tier1', 'tier2']) })),
  excludedSources: z.array(SourceSchema),
}).strict();
export type SearchPolicy = z.infer<typeof SearchPolicySchema>;

const configRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../config/search-policies');
async function loadDirectory<T>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
  const names = (await readdir(resolve(configRoot, directory))).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => schema.parse(JSON.parse(await readFile(resolve(configRoot, directory, name), 'utf8')))));
}
export const loadTopicProfiles = () => loadDirectory('topics', TopicProfileSchema);
export const loadAnalysisPolicies = () => loadDirectory('analyses', AnalysisPolicySchema);

export async function composeSearchPolicy(topicLabel: string, analysisLabel: string, publicationWindow: PublicationWindow): Promise<SearchPolicy> {
  const [topics, analyses] = await Promise.all([loadTopicProfiles(), loadAnalysisPolicies()]);
  const topic = topics.find((item) => item.menuLabel === topicLabel);
  const analysis = analyses.find((item) => item.menuLabel === analysisLabel);
  if (!topic) throw new Error(`Unknown topic profile: ${topicLabel}`);
  if (!analysis) throw new Error(`Unknown analysis policy: ${analysisLabel}`);
  const activeSources = topic.activeSearchTiers.flatMap((tier) => (topic.sourceTiers[tier] ?? []).map((source) => ({ ...source, tier })));
  return SearchPolicySchema.parse({
    topicId: topic.id, topicLabel: topic.topicLabel, analysisId: analysis.id, analysisLabel: analysis.menuLabel,
    publicationWindow, topicKeywords: topic.includeKeywords, analysisKeywords: analysis.mustInclude,
    preferredKeywords: analysis.prefer, excludedKeywords: [...topic.excludeKeywords, ...analysis.exclude],
    activeSources, excludedSources: topic.excludedSources,
  });
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function evaluatePolicyText(text: string, terms: string[]): string[] {
  return terms.filter((term) => {
    const normalizedTerm = term.trim();
    if (!normalizedTerm) return false;
    const escaped = escapeRegex(normalizedTerm).replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text.normalize('NFKC'));
  });
}
export function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const normalizedDomain = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}
export function buildSearchQuery(policy: SearchPolicy): string {
  const quote = (term: string) => `"${term.replaceAll('"', '')}"`;
  const topic = policy.topicKeywords.map(quote).join(' OR ');
  const analysis = policy.analysisKeywords.map(quote).join(' OR ');
  return `(${topic}) (${analysis}) English news`;
}

export type PolicyRejectionReason = 'source domain not allowed' | 'excluded source domain' | 'missing topic keyword' | 'missing analysis keyword' | 'excluded keyword';
export interface PolicyCandidateInput { id: string; url?: string; name: string; content: string; original?: string }
export interface PolicyFilterItem { id: string; url?: string; accepted: boolean; reasons: PolicyRejectionReason[]; matchedTopicTerms: string[]; matchedAnalysisTerms: string[]; matchedPreferredTerms: string[]; matchedExcludedTerms: string[]; sourceTier?: 'tier1' | 'tier2' }
export interface SearchPolicyFilterReport { eligibleIds: string[]; rejected: PolicyFilterItem[]; evaluated: PolicyFilterItem[] }
export function filterBySearchPolicy(candidates: PolicyCandidateInput[], policy: SearchPolicy): SearchPolicyFilterReport {
  const evaluated = candidates.map((candidate): PolicyFilterItem => {
    let host = '';
    try { host = candidate.url ? new URL(candidate.url).hostname : ''; } catch { /* rejected below */ }
    const excludedSource = policy.excludedSources.some(({ domain }) => hostMatchesDomain(host, domain));
    const source = policy.activeSources.find(({ domain }) => hostMatchesDomain(host, domain));
    const text = `${candidate.name}\n${candidate.content}\n${candidate.original ?? ''}`;
    const matchedTopicTerms = evaluatePolicyText(text, policy.topicKeywords);
    const matchedAnalysisTerms = evaluatePolicyText(text, policy.analysisKeywords);
    const matchedPreferredTerms = evaluatePolicyText(text, policy.preferredKeywords);
    const matchedExcludedTerms = evaluatePolicyText(text, policy.excludedKeywords);
    const reasons: PolicyRejectionReason[] = [];
    if (excludedSource) reasons.push('excluded source domain');
    else if (!source) reasons.push('source domain not allowed');
    if (!matchedTopicTerms.length) reasons.push('missing topic keyword');
    if (!matchedAnalysisTerms.length) reasons.push('missing analysis keyword');
    if (matchedExcludedTerms.length) reasons.push('excluded keyword');
    return { id: candidate.id, url: candidate.url, accepted: reasons.length === 0, reasons, matchedTopicTerms, matchedAnalysisTerms, matchedPreferredTerms, matchedExcludedTerms, sourceTier: source?.tier };
  });
  return { eligibleIds: evaluated.filter((item) => item.accepted).map(({ id }) => id), rejected: evaluated.filter((item) => !item.accepted), evaluated };
}
