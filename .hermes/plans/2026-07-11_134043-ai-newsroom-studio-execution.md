# AI Newsroom Studio — Executable Build Plan from Current State

> **For Hermes:** Execute every coding task through `claude-codex -C C:/Users/User/Newsroom-Zero`, which is pinned to the official Codex CLI model `gpt-5.6-sol`. Do not use Claude Code, DeepSeek, delegated coding agents, or direct ad-hoc edits unless the user explicitly changes this workflow. Preserve all existing files and use TDD plus frequent commits.

**Goal:** Continue the existing fresh-build AI Newsroom Studio repository from its current Phase 1 scaffold to a reliable autonomous pipeline that ingests live RSS, selects stories, fact-gates a citation-bearing script, generates ElevenLabs audio, publishes to a public episode page and Telegram, and runs unattended through Hermes cron.

**Architecture:** Preserve the current pnpm monorepo and framework-neutral `packages/newsroom` contracts. Build one vertical slice at a time: first repair and commit the current scaffold, then prove live RSS-to-audio in the terminal, then split that working loop into structured newsroom agents, add a blocking fact gate, persist runs, publish externally, and finally schedule unattended editions. External services are always behind typed adapters so unit tests use fakes and no secret enters Git.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspaces, Next.js 14 App Router, Zod, Vitest, `fast-xml-parser`, ElevenLabs HTTP API, Linkup HTTP API, Convex, Telegram Bot API, Cloudflare Pages/Workers, Hermes cron and messaging gateway, official Codex CLI through `claude-codex` pinned to `gpt-5.6-sol`.

---

## 1. Confirmed current state

Repository:

```text
C:\Users\User\Newsroom-Zero
```

Current Git state:

```text
branch: main
HEAD: 7d453bb chore: initialize fresh buildathon repository
```

Existing but uncommitted work that must be preserved:

```text
CLAUDE.md
.env.example
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
apps/web/**
packages/newsroom/**
```

Verified baseline:

```text
pnpm test      → 22 tests passed
pnpm typecheck → passed
pnpm build     → failed only because Next.js 14 does not support next.config.ts
```

Known build error:

```text
Configuring Next.js via 'next.config.ts' is not supported.
Replace it with next.config.mjs or next.config.js.
```

Current implemented functionality:

- Next.js landing page and waitlist form.
- Injectable in-memory waitlist repository.
- Zod schemas for stories, claims, fact-gate results, rundowns, and edition status.
- 22 unit tests.
- No external service SDKs or credentials.
- No live RSS pipeline yet.
- No production LLM runtime yet.
- No ElevenLabs, Linkup, Convex, Telegram, Cloudflare, or cron integration yet.

---

## 2. Non-negotiable execution workflow

Every coding task starts with:

```bash
claude-codex -C C:/Users/User/Newsroom-Zero /status
```

Expected:

```text
Model: gpt-5.6-sol
Authentication: Logged in using ChatGPT
```

Then execute one bounded task at a time:

```bash
claude-codex -C C:/Users/User/Newsroom-Zero "<task prompt>"
```

After every task, Hermes independently runs:

```bash
pnpm test
pnpm typecheck
pnpm build

git diff --check
git status --short
```

Rules:

1. Never overwrite or remove existing Phase 1 files without examining their tests and consumers.
2. Never copy code from Wisemanager or another pre-existing product.
3. Never commit `.env`, OAuth tokens, Telegram tokens, or API keys.
4. Every behavior starts with a failing Vitest test.
5. Every external API is behind an interface and tested with fakes.
6. Commit only after tests, typecheck, and build pass.
7. Keep each Codex task small enough to review in one diff.
8. The public-output path has priority over UI polish.

---

## 3. Milestone order

