# Newsroom Zero — CLAUDE.md

## Architecture

```
apps/
  web/          # Next.js App Router + TypeScript — landing page, waitlist form
packages/
  newsroom/     # Framework-neutral Zod domain schemas & state types
```

Pipeline: Live Feeds → Editor → Writer → Fact Judge → Voice → Telegram

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm lint` | TypeScript type-check across all packages (`pnpm -r run lint`) |
| `pnpm typecheck` | Alias for lint (also `pnpm -r run typecheck`) |
| `pnpm test` | Run Vitest once |
| `pnpm build` | Build all packages (`pnpm -r run build`) |
| `pnpm dev` | Start web dev server from root (requires `cd apps/web && pnpm dev`) |
| `pnpm --filter @newsroom-zero/newsroom build` | Build only the newsroom package |
| `pnpm --filter @newsroom-zero/web dev` | Dev the web app only |

## Design constraints

- **Fresh-build constraint**: This repository started from a single initial commit
  (`chore: initialize fresh buildathon repository`). Every file in this repo was
  created for this buildathon. Do not copy code from existing projects — no
  portal, no dashboard, no existing agent code.
- **No external SDKs yet**: Do not add Convex, Linkup, ElevenLabs, Telegram
  Bot, or Cloudflare SDKs until explicitly permitted. Phase 1 is pure scaffold.
- **Preservation rule**: Do not modify files outside this repository. Do not
  commit secrets or real API keys. Only `.env` files (already gitignored) may
  hold secrets.

## Dependency graph

```
@newsroom-zero/web  ──depends-on──>  @newsroom-zero/newsroom
```

The `newsroom` package has zero framework dependencies — just Zod + TypeScript.
The `web` app depends on `newsroom` for type contracts.

## Waitlist repository contract

The waitlist form uses an injectable `WaitlistRepository` interface. Swap the
default in-memory implementation by calling `setWaitlistRepository(...)` with a
custom adapter (e.g. `DatabaseWaitlistRepository`) at app startup.
