# AI Newsroom Studio Pocket TTS Service

Local FastAPI wrapper around [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts).
It keeps models and voice states in memory, converts generated PCM to MP3 with ffmpeg, and exposes the contract used by the Node Bot.

## Requirements

- Python 3.10–3.14 (managed automatically by `uv`)
- `uv`
- `ffmpeg` available on `PATH`

## Run

From the repository root:

```bash
pnpm pocket:service
```

The service binds only to `127.0.0.1:8001`. The first synthesis downloads Pocket TTS model and voice assets; subsequent requests reuse cached model and voice state.

## Supported languages

The request validator accepts only these official model IDs:

| Language | `language` | Default newsroom voice | Pocket model status |
|---|---|---|---|
| English | `english` | `alba` | Standard |
| French | `french_24l` | `estelle` | Preview 24l |
| German | `german_24l` | `juergen` | Preview 24l |
| Spanish | `spanish_24l` | `lola` | Preview 24l |
| Italian | `italian` | `giovanni` | Standard |
| Portuguese | `portuguese` | `rafael` | Standard |

Unsupported IDs return HTTP 422 before the engine loads. Chinese is not currently supported by Pocket TTS. The Node application can fall back to ElevenLabs, but it does not expose languages unsupported by the primary Pocket menu contract.

```bash
curl http://127.0.0.1:8001/health
curl http://127.0.0.1:8001/v1/audio/speech \
  -H "Content-Type: application/json" \
  --data '{"text":"Hello from AI Newsroom Studio.","voice":"alba","language":"english","format":"mp3"}' \
  --output pocket.mp3
```

Set the Bot environment:

```dotenv
POCKET_TTS_BASE_URL=http://127.0.0.1:8001
POCKET_TTS_VOICE=alba
POCKET_TTS_LANGUAGE=english
POCKET_TTS_TIMEOUT_MS=180000
```

Optional authentication is enabled by setting the same secret in both processes:

```dotenv
POCKET_TTS_SERVICE_API_KEY=replace-with-a-local-secret
POCKET_TTS_API_KEY=replace-with-the-same-local-secret
```

## Test

```bash
pnpm pocket:test
```

Tests inject a fake synthesis engine, but exercise the real ffmpeg MP3 conversion. They do not download model weights.