| Milestone | Deliverable | Go/no-go proof |
|---|---|---|
| M0 | Stable Phase 1 baseline | 22 tests, typecheck, build all pass; baseline committed |
| M1 | Live RSS normalization | Real feeds produce validated `StoryCandidate[]` |
| M2 | Deterministic rundown | Three non-duplicate recent stories selected with reasons |
| M3 | Citation-bearing script | Script sentences map to source IDs |
| M4 | Fact gate | Unsupported claim blocks voicing; valid claims pass |
| M5 | Real audio | ElevenLabs returns a non-empty MP3 with checksum |
| M6 | Agent organization | Manager/specialists use structured handoffs and persisted trace |
| M7 | Public edition | Episode URL is HTTP 200 and Telegram message ID stored |
| M8 | Autonomous repetition | Hermes cron publishes at least three editions without repeats |
| M9 | Demo proof | Trace, timestamps, subscribers, eval result, cost/latency visible |

Stop adding features whenever the next go/no-go proof is not yet achieved.

---

## 4. Phase A — repair and commit the existing baseline

### Task A1: Fix the Next.js 14 configuration filename

**Objective:** Make the existing scaffold build without changing runtime behavior.

**Files:**

- Delete: `apps/web/next.config.ts`
- Create: `apps/web/next.config.mjs`
- Preserve: `output: 'standalone'`

**Codex command:**

```bash
claude-codex -C C:/Users/User/Newsroom-Zero "Fix only the current Next.js 14 build error by replacing apps/web/next.config.ts with an equivalent supported next.config.mjs. Preserve output: standalone. Do not touch other files. Run pnpm build and report the result."
```

**Verification:**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: 22 tests pass; typecheck exits 0; both workspace packages build.

**Commit:**

```bash
git add .gitignore .env.example CLAUDE.md package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts apps packages
git commit -m "chore: scaffold newsroom monorepo and waitlist"
```

### Task A2: Add a root README and baseline architecture proof

**Objective:** Document how to install, test, run, and prove that this is a fresh build.

**Files:**

- Create: `README.md`
- Test: no code test; verify commands manually

README must include:

- One-sentence product pitch.
- Current implemented/not-implemented state.
- Workspace architecture.
- Exact pnpm commands.
- Environment variable names only.
- Fresh-build statement.
- No claims that partner integrations already work.

**Verification:**

```bash
pnpm test && pnpm typecheck && pnpm build
git diff --check
```

**Commit:**

```bash
git add README.md
git commit -m "docs: describe newsroom architecture and build workflow"
```

---

## 5. Phase B — prove live RSS ingestion

### Task B1: Extend the story contract without breaking existing tests

**Objective:** Add publication metadata and source identity required for freshness, deduplication, and citations.

**Files:**

- Modify: `packages/newsroom/src/index.ts`
- Modify: `packages/newsroom/src/__tests__/schemas.test.ts`

Add backward-compatible fields initially:

```ts
sourceUrl: z.string().url().optional(),
publishedAt: z.string().datetime().optional(),
author: z.string().optional(),
externalId: z.string().optional(),
```

Do not rename or remove existing fields yet.

**TDD:**

1. Add tests accepting complete RSS metadata.
2. Add tests rejecting invalid `sourceUrl` and `publishedAt`.
3. Run targeted test and confirm failure.
4. Implement minimal schema extension.
5. Run all tests.

**Command:**

```bash
pnpm vitest run packages/newsroom/src/__tests__/schemas.test.ts
```

**Commit:**

```bash
git add packages/newsroom/src
git commit -m "feat: add RSS metadata to story contracts"
```

### Task B2: Create the feed adapter contract

**Objective:** Separate feed fetching from normalization so tests never call the network.

**Files:**

- Create: `packages/newsroom/src/feeds/types.ts`
- Create: `packages/newsroom/src/feeds/types.test.ts`
- Modify: `packages/newsroom/src/index.ts`

Contracts:

```ts
export interface FeedSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface FeedFetcher {
  fetch(source: FeedSource): Promise<string>;
}
```

Use Zod for untrusted config parsing.

**Verification:** targeted tests pass and exports resolve from package root.

**Commit:** `feat: add feed source contracts`.

