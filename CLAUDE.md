# AI Newsroom Studio — CLAUDE.md

## Architecture

```text
apps/web/                                      Next.js landing page and latest episode player
packages/newsroom/config/search-policies/     Topic and analysis policy JSON
packages/newsroom/src/                        Search, ranking, Codex analysis, Fact Gate, voice, and Telegram bot
services/pocket-tts-service/                  Local FastAPI Pocket TTS service
```

Interactive pipeline:

```text
Telegram selection
→ Topic + Analysis policy composition
→ Linkup domain-constrained search
→ original article fetch
→ publication and relevance gates
→ tier-aware ranking and deduplication
→ Codex analysis
→ claim-level Fact Gate
→ text or Pocket TTS/ElevenLabs delivery
```

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace dependencies |
| `pnpm test` | Run the TypeScript/Vitest suite |
| `pnpm pocket:test` | Run the Pocket TTS Python tests |
| `pnpm typecheck` | Build the newsroom package and type-check all workspaces |
| `pnpm build` | Build all packages and the Next.js production app |
| `pnpm --filter @ai-newsroom-studio/web dev` | Start the web app locally |
| `pnpm newsroom:bot` | Build and run the Telegram long-polling bot |
| `pnpm pocket:service` | Start the local Pocket TTS service |

## Runtime invariants

- The Telegram UI and bot copy remain English-only.
- Topic and Analysis policies come from validated JSON under `packages/newsroom/config/search-policies/`.
- Tier 1 and Tier 2 domains are active; Tier 3 remains discovery-only.
- Linkup uses native domain restrictions, followed by a local hostname-boundary check.
- Final relevance decisions use fetched original content, never provider titles or snippets alone.
- Publication windows reject missing, invalid, future, and out-of-window dates.
- Zero eligible stories stop before Codex, TTS, publication, or episode writes.
- The current bot analysis runtime is the official Codex CLI with `gpt-5.6-sol` by default.
- Keep only one Telegram long-polling process active per bot token.
- Do not commit secrets, generated diagnostics, or Codex authentication state.
- Treat `apps/web/public/episodes/latest.json` and `latest.mp3` as protected runtime artifacts; never stage, restore, or overwrite them unless explicitly requested.

## Dependency graph

```text
@ai-newsroom-studio/web  ──depends-on──>  @ai-newsroom-studio/newsroom
```

The framework-neutral `newsroom` package owns schemas, policy composition, search and fetch clients, ranking, analysis adapters, the Fact Gate, voice delivery, and Telegram workflow code. It depends on Zod, `fast-xml-parser`, and `cross-spawn`. The Next.js web app consumes its shared contracts.

## Waitlist repository contract

The waitlist form uses an injectable `WaitlistRepository` interface. Replace the default in-memory implementation by calling `setWaitlistRepository(...)` with a persistent adapter at app startup.
