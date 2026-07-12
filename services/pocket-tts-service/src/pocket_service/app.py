from __future__ import annotations

import io
import os
import subprocess
import threading
import wave
from collections.abc import Callable
from hmac import compare_digest
from typing import Protocol

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field


class SpeechEngine(Protocol):
    sample_rate: int

    def synthesize(self, text: str, voice: str, language: str) -> np.ndarray: ...


class PocketEngine:
    """Lazy, cached adapter around the official pocket_tts Python API."""

    def __init__(self) -> None:
        self._models: dict[str, object] = {}
        self._voices: dict[tuple[str, str], dict] = {}
        self._active_sample_rate = 24_000

    @property
    def sample_rate(self) -> int:
        return self._active_sample_rate

    def synthesize(self, text: str, voice: str, language: str) -> np.ndarray:
        from pocket_tts import TTSModel

        model = self._models.get(language)
        if model is None:
            model = TTSModel.load_model(language=language)
            self._models[language] = model
        key = (language, voice)
        state = self._voices.get(key)
        if state is None:
            state = model.get_state_for_audio_prompt(voice)
            self._voices[key] = state
        audio = model.generate_audio(state, text)
        self._active_sample_rate = int(model.sample_rate)
        return audio.detach().cpu().numpy().astype(np.float32, copy=False)


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    voice: str = Field(default="alba", min_length=1, max_length=200)
    language: str = Field(default="english", pattern=r"^[a-z][a-z0-9_]*$")
    format: str = Field(default="mp3", pattern=r"^mp3$")


def pcm_to_mp3(audio: np.ndarray, sample_rate: int, ffmpeg_binary: str = "ffmpeg") -> bytes:
    clipped = np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (clipped * 32767).astype("<i2").tobytes()
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    result = subprocess.run(
        [ffmpeg_binary, "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
        input=wav_buffer.getvalue(), capture_output=True, check=False, timeout=60,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError("MP3 conversion failed")
    return result.stdout


def create_app(
    *,
    engine_factory: Callable[[], SpeechEngine] = PocketEngine,
    api_key: str | None = None,
    max_text_chars: int = 20_000,
    ffmpeg_binary: str = "ffmpeg",
) -> FastAPI:
    app = FastAPI(title="Newsroom Zero Pocket TTS", version="0.1.0")
    configured_key = api_key if api_key is not None else os.getenv("POCKET_TTS_SERVICE_API_KEY")
    engine: SpeechEngine | None = None
    load_lock = threading.Lock()
    synthesis_lock = threading.Lock()

    def authorize(authorization: str | None = Header(default=None)) -> None:
        if not configured_key:
            return
        expected = f"Bearer {configured_key}"
        if authorization is None or not compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="Unauthorized", headers={"WWW-Authenticate": "Bearer"})

    def get_engine() -> SpeechEngine:
        nonlocal engine
        if engine is None:
            with load_lock:
                if engine is None:
                    engine = engine_factory()
        return engine

    @app.get("/health")
    def health() -> dict[str, str | bool]:
        return {"status": "ok", "modelLoaded": engine is not None}

    @app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
    def speech(request: SpeechRequest) -> Response:
        if len(request.text) > max_text_chars:
            raise HTTPException(status_code=422, detail="Text exceeds maximum length")
        try:
            with synthesis_lock:
                active_engine = get_engine()
                audio = active_engine.synthesize(request.text, request.voice, request.language)
                mp3 = pcm_to_mp3(audio, active_engine.sample_rate, ffmpeg_binary)
        except Exception:
            raise HTTPException(status_code=503, detail="Pocket TTS synthesis failed") from None
        return Response(content=mp3, media_type="audio/mpeg")

    return app


app = create_app()
