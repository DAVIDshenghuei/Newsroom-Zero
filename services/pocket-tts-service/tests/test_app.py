from __future__ import annotations

import shutil

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pocket_service.app import create_app


class FakeEngine:
    sample_rate = 24_000

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, str, str]] = []

    def synthesize(self, text: str, voice: str, language: str) -> np.ndarray:
        self.calls.append((text, voice, language))
        if self.fail:
            raise RuntimeError(f"secret failure containing {text}")
        seconds = 0.08
        samples = np.arange(int(self.sample_rate * seconds))
        return (0.15 * np.sin(2 * np.pi * 440 * samples / self.sample_rate)).astype(np.float32)


def test_health_is_ready_without_loading_engine() -> None:
    loads = 0

    def load() -> FakeEngine:
        nonlocal loads
        loads += 1
        return FakeEngine()

    client = TestClient(create_app(engine_factory=load))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "modelLoaded": False}
    assert loads == 0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
def test_speech_returns_real_mp3_and_reuses_lazy_engine() -> None:
    engine = FakeEngine()
    loads = 0

    def load() -> FakeEngine:
        nonlocal loads
        loads += 1
        return engine

    client = TestClient(create_app(engine_factory=load))
    payload = {"text": "Hello Newsroom Zero", "voice": "alba", "language": "english", "format": "mp3"}
    first = client.post("/v1/audio/speech", json=payload)
    second = client.post("/v1/audio/speech", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.headers["content-type"].startswith("audio/mpeg")
    assert first.content[:3] == b"ID3" or first.content[:1] == b"\xff"
    assert loads == 1
    assert engine.calls == [("Hello Newsroom Zero", "alba", "english")] * 2


def test_optional_bearer_auth_rejects_missing_or_wrong_token() -> None:
    client = TestClient(create_app(engine_factory=FakeEngine, api_key="local-secret"))
    assert client.post("/v1/audio/speech", json={"text": "hello"}).status_code == 401
    assert client.post("/v1/audio/speech", json={"text": "hello"}, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_validation_rejects_empty_oversized_and_non_mp3_requests() -> None:
    client = TestClient(create_app(engine_factory=FakeEngine, max_text_chars=20))
    assert client.post("/v1/audio/speech", json={"text": ""}).status_code == 422
    assert client.post("/v1/audio/speech", json={"text": "x" * 21}).status_code == 422
    assert client.post("/v1/audio/speech", json={"text": "hello", "format": "wav"}).status_code == 422


def test_engine_errors_are_safe_and_do_not_echo_input() -> None:
    client = TestClient(create_app(engine_factory=lambda: FakeEngine(fail=True)))
    response = client.post("/v1/audio/speech", json={"text": "private briefing text"})
    assert response.status_code == 503
    assert response.json() == {"detail": "Pocket TTS synthesis failed"}
    assert "private briefing text" not in response.text
