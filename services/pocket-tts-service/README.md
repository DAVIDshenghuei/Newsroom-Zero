# AI Newsroom Studio Local TTS Service

Local FastAPI wrapper around [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) and [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M).
It lazy-loads only the engine selected by the requested language, keeps loaded models and voice states in memory, converts generated PCM to MP3 with ffmpeg, and exposes the contract used by the Node Bot.

## Requirements

- Python 3.10–3.14 (managed automatically by `uv`)
- `uv`
- `ffmpeg` available on `PATH`

## Run

From the repository root:

```bash
pnpm pocket:service
```

The service binds only to `127.0.0.1:8001`. The first synthesis for an engine downloads its model and voice assets; subsequent requests reuse the loaded engine. `/health` reports `loadedEngines` without eagerly loading either model.

## Supported languages

The request validator accepts only these local language routes:

| Language | `language` | Default newsroom voice | Engine/model |
|---|---|---|---|
| English | `english` | `alba` | Pocket, standard |
| French | `french_24l` | `estelle` | Pocket, preview 24l |
| German | `german_24l` | `juergen` | Pocket, preview 24l |
| Spanish | `spanish_24l` | `lola` | Pocket, preview 24l |
| Italian | `italian` | `giovanni` | Pocket, standard |
| Portuguese | `portuguese` | `rafael` | Pocket, standard |
| Traditional Chinese | `chinese_traditional` | `zf_xiaoxiao` | Kokoro-82M, `lang_code=z` |

Unsupported IDs return HTTP 422 before either engine loads. The Node application falls back to ElevenLabs when the selected local engine fails.

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

Tests inject fake synthesis engines, exercise provider routing and the real ffmpeg MP3 conversion, and do not download model weights.