### Task B3: Implement RSS/Atom normalization

**Objective:** Convert real RSS and Atom XML fixtures into validated story candidates.

**Dependencies:**

```bash
pnpm --filter @ai-newsroom-studio/newsroom add fast-xml-parser
```

**Files:**

- Create: `packages/newsroom/src/feeds/normalize.ts`
- Create: `packages/newsroom/src/feeds/normalize.test.ts`
- Create: `packages/newsroom/src/feeds/__fixtures__/rss.xml`
- Create: `packages/newsroom/src/feeds/__fixtures__/atom.xml`
- Modify: `packages/newsroom/src/index.ts`

Required behavior:

- Parse RSS 2.0 and Atom.
- Normalize arrays/single objects.
- Strip unsafe HTML to plain text.
- Resolve title, body, link, GUID, author, publication date.
- Generate deterministic ID from source ID + GUID/link.
- Reject entries without headline/body.
- Return invalid-entry diagnostics rather than crashing the entire feed.

**Tests:** malformed XML, missing title, RSS, Atom, duplicate GUID, invalid date.

**Commit:** `feat: normalize RSS and Atom feeds`.

### Task B4: Add an HTTP feed fetcher with safety limits

**Objective:** Fetch live allowlisted feeds reliably.

**Files:**

- Create: `packages/newsroom/src/feeds/http-fetcher.ts`
- Create: `packages/newsroom/src/feeds/http-fetcher.test.ts`

Required behavior:

- `AbortSignal.timeout(10_000)`.
- HTTP 200 only.
- Maximum response size 2 MB.
- RSS/XML content-type preferred but tolerate known feed servers.
- User-agent identifies AI Newsroom Studio.
- Retry once for 429/5xx with bounded delay.
- Never accept local/private network URLs in production config.

**Commit:** `feat: fetch live feeds safely`.

### Task B5: Create the first terminal ingestion command

**Objective:** Produce validated live story JSON from at least two real feeds.

**Files:**

- Create: `packages/newsroom/src/cli/ingest.ts`
- Create: `packages/newsroom/src/cli/ingest.test.ts`
- Create: `config/feeds.json`
- Modify: `packages/newsroom/package.json`
- Modify: root `package.json`

Root command:

```bash
pnpm newsroom:ingest
```

Output:

```text
feed count
candidate count
invalid item count
elapsed milliseconds
path to JSON artifact
```

Artifacts go under gitignored `artifacts/`.

**Real verification:** run against live feeds and inspect at least five source URLs manually.

**Commit:** `feat: ingest live newsroom feeds`.

---

## 6. Phase C — story memory, deduplication, and rundown

### Task C1: Add URL canonicalization and story fingerprinting

**Files:**

- Create: `packages/newsroom/src/memory/canonical-url.ts`
- Create: `packages/newsroom/src/memory/canonical-url.test.ts`
- Create: `packages/newsroom/src/memory/fingerprint.ts`
- Create: `packages/newsroom/src/memory/fingerprint.test.ts`

Fingerprint v1:

```text
sha256(normalized headline tokens + canonical hostname + UTC date bucket)
```

Strip tracking parameters and fragments. Preserve meaningful path/query identifiers.

**Commit:** `feat: fingerprint stories for duplicate detection`.

### Task C2: Implement file-backed story memory first

**Objective:** Prove continuity before adding Convex.

**Files:**

- Create: `packages/newsroom/src/memory/store.ts`
- Create: `packages/newsroom/src/memory/file-store.ts`
- Create: `packages/newsroom/src/memory/file-store.test.ts`

Store under `artifacts/state/story-memory.json`, using atomic temp-file rename.

Required behavior:

- remember published fingerprints;
- reject exact recent duplicate;
- expose prior edition reference;
- allow follow-up only with a distinct external ID or source URL plus changed headline fingerprint.

**Commit:** `feat: persist story memory across editions`.

### Task C3: Add deterministic editor scoring

**Files:**

