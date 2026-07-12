# Newsroom Zero

> An autonomous, fact-gated audio newsroom that turns personalized interests into cited Telegram briefings.

[![Tests](https://img.shields.io/badge/tests-81%20passing-22c55e)](#quality-gates)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![Telegram](https://img.shields.io/badge/Telegram-Open%20Bot-26A5E4)](https://t.me/Newsroomhermesbot)

Built for the **Hermes Buildathon**.

[Open the Telegram Bot](https://t.me/Newsroomhermesbot) · [Jump to the demo flow](#telegram-demo-flow)

![Newsroom Zero landing page with Telegram onboarding instructions](docs/assets/newsroom-zero-landing.jpg)

## What It Does

Newsroom Zero collects a listener's preferred topics, analysis angle, news range, and delivery mode (Text Only or Text + Audio) through an English-only Telegram conversation. It researches current stories with Linkup, validates and ranks the results, verifies original sources, applies a blocking Fact Gate, synthesizes the approved script via Pocket TTS (with ElevenLabs failover), and delivers the resulting briefing with citations back to the same Telegram chat.

## Telegram Demo Flow

1. Open [@Newsroomhermesbot](https://t.me/Newsroomhermesbot) and press **Start**.
2. Enter the AI topics you want to follow.
3. Choose the analysis angles that matter to you.
4. Select a news range: **Past 24 Hours**, **Past 3 Days**, or **Past 7 Days**.
5. Choose delivery mode: **Text Only** or **Text + Audio**.
6. Review your preferences and press **Generate Now**.
7. Receive a fact-gated briefing (text or audio) with clickable sources in Telegram.

All Telegram Bot copy and interactions are in English.

## Pipeline

```mermaid
flowchart LR
    A[Telegram preferences] --> B[Linkup topic research]
    B --> C[Validate, deduplicate, and rank]
    C --> D[Fetch original sources]
    D --> E[Anthropic structured analysis]
    E --> F[Claim-level citations]
    F --> G{Blocking Fact Gate}
    G -- Approved --> H{Delivery mode}
    H -- Text Only --> I[Telegram text delivery]
    H -- Text + Audio --> J{Pocket TTS}
    J -- Success --> K[Telegram audio delivery]
    J -- Fail --> L{ElevenLabs fallback}
    L -- Success --> K
    L -- Fail --> I
    K --> M[Latest web episode]
    I --> M
    G -- Blocked --> N[No voice or publication]
```

### Safety Properties

- Every factual script segment carries a story ID and canonical source URL.
- Original article content must be fetched and verified before approval.
- Every LLM-generated factual claim must cite one or more verified story IDs.
- Every claim must include exact supporting excerpts that are found in the cited verified originals.
- Anthropic system instructions are separated from user preferences and source documents, which are treated as untrusted data.
- Unknown story IDs, malformed JSON, missing citations, and provider failures fail closed.
- Unsupported or mismatched citations block the edition.
- Voice generation and publication happen only after Fact Gate approval.
- Linkup retries only transient network and `5xx` failures; invalid responses and persistent failures remain blocked.
- API keys are read from `.env` and are never committed.

## Current Capabilities

- Interactive, per-chat Telegram onboarding and persisted workflow state
- Text Only / Text + Audio delivery mode selection
- Linkup search and original-source fetch
- Topic-aware story validation, deduplication, and ranking
- Anthropic structured summaries, cross-story trends, strategic implications, and recommendations
- Claim-level citation and research-aware blocking Fact Gate
- Pocket TTS primary voice generation with ElevenLabs fallback
- Personalized Telegram MP3 delivery or text-only briefing with sources
- Local Next.js landing page and latest episode player
- Live RSS/Atom ingestion for the standalone newsroom pipeline

The interactive Bot uses grounded Anthropic analysis. The standalone RSS preparation commands retain their deterministic script path for backward compatibility.

## Local Setup

### Requirements

- Node.js `22+`
- pnpm `10+`
- A Telegram bot token
- A Linkup API key
- An Anthropic API key
- An ElevenLabs API key (used as fallback when Pocket TTS is unavailable)

### Install

```bash
git clone https://github.com/DAVIDshenghuei/Newsroom-Zero.git
cd Newsroom-Zero
pnpm install
cp .env.example .env
```

Add your credentials to `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
LINKUP_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
ELEVENLABS_API_KEY=
POCKET_TTS_BASE_URL=
POCKET_TTS_API_KEY=
```

Never commit `.env` or paste production credentials into issues or screenshots.

## Run the Demo Locally

Start the landing page:

```bash
pnpm --filter @newsroom-zero/web dev
```

Open:

- Landing page: <http://localhost:3000>
- Latest episode: <http://localhost:3000/episodes/latest>

In a second terminal, start the local Pocket TTS service (the first synthesis downloads the model):

```bash
pnpm pocket:service
```

Configure the Bot to use it:

```dotenv
POCKET_TTS_BASE_URL=http://127.0.0.1:8001
POCKET_TTS_VOICE=alba
POCKET_TTS_LANGUAGE=english
POCKET_TTS_TIMEOUT_MS=180000
```

In a third terminal, start the long-polling Telegram Bot:

```bash
pnpm newsroom:bot
```

Only one Bot polling process should run at a time. Multiple `getUpdates` processes for the same token cause Telegram HTTP `409` conflicts.

## Standalone Pipeline Commands

```bash
pnpm newsroom:prepare
pnpm newsroom:voice
pnpm newsroom:publish-telegram
```

The interactive `pnpm newsroom:bot` command runs the personalized research, verification, voice, and delivery path after the user presses **Generate Now**.

## Quality Gates

```bash
pnpm test
pnpm typecheck
pnpm build
```

Current verified baseline:

- **81 tests passing**
- TypeScript typecheck passing
- Next.js production build passing
- Real Linkup → Fact Gate → ElevenLabs → Telegram deterministic flow exercised successfully
- Anthropic integration is covered by injected HTTP contract tests; a valid `ANTHROPIC_API_KEY` is required for live LLM verification

## Repository Layout

```text
apps/web/                  Next.js landing page and episode player
packages/newsroom/src/     Research, ranking, Fact Gate, voice, and Telegram workflow
apps/web/public/episodes/  Latest generated episode metadata and MP3
docs/assets/               README and demo images
artifacts/                 Local generated workflow artifacts (gitignored)
```

## Tech Stack

- TypeScript
- Node.js
- pnpm workspaces
- Next.js 14
- Zod
- Vitest
- Linkup API
- Anthropic Messages API
- Pocket TTS
- ElevenLabs API
- Telegram Bot API

## Security

Secrets belong only in `.env`. The repository ignores runtime credentials and local generated artifacts. If a credential is ever exposed in chat, logs, or screenshots, rotate it before production use.
