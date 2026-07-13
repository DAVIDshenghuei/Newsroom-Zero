import { describe, expect, it } from 'vitest';
import {
  AnalysisPolicySchema, TopicProfileSchema, buildSearchQuery, composeSearchPolicy, evaluatePolicyText, filterBySearchPolicy, hostMatchesDomain,
  loadAnalysisPolicies, loadTopicProfiles,
} from '../search-policy.js';

describe('data-driven search policy', () => {
  it('loads the exact six topic profile contracts', async () => {
    const topics = await loadTopicProfiles();
    const compact = topics.map((item) => ({
      id: item.id, topicLabel: item.topicLabel, menuLabel: item.menuLabel,
      sourceTiers: Object.fromEntries(Object.entries(item.sourceTiers).map(([tier, sources]) =>
        [tier, sources.map(({ name, domain }) => [name, domain])])),
      activeSearchTiers: item.activeSearchTiers,
      excludedSources: (item.excludedSources ?? []).map(({ name, domain }) => [name, domain]),
      includeKeywords: item.includeKeywords, excludeKeywords: item.excludeKeywords,
      suggestedTimeRange: item.suggestedTimeRange,
    }));
    expect(compact).toEqual([
      { id: 'ai-agents', topicLabel: 'AI Agents', menuLabel: 'AI Agents', sourceTiers: {
        tier1: [['AIAgentStore', 'aiagentstore.ai'], ['OpenAI', 'openai.com'], ['Anthropic', 'anthropic.com'], ['TechCrunch AI', 'techcrunch.com'], ['VentureBeat AI', 'venturebeat.com'], ['Google DeepMind', 'deepmind.google'], ['Microsoft Azure AI', 'azure.microsoft.com'], ['AWS AI and ML', 'aws.amazon.com'], ['NVIDIA Developer', 'developer.nvidia.com'], ['LangChain Blog', 'blog.langchain.com'], ['LlamaIndex', 'llamaindex.ai']],
        tier2: [['HuggingFace', 'huggingface.co'], ['Latent Space', 'latent.space'], ['Bens Bites', 'bensbites.com'], ['The Decoder', 'the-decoder.com'], ['MIT Technology Review', 'technologyreview.com'], ['Ars Technica', 'arstechnica.com'], ['Simon Willison', 'simonwillison.net']],
        tier3: [['GitHub Trending', 'github.com'], ['Product Hunt', 'producthunt.com'], ['Hacker News', 'news.ycombinator.com']],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [['Breitbart', 'breitbart.com'], ['CNN Tech', 'cnn.com'], ['Fox', 'foxnews.com']], includeKeywords: ['AI Agent', 'Agent', 'Agentic AI', 'MCP', 'Computer Use', 'OpenAI Agent SDK', 'Claude Code', 'Claude Desktop', 'Multi-Agent', 'Workflow Automation'], excludeKeywords: [], suggestedTimeRange: '24h' },
      { id: 'ai-glasses', topicLabel: 'AI Glasses', menuLabel: 'AI Glasses', sourceTiers: {
        tier1: [['Meta', 'meta.com'], ['Google', 'google.com'], ['Snap', 'snap.com'], ['XREAL', 'xreal.com'], ['Brilliant Labs', 'brilliant.xyz'], ['Viture', 'viture.com'], ['RayNeo', 'rayneo.com'], ['UploadVR', 'uploadvr.com'], ['RoadToVR', 'roadtovr.com'], ['Apple', 'apple.com'], ['Qualcomm', 'qualcomm.com'], ['Magic Leap', 'magicleap.com'], ['Rokid', 'rokid.com'], ['Even Realities', 'evenrealities.com']], tier2: [['MIXED Reality News', 'mixed-news.com'], ['XR Today', 'xrtoday.com'], ['The Verge', 'theverge.com'], ['Android Central', 'androidcentral.com']], tier3: [],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [], includeKeywords: ['Smart Glasses', 'AR Glasses', 'XR', 'Spatial Computing', 'VisionOS', 'AI Glasses', 'Wearable AI'], excludeKeywords: [], suggestedTimeRange: '24h' },
      { id: 'claude-code', topicLabel: 'Claude Code', menuLabel: 'Claude Code', sourceTiers: {
        tier1: [['Anthropic', 'anthropic.com'], ['GitHub', 'github.com'], ['Cursor', 'cursor.com'], ['Aider', 'aider.chat'], ['Continue.dev', 'continue.dev'], ['Sourcegraph', 'sourcegraph.com'], ['OpenAI Codex', 'openai.com'], ['Windsurf', 'windsurf.com'], ['Cline', 'cline.bot'], ['JetBrains AI', 'blog.jetbrains.com'], ['Zed', 'zed.dev'], ['Vercel', 'vercel.com'], ['GitHub Blog', 'github.blog']], tier2: [['Simon Willison', 'simonwillison.net'], ['The New Stack', 'thenewstack.io'], ['InfoQ', 'infoq.com'], ['The Pragmatic Engineer', 'pragmaticengineer.com']], tier3: [],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [], includeKeywords: ['Claude Code', 'MCP', 'Coding Agent', 'Terminal Agent', 'CLI', 'Code Generation'], excludeKeywords: [], suggestedTimeRange: '24h' },
      { id: 'openai-api', topicLabel: 'OpenAI API', menuLabel: 'OpenAI API', sourceTiers: {
        tier1: [['OpenAI', 'openai.com'], ['Azure AI', 'azure.microsoft.com'], ['LangChain', 'langchain.com'], ['LlamaIndex', 'llamaindex.ai'], ['OpenRouter', 'openrouter.ai'], ['Vercel AI SDK', 'sdk.vercel.ai'], ['Cloudflare Developer Platform', 'blog.cloudflare.com'], ['Portkey', 'portkey.ai'], ['Helicone', 'helicone.ai'], ['LiteLLM', 'litellm.ai'], ['Instructor', 'python.useinstructor.com'], ['Pydantic AI', 'pydantic.dev']], tier2: [['Hugging Face', 'huggingface.co'], ['Simon Willison', 'simonwillison.net'], ['The New Stack', 'thenewstack.io'], ['InfoQ', 'infoq.com']], tier3: [],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [], includeKeywords: ['Responses API', 'Agents SDK', 'Realtime API', 'Structured Output', 'Tools', 'Fine-tuning'], excludeKeywords: [], suggestedTimeRange: '24h' },
      { id: 'ai-blockchain', topicLabel: 'AI x Blockchain', menuLabel: 'AI x Blockchain', sourceTiers: {
        tier1: [['CoinDesk', 'coindesk.com'], ['The Block', 'theblock.co'], ['Bankless', 'bankless.com'], ['Paradigm', 'paradigm.xyz'], ['a16z crypto', 'a16zcrypto.com'], ['Sui', 'sui.io'], ['Base', 'base.org'], ['Ethereum Foundation', 'ethereum.org'], ['Chainlink', 'chain.link'], ['Solana', 'solana.com'], ['NEAR', 'near.org'], ['Olas', 'olas.network'], ['Fetch.ai', 'fetch.ai'], ['Virtuals Protocol', 'virtuals.io']], tier2: [['Messari', 'messari.io'], ['Blockworks', 'blockworks.co'], ['Decrypt', 'decrypt.co'], ['DL News', 'dlnews.com']], tier3: [],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [], includeKeywords: ['AI Agent', 'Crypto Agent', 'Wallet', 'Onchain AI', 'MCP Wallet', 'DeFi Agent'], excludeKeywords: [], suggestedTimeRange: '24h' },
      { id: 'ai-travel', topicLabel: 'AI Travel', menuLabel: 'AI Travel', sourceTiers: {
        tier1: [['Skift', 'skift.com'], ['PhocusWire', 'phocuswire.com'], ['Google Travel', 'travel.google.com'], ['Booking', 'booking.com'], ['Airbnb', 'airbnb.com'], ['Amadeus', 'amadeus.com'], ['Expedia Group', 'expediagroup.com'], ['Trip.com', 'trip.com'], ['Hopper', 'hopper.com'], ['Sabre', 'sabre.com'], ['TravelPerk', 'travelperk.com'], ['Tripadvisor', 'tripadvisor.com']], tier2: [['Web in Travel', 'webintravel.com'], ['Travel Weekly', 'travelweekly.com'], ['Hospitality Net', 'hospitalitynet.org'], ['Travolution', 'travolution.com'], ['McKinsey Travel', 'mckinsey.com']], tier3: [],
      }, activeSearchTiers: ['tier1', 'tier2'], excludedSources: [], includeKeywords: ['Travel AI', 'AI Planner', 'AI Concierge', 'AI Booking'], excludeKeywords: [], suggestedTimeRange: '24h' },
    ]);
    expect(JSON.stringify(compact.find(({ id }) => id === 'ai-glasses'))).not.toContain('AIAgentStore');
    expect(topics.every(({ activeSearchTiers }) => !activeSearchTiers.includes('tier3' as never))).toBe(true);
  });

  it('keeps source domains unique within each topic profile across tiers and exclusions', async () => {
    for (const topic of await loadTopicProfiles()) {
      const domains = [
        ...(topic.sourceTiers.tier1 ?? []),
        ...(topic.sourceTiers.tier2 ?? []),
        ...(topic.sourceTiers.tier3 ?? []),
        ...(topic.excludedSources ?? []),
      ].map(({ domain }) => domain);
      expect(new Set(domains).size, topic.id).toBe(domains.length);
    }
  });

  it('loads the exact four analysis policy contracts', async () => {
    expect(await loadAnalysisPolicies()).toEqual([
      { id: 'startup-opportunities', menuLabel: 'Startup Opportunities', mustInclude: ['Funding', 'Startup', 'Launch', 'YC', 'Product', 'Open Source', 'Developer Tools', 'API', 'Infrastructure'], prefer: ['Open Source', 'API', 'SaaS'], exclude: ['Politics', 'Opinion', 'Lawsuit', 'Celebrity'] },
      { id: 'product-strategy', menuLabel: 'Product Strategy', mustInclude: ['Pricing', 'Go-to-market', 'Competition', 'Feature', 'User Growth', 'Retention'], prefer: [], exclude: [] },
      { id: 'technical-trends', menuLabel: 'Technical Trends', mustInclude: ['Research', 'Framework', 'Benchmark', 'Open Source', 'Architecture', 'Performance'], prefer: [], exclude: [] },
      { id: 'investment-signals', menuLabel: 'Investment Signals', mustInclude: ['Funding', 'IPO', 'Acquisition', 'M&A', 'Revenue', 'Enterprise', 'Valuation'], prefer: [], exclude: [] },
    ]);
  });

  it('composes active tiers and selected range while building a domain-free keyword query', async () => {
    const policy = await composeSearchPolicy('AI Agents', 'Startup Opportunities', {
      from: '2026-07-09T12:00:00.000Z', to: '2026-07-12T12:00:00.000Z',
    });
    expect(policy.topicId).toBe('ai-agents');
    expect(policy.activeSources.map((s) => s.tier)).not.toContain('tier3');
    expect(policy.publicationWindow.from).toBe('2026-07-09T12:00:00.000Z');
    const query = buildSearchQuery(policy);
    expect(query).toContain('"AI Agent"');
    expect(query).toContain('"Funding"');
    expect(query).toContain('English news');
    expect(query).not.toContain('site:');
  });

  it('matches domains and short keywords at safe boundaries', () => {
    expect(hostMatchesDomain('news.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('evil-example.com', 'example.com')).toBe(false);
    expect(evaluatePolicyText('XR and API tools for YC; M&A follows.', ['XR', 'API', 'YC', 'M&A'])).toEqual(['XR', 'API', 'YC', 'M&A']);
    expect(evaluatePolicyText('extra rapidly apiculture bicycle', ['XR', 'API', 'AI', 'CLI'])).toEqual([]);
    expect(evaluatePolicyText('any text at all', ['', '   ', '\t'])).toEqual([]);
  });

  it.each(['name', 'domain'] as const)('rejects whitespace-only source %s', (field) => {
    const source = { name: 'Example', domain: 'example.com', [field]: '   ' };
    expect(TopicProfileSchema.safeParse({
      id: 'example', topicLabel: 'Example', menuLabel: 'Example',
      sourceTiers: { tier1: [source], tier2: [], tier3: [] }, activeSearchTiers: ['tier1'],
      excludedSources: [], includeKeywords: ['AI'], excludeKeywords: [], suggestedTimeRange: '24h',
    }).success).toBe(false);
  });

  it.each([
    'https://example.com', 'example.com/path', 'example.com?x=1', 'example.com#part',
    'example.com:443', 'exa mple.com', '"example.com"', 'example.com OR evil.com',
    '*.example.com', '-example.com', 'example-.com', 'example..com', '.example.com',
  ])('rejects non-canonical source domain %s', (domain) => {
    expect(TopicProfileSchema.safeParse({
      id: 'example', topicLabel: 'Example', menuLabel: 'Example',
      sourceTiers: { tier1: [{ name: 'Example', domain }], tier2: [], tier3: [] },
      activeSearchTiers: ['tier1'], excludedSources: [], includeKeywords: ['AI'], excludeKeywords: [],
      suggestedTimeRange: '24h',
    }).success).toBe(false);
  });

  it('trims and lowercases canonical DNS source domains while preserving subdomain matching', () => {
    const result = TopicProfileSchema.parse({
      id: 'example', topicLabel: 'Example', menuLabel: 'Example',
      sourceTiers: { tier1: [{ name: 'Example', domain: '  News.Example.COM  ' }], tier2: [], tier3: [] },
      activeSearchTiers: ['tier1'], excludedSources: [], includeKeywords: ['AI'], excludeKeywords: [],
      suggestedTimeRange: '24h',
    });
    expect(result.sourceTiers.tier1[0].domain).toBe('news.example.com');
    expect(hostMatchesDomain('updates.news.example.com', result.sourceTiers.tier1[0].domain)).toBe(true);
  });

  it.each([
    ['topic label', { topicLabel: '   ' }],
    ['topic menu label', { menuLabel: '   ' }],
    ['include keyword', { includeKeywords: ['   '] }],
    ['exclude keyword', { excludeKeywords: ['   '] }],
  ])('rejects whitespace-only %s', (_label, override) => {
    expect(TopicProfileSchema.safeParse({
      id: 'example', topicLabel: 'Example', menuLabel: 'Example',
      sourceTiers: { tier1: [{ name: 'Example', domain: 'example.com' }], tier2: [], tier3: [] },
      activeSearchTiers: ['tier1'], excludedSources: [], includeKeywords: ['AI'], excludeKeywords: [],
      suggestedTimeRange: '24h', ...override,
    }).success).toBe(false);
  });

  it.each([
    ['analysis menu label', { menuLabel: '   ' }],
    ['required analysis keyword', { mustInclude: ['   '] }],
    ['preferred analysis keyword', { prefer: ['   '] }],
    ['excluded analysis keyword', { exclude: ['   '] }],
  ])('rejects whitespace-only %s', (_label, override) => {
    expect(AnalysisPolicySchema.safeParse({
      id: 'example', menuLabel: 'Example', mustInclude: ['AI'], prefer: [], exclude: [], ...override,
    }).success).toBe(false);
  });

  it('enforces final fetched text relevance and exclusions deterministically', async () => {
    const policy = await composeSearchPolicy('AI Agents', 'Startup Opportunities', {
      from: '2026-07-11T12:00:00.000Z', to: '2026-07-12T12:00:00.000Z',
    });
    const report = filterBySearchPolicy([
      { id: 'fetched', url: 'https://openai.com/news', name: 'New release', content: 'Brief snippet', original: 'An AI Agent startup launches developer tools.' },
      { id: 'excluded', url: 'https://openai.com/politics', name: 'AI Agent funding', content: 'harmless snippet', original: 'An AI Agent startup launch involving politics.' },
      { id: 'bad-host', url: 'https://evil-openai.com/news', name: 'AI Agent startup', content: 'Funding' },
      { id: 'metadata-only', url: 'https://openai.com/irrelevant', name: 'AI Agent startup funding', content: 'Developer tools launch', original: 'A gardening article about tomato irrigation.' },
      { id: 'blank-original', url: 'https://openai.com/blank', name: 'AI Agent startup funding', content: 'Developer tools launch', original: '   ' },
    ], policy);
    expect(report.eligibleIds).toEqual(['fetched']);
    expect(report.rejected.find(({ id }) => id === 'excluded')?.reasons).toContain('excluded keyword');
    expect(report.rejected.find(({ id }) => id === 'bad-host')?.reasons).toContain('source domain not allowed');
    expect(report.rejected.find(({ id }) => id === 'metadata-only')?.reasons).toEqual(expect.arrayContaining(['missing topic keyword', 'missing analysis keyword']));
    expect(report.rejected.find(({ id }) => id === 'metadata-only')?.matchedPreferredTerms).toEqual([]);
    expect(report.rejected.find(({ id }) => id === 'blank-original')?.reasons).toEqual(expect.arrayContaining(['missing topic keyword', 'missing analysis keyword']));
  });
});