- Create: `packages/newsroom/src/editor/score.ts`
- Create: `packages/newsroom/src/editor/score.test.ts`
- Create: `packages/newsroom/src/editor/select.ts`
- Create: `packages/newsroom/src/editor/select.test.ts`

Score only observable fields:

```text
freshness + source priority + body completeness + novelty - duplicate penalty
```

Return selected stories and rejected stories with explicit reasons.

**Acceptance:** selects 3 stories deterministically; no LLM required yet.

**Commit:** `feat: select a deterministic newsroom rundown`.

---

## 7. Phase D — citation-bearing script and fact gate

### Task D1: Strengthen claim evidence contracts

**Objective:** Every factual sentence must carry source URLs and evidence snippets.

**Files:**

- Modify: `packages/newsroom/src/index.ts`
- Modify: `packages/newsroom/src/__tests__/schemas.test.ts`

Add fields without deleting existing data:

```ts
sourceUrls: z.array(z.string().url()).default([]),
confidence: z.number().min(0).max(1).optional(),
explanation: z.string().optional(),
```

Add `ScriptLineSchema`:

```ts
{
  id: string;
  speaker: 'anchor_a' | 'anchor_b';
  text: string;
  factual: boolean;
  sourceUrls: string[];
}
```

**Commit:** `feat: require citations in broadcast script contracts`.

### Task D2: Implement a deterministic writer baseline

**Files:**

- Create: `packages/newsroom/src/writer/template-writer.ts`
- Create: `packages/newsroom/src/writer/template-writer.test.ts`

Generate a natural but bounded script only from selected fields. This baseline proves the pipeline before runtime LLM integration.

**Acceptance:** every factual line contains one or more URLs; duration estimate is 90–180 seconds.

**Commit:** `feat: generate citation-bearing bulletin scripts`.

### Task D3: Implement the blocking fact gate

**Files:**

- Create: `packages/newsroom/src/judge/fact-gate.ts`
- Create: `packages/newsroom/src/judge/fact-gate.test.ts`
- Create: `packages/newsroom/src/judge/policy.ts`

Hard rules before any model judge:

- factual line with zero source URLs → reject;
- source URL absent from research packet → reject;
- numerical/high-impact claim with insufficient corroboration → needs review;
- duplicate story → reject;
- invalid/broken source → reject;
- script outside duration bounds → reject.

**Required regression test:** inject one unsupported number and prove `passed === false`.

**Commit:** `test: block unsupported claims in fact gate`.

### Task D4: Add optional Linkup corroboration adapter

**Files:**

- Create: `packages/newsroom/src/research/linkup-client.ts`
- Create: `packages/newsroom/src/research/linkup-client.test.ts`
- Modify: `.env.example`

Do not call Linkup from unit tests. Use injected fetch and fixture responses.

**Acceptance:** high-impact story requests corroboration; missing key returns an explicit unavailable status, never fabricated evidence.

**Commit:** `feat: corroborate selected stories with Linkup`.

---

## 8. Phase E — first real audio artifact

### Task E1: Add voice adapter contracts

**Files:**

- Create: `packages/newsroom/src/voice/types.ts`
- Create: `packages/newsroom/src/voice/types.test.ts`

Contracts:

```ts
interface VoiceRenderer {
  render(input: { text: string; voiceId: string }): Promise<Uint8Array>;
}
```

### Task E2: Implement ElevenLabs HTTP adapter

**Files:**

- Create: `packages/newsroom/src/voice/elevenlabs.ts`
- Create: `packages/newsroom/src/voice/elevenlabs.test.ts`
- Modify: `.env.example`

Required behavior:

- API key only from environment;
- timeout and actionable errors;
- validate `audio/mpeg` and non-zero bytes;
- compute SHA-256 checksum;
- never log the API key;
- retry one 429/5xx response.

**Commit:** `feat: render bulletin audio with ElevenLabs`.

### Task E3: Orchestrate RSS-to-audio in the terminal

**Files:**

