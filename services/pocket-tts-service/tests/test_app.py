from __future__ import annotations

import shutil
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pocket_service.app import KokoroEngine, create_app


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


def test_health_is_ready_without_loading_any_engine() -> None:
    loads = 0

    def load() -> FakeEngine:
        nonlocal loads
        loads += 1
        return FakeEngine()

    client = TestClient(create_app(engine_factory=load))
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "modelLoaded": False, "loadedEngines": []}
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
    payload = {"text": "Hello AI Newsroom Studio", "voice": "alba", "language": "english", "format": "mp3"}
    first = client.post("/v1/audio/speech", json=payload)
    second = client.post("/v1/audio/speech", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.headers["content-type"].startswith("audio/mpeg")
    assert first.content[:3] == b"ID3" or first.content[:1] == b"\xff"
    assert loads == 1
    assert engine.calls == [("Hello AI Newsroom Studio", "alba", "english")] * 2


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
def test_traditional_chinese_routes_to_lazy_kokoro_with_default_voice() -> None:
    pocket = FakeEngine()
    kokoro = FakeEngine()
    loads = {"pocket-tts": 0, "kokoro": 0}

    def factory(provider: str, engine: FakeEngine) -> Callable[[], FakeEngine]:
        def load() -> FakeEngine:
            loads[provider] += 1
            return engine
        return load

    client = TestClient(create_app(engine_factories={
        "pocket-tts": factory("pocket-tts", pocket),
        "kokoro": factory("kokoro", kokoro),
    }))
    chinese = client.post("/v1/audio/speech", json={
        "text": "歡迎收聽人工智慧新聞。", "language": "chinese_traditional",
    })
    assert chinese.status_code == 200
    assert kokoro.calls == [("歡迎收聽人工智慧新聞。", "zf_xiaoxiao", "chinese_traditional")]
    assert pocket.calls == []
    assert loads == {"pocket-tts": 0, "kokoro": 1}
    assert client.get("/health").json() == {
        "status": "ok", "modelLoaded": True, "loadedEngines": ["kokoro"],
    }

    english = client.post("/v1/audio/speech", json={"text": "Hello", "language": "english"})
    assert english.status_code == 200
    assert pocket.calls == [("Hello", "alba", "english")]
    assert loads == {"pocket-tts": 1, "kokoro": 1}


def test_health_stays_responsive_and_consistent_during_first_engine_load() -> None:
    load_started = Event()
    release_load = Event()

    def load_kokoro() -> FakeEngine:
        load_started.set()
        assert release_load.wait(timeout=5)
        return FakeEngine()

    client = TestClient(create_app(engine_factories={
        "pocket-tts": FakeEngine,
        "kokoro": load_kokoro,
    }))

    with ThreadPoolExecutor(max_workers=2) as pool:
        speech = pool.submit(
            client.post,
            "/v1/audio/speech",
            json={"text": "繁體中文新聞", "language": "chinese_traditional"},
        )
        assert load_started.wait(timeout=5)
        health = pool.submit(client.get, "/health").result(timeout=2)
        assert health.status_code == 200
        assert health.json() == {
            "status": "ok", "modelLoaded": False, "loadedEngines": [],
        }
        release_load.set()
        assert speech.result(timeout=5).status_code == 200

    assert client.get("/health").json() == {
        "status": "ok", "modelLoaded": True, "loadedEngines": ["kokoro"],
    }


def test_kokoro_engine_concatenates_pipeline_chunks_as_float32() -> None:
    calls: list[tuple[str, str]] = []

    class FakePipeline:
        def __call__(self, text: str, *, voice: str):
            calls.append((text, voice))
            return iter([
                ("字", "phoneme-1", np.array([0.1, 0.2], dtype=np.float64)),
                ("句", "phoneme-2", np.array([0.3], dtype=np.float32)),
            ])

    language_codes: list[str] = []

    def load_pipeline(language_code: str) -> FakePipeline:
        language_codes.append(language_code)
        return FakePipeline()

    engine = KokoroEngine(pipeline_factory=load_pipeline)
    audio = engine.synthesize("繁體中文", "zf_xiaoxiao", "chinese_traditional")
    assert language_codes == ["z"]
    assert calls == [("繁體中文", "zf_xiaoxiao")]
    assert audio.dtype == np.float32
    np.testing.assert_allclose(audio, np.array([0.1, 0.2, 0.3], dtype=np.float32))
    assert engine.sample_rate == 24_000


def test_optional_bearer_auth_rejects_missing_or_wrong_token() -> None:
    client = TestClient(create_app(engine_factory=FakeEngine, api_key="local-secret"))
    assert client.post("/v1/audio/speech", json={"text": "hello"}).status_code == 401
    assert client.post("/v1/audio/speech", json={"text": "hello"}, headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_validation_rejects_empty_oversized_and_non_mp3_requests() -> None:
    client = TestClient(create_app(engine_factory=FakeEngine, max_text_chars=20))
    assert client.post("/v1/audio/speech", json={"text": ""}).status_code == 422
    assert client.post("/v1/audio/speech", json={"text": "x" * 21}).status_code == 422
    assert client.post("/v1/audio/speech", json={"text": "hello", "format": "wav"}).status_code == 422


def test_validation_rejects_unsupported_language_without_loading_engine() -> None:
    loads = 0

    def load() -> FakeEngine:
        nonlocal loads
        loads += 1
        return FakeEngine()

    client = TestClient(create_app(engine_factory=load))
    assert client.post("/v1/audio/speech", json={"text": "hello", "language": "chinese"}).status_code == 422
    assert loads == 0


def test_engine_errors_are_safe_and_do_not_echo_input() -> None:
    client = TestClient(create_app(engine_factory=lambda: FakeEngine(fail=True)))
    response = client.post("/v1/audio/speech", json={"text": "private briefing text"})
    assert response.status_code == 503
    assert response.json() == {"detail": "Local TTS synthesis failed"}
    assert "private briefing text" not in response.text
