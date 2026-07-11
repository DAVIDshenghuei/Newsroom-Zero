import { describe, it, expect } from 'vitest';
import {
  StoryCandidateSchema,
  VerifiedClaimSchema,
  FactGateResultSchema,
  RundownSchema,
  EditionStatusSchema,
} from '../index.js';

// ─── StoryCandidate ───────────────────────────────────────────

describe('StoryCandidateSchema', () => {
  it('accepts a valid pending story', () => {
    const input = {
      id: 'story-1',
      source: 'rss://example.com',
      headline: 'Breaking News',
      body: 'Some article body text.',
      url: 'https://example.com/article',
      fetchedAt: '2026-07-11T12:00:00Z',
      status: 'pending',
    };
    const result = StoryCandidateSchema.parse(input);
    expect(result.id).toBe('story-1');
    expect(result.status).toBe('pending');
  });

  it('accepts a story without a URL', () => {
    const input = {
      id: 'story-2',
      source: 'twitter',
      headline: 'Short Update',
      body: 'Body text.',
      fetchedAt: '2026-07-11T12:00:00Z',
      status: 'selected',
    };
    const result = StoryCandidateSchema.parse(input);
    expect(result.url).toBeUndefined();
  });

  it('rejects a story missing headline', () => {
    const input = {
      id: 'story-3',
      source: 'twitter',
      body: 'Body text.',
      fetchedAt: '2026-07-11T12:00:00Z',
      status: 'pending',
    };
    expect(() => StoryCandidateSchema.parse(input)).toThrow();
  });

  it('rejects an invalid status value', () => {
    const input = {
      id: 'story-4',
      source: 'twitter',
      headline: 'Bad Status',
      body: 'Body.',
      fetchedAt: '2026-07-11T12:00:00Z',
      status: 'archived',
    };
    expect(() => StoryCandidateSchema.parse(input)).toThrow();
  });

  it('rejects a non-datetime fetchedAt', () => {
    const input = {
      id: 'story-5',
      source: 'twitter',
      headline: 'Bad date',
      body: 'Body.',
      fetchedAt: 'not-a-date',
      status: 'pending',
    };
    expect(() => StoryCandidateSchema.parse(input)).toThrow();
  });
});

// ─── VerifiedClaim ──────────────────────────────────────────────

describe('VerifiedClaimSchema', () => {
  it('accepts a valid claim with evidence', () => {
    const input = {
      id: 'claim-1',
      storyId: 'story-1',
      claim: 'The sky is blue',
      verdict: 'true',
      evidence: 'Scientific consensus',
      verifiedAt: '2026-07-11T12:00:00Z',
    };
    const result = VerifiedClaimSchema.parse(input);
    expect(result.verdict).toBe('true');
  });

  it('accepts a claim without evidence', () => {
    const input = {
      id: 'claim-2',
      storyId: 'story-1',
      claim: 'Unverified claim',
      verdict: 'unverifiable',
      verifiedAt: '2026-07-11T12:00:00Z',
    };
    const result = VerifiedClaimSchema.parse(input);
    expect(result.evidence).toBeUndefined();
  });

  it('rejects an invalid verdict', () => {
    const input = {
      id: 'claim-3',
      storyId: 'story-1',
      claim: 'Bad verdict',
      verdict: 'maybe',
      verifiedAt: '2026-07-11T12:00:00Z',
    };
    expect(() => VerifiedClaimSchema.parse(input)).toThrow();
  });
});

// ─── FactGateResult ─────────────────────────────────────────────

describe('FactGateResultSchema', () => {
  it('accepts a passing gate result with claims', () => {
    const input = {
      id: 'fg-1',
      storyId: 'story-1',
      passed: true,
      claims: [
        {
          id: 'claim-1',
          storyId: 'story-1',
          claim: 'Claim text',
          verdict: 'true',
          verifiedAt: '2026-07-11T12:00:00Z',
        },
      ],
      overallVerdict: 'approved',
      checkedAt: '2026-07-11T12:30:00Z',
    };
    const result = FactGateResultSchema.parse(input);
    expect(result.passed).toBe(true);
    expect(result.claims).toHaveLength(1);
  });

  it('accepts a gate result with no claims', () => {
    const input = {
      id: 'fg-2',
      storyId: 'story-2',
      passed: false,
      claims: [],
      overallVerdict: 'rejected',
      checkedAt: '2026-07-11T12:30:00Z',
    };
    const result = FactGateResultSchema.parse(input);
    expect(result.passed).toBe(false);
  });
});

// ─── Rundown ─────────────────────────────────────────────────────

describe('RundownSchema', () => {
  it('accepts a draft rundown', () => {
    const input = {
      id: 'rundown-1',
      editionId: 'edition-1',
      stories: ['story-1', 'story-2'],
      createdAt: '2026-07-11T12:00:00Z',
      status: 'draft',
    };
    const result = RundownSchema.parse(input);
    expect(result.stories).toHaveLength(2);
  });

  it('accepts a published rundown', () => {
    const input = {
      id: 'rundown-2',
      editionId: 'edition-1',
      stories: [],
      createdAt: '2026-07-11T12:00:00Z',
      status: 'published',
    };
    const result = RundownSchema.parse(input);
    expect(result.status).toBe('published');
  });

  it('rejects an invalid rundown status', () => {
    const input = {
      id: 'rundown-3',
      editionId: 'edition-1',
      stories: [],
      createdAt: '2026-07-11T12:00:00Z',
      status: 'cancelled',
    };
    expect(() => RundownSchema.parse(input)).toThrow();
  });
});

// ─── EditionStatus ───────────────────────────────────────────────

describe('EditionStatusSchema', () => {
  it('accepts a minimal edition', () => {
    const input = {
      id: 'edition-1',
      name: 'Morning Briefing',
      status: 'creating',
      createdAt: '2026-07-11T12:00:00Z',
      updatedAt: '2026-07-11T12:00:00Z',
    };
    const result = EditionStatusSchema.parse(input);
    expect(result.status).toBe('creating');
    expect(result.rundown).toBeUndefined();
  });

  it('accepts an edition with full data', () => {
    const input = {
      id: 'edition-2',
      name: 'Evening Edition',
      status: 'published',
      rundown: {
        id: 'rundown-1',
        editionId: 'edition-2',
        stories: ['story-1'],
        createdAt: '2026-07-11T12:00:00Z',
        status: 'published',
      },
      factGateResults: [
        {
          id: 'fg-1',
          storyId: 'story-1',
          passed: true,
          claims: [],
          overallVerdict: 'approved',
          checkedAt: '2026-07-11T12:30:00Z',
        },
      ],
      createdAt: '2026-07-11T12:00:00Z',
      updatedAt: '2026-07-11T13:00:00Z',
    };
    const result = EditionStatusSchema.parse(input);
    expect(result.status).toBe('published');
    expect(result.rundown).toBeDefined();
    expect(result.factGateResults).toHaveLength(1);
  });

  it('rejects an invalid edition phase', () => {
    const input = {
      id: 'edition-3',
      name: 'Bad',
      status: 'archiving',
      createdAt: '2026-07-11T12:00:00Z',
      updatedAt: '2026-07-11T12:00:00Z',
    };
    expect(() => EditionStatusSchema.parse(input)).toThrow();
  });
});