- Create: `packages/newsroom/src/orchestrator/run-edition.ts`
- Create: `packages/newsroom/src/orchestrator/run-edition.test.ts`
- Create: `packages/newsroom/src/cli/run-edition.ts`
- Modify: root `package.json`

Command:

```bash
pnpm newsroom:run
```

Order:

```text
fetch → normalize → dedupe → score → rundown → script → fact gate → voice → artifact manifest
```

Manifest:

```json
{
  "editionId": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "stories": [],
  "factGate": {},
  "audioPath": "...",
  "audioSha256": "...",
  "durationMs": 0,
  "steps": []
}
```

**Gate:** Do not start multi-agent work until this command creates a playable non-empty MP3 from live feeds.

**Commit:** `feat: produce live RSS-to-audio editions`.

---

## 9. Phase F — convert the working loop into a real agent organization

Only begin after M5 passes.

### Task F1: Define handoff envelopes and trace events

**Files:**

- Create: `packages/newsroom/src/agents/contracts.ts`
- Create: `packages/newsroom/src/agents/contracts.test.ts`
- Create: `packages/newsroom/src/observability/trace.ts`
- Create: `packages/newsroom/src/observability/trace.test.ts`

Every handoff records:

```text
runId, stepId, parentStepId, agentRole, inputRef, outputRef,
startedAt, finishedAt, status, retryCount, tokenUsage, estimatedCost
```

### Task F2: Split specialists without changing domain behavior

Create:

```text
packages/newsroom/src/agents/manager.ts
packages/newsroom/src/agents/monitor.ts
packages/newsroom/src/agents/editor.ts
packages/newsroom/src/agents/researcher.ts
packages/newsroom/src/agents/writer.ts
packages/newsroom/src/agents/judge.ts
packages/newsroom/src/agents/anchor.ts
packages/newsroom/src/agents/publisher.ts
```

Each agent receives/returns a Zod-validated envelope. The manager owns status transitions. Researchers use `Promise.allSettled` for real parallel fan-out.

### Task F3: Add one writer revision loop

Behavior:

```text
judge reject → writer receives exact unsupported line/reason → one revision
→ judge reruns → drop story or needs_review on second failure
```

Required proof fixture: intentionally unsupported headline is blocked and revised.

### Task F4: Integrate Hermes runtime orchestration

Use Hermes for scheduled runs, persistent memory, and messaging gateway. Do not recursively schedule cron jobs from cron sessions. Keep the Node pipeline callable from one self-contained Hermes cron prompt/script.

---

## 10. Phase G — persistence and public surfaces

### Task G1: Add Convex after the local loop works

Persist:

- source items;
- stories/fingerprints;
- editions;
- claims;
- agent steps;
- subscribers;
- listener events;
- eval runs.

Keep repository interfaces so file-backed tests continue to work.

### Task G2: Replace in-memory waitlist with Convex adapter

Do not remove `InMemoryWaitlistRepository`; retain it for tests and local fallback.

### Task G3: Create episode and trace pages

Create:

```text
apps/web/app/episodes/[editionId]/page.tsx
apps/web/app/ops/page.tsx
apps/web/app/rss.xml/route.ts
apps/web/components/episode-player.tsx
apps/web/components/source-list.tsx
apps/web/components/trace-tree.tsx
```

### Task G4: Publish to Telegram

Implement adapter and verify:

- channel post succeeds;
- message ID stored;
- audio or episode URL delivered;
- citations page linked;
- failed Telegram publish never marks edition `published`.

### Task G5: Deploy to Cloudflare

Deploy one persistent application; do not redeploy per edition. Verify public episode URL returns HTTP 200.

---

## 11. Phase H — cron, repeated proof, and evaluation

### Task H1: Add Hermes cron

Schedule at least three editions with a self-contained prompt and explicit working directory. Each run must:

1. execute the pipeline;
2. publish only if fact gate passes;
3. preserve output manifest;
4. report a compact success/failure message;
5. avoid creating more cron jobs.

### Task H2: Build ten eval cases

Create under `packages/newsroom/src/evals/cases/`:

1. valid two-source story;
2. duplicate feeds;
3. same entity, different event;
4. unsupported number;
5. conflicting number;
6. low-quality source;
7. stale story;
8. valid follow-up;
9. broken source URL;
10. opinion represented as fact.

Release gate:

```text
unsupported cases blocked: 100%
valid cases retained: 100%
overall: >= 90%
duplicate published: 0
```

### Task H3: Capture autonomy proof

Required artifacts:

- three public edition URLs;
- three Telegram message IDs;
- cron scheduled/start/publish timestamps;
- trace per edition;
- fact-gate rejection and revision;
- eval report;
- audio checksum;
- subscriber count;
- cost/latency summary.

---

## 12. Immediate execution queue

Execute in exactly this order:

1. **A1** — fix Next config and make build pass.
2. **A2** — document and commit Phase 1 baseline.
3. **B1** — extend story metadata contracts.
4. **B2** — feed adapter contracts.
5. **B3** — RSS/Atom normalization.
6. **B4** — safe HTTP fetcher.
7. **B5** — real terminal ingestion command.
8. **C1–C3** — fingerprint, memory, deterministic rundown.
9. **D1–D3** — citations, script, blocking fact gate.
10. **E1–E3** — ElevenLabs and real MP3.
11. Stop and evaluate M5 before any UI/agent expansion.

The first coding prompt should be exactly:

```text
You are working in the fresh-build AI Newsroom Studio repository. Preserve all existing work. Fix only the Next.js 14 build error by replacing apps/web/next.config.ts with an equivalent supported apps/web/next.config.mjs. Preserve output: 'standalone'. Run pnpm test, pnpm typecheck, and pnpm build. Do not change any other behavior. Show the exact diff and command results.
```

Run it with:

```bash
claude-codex -C C:/Users/User/Newsroom-Zero "You are working in the fresh-build AI Newsroom Studio repository. Preserve all existing work. Fix only the Next.js 14 build error by replacing apps/web/next.config.ts with an equivalent supported apps/web/next.config.mjs. Preserve output: 'standalone'. Run pnpm test, pnpm typecheck, and pnpm build. Do not change any other behavior. Show the exact diff and command results."
```

---

## 13. Risk controls

| Risk | Control |
|---|---|
| Existing Phase 1 accidentally overwritten | Review `git diff` after each Codex task; preserve all tests; frequent commits |
| Buildathon freshness questioned | Keep initial commit, session receipts, file history, and no copied code |
| Codex silently changes model | `/status` before each task must show `gpt-5.6-sol`; runner tests pin `--model` |
| Live feed changes break tests | Unit tests use checked-in fixtures; real feed run is separate integration proof |
| Hallucinated claim reaches audio | Deterministic fact gate blocks before ElevenLabs call |
| Partner API unavailable | Adapter returns explicit unavailable/failure; never fabricate output |
| Secret leakage | `.env` only; scan Git diff for token patterns before commit |
| Too much UI before core loop | M5 gate prohibits agent/UI expansion before playable audio |
| Duplicate bulletin | File memory first, Convex later; fingerprint checked before selection |
| Cron looks manually triggered | Preserve scheduler, start, and publish timestamps across three runs |

---

## 14. Definition of done for the next implementation session

The next implementation session is successful when:

- current build error is fixed;
- Phase 1 is committed without deleting existing work;
- live RSS/Atom feeds normalize into validated story candidates;
- `pnpm newsroom:ingest` produces a timestamped JSON artifact;
- all tests/typecheck/build pass;
- no secrets are committed;
- every coding change was executed through `claude-codex` showing `Model: gpt-5.6-sol`.

The project MVP is successful only when a later `pnpm newsroom:run` produces a real playable MP3 from live feeds, the fact gate can block an unsupported claim, and an unattended Hermes cron publishes repeated editions to public web and Telegram surfaces.
