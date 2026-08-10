import asyncio
import json
import logging
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import nats

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("wagi-media-worker")

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
WHISPER_ENABLED = os.getenv("WHISPER_ENABLED", "true").lower() == "true"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "medium")
WHISPER_CPP_BIN = os.getenv("WHISPER_CPP_BIN", "/usr/local/bin/whisper-cli")
WHISPER_MODEL_PATH = os.getenv("WHISPER_MODEL_PATH", f"/models/ggml-{WHISPER_MODEL}.bin")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "auto").lower()
WHISPER_LANGUAGES = {item.strip().lower() for item in os.getenv("WHISPER_LANGUAGES", "es,ca,de,en,fr").split(",") if item.strip()}
WHISPER_THREADS = max(1, int(os.getenv("WHISPER_THREADS", "4")))
AUDIO_WORK_DIR = Path(os.getenv("AUDIO_WORK_DIR", "/tmp/wagi-audio"))


def configured_language() -> str:
    if WHISPER_LANGUAGE == "auto":
        return "auto"
    if WHISPER_LANGUAGE not in WHISPER_LANGUAGES:
        raise ValueError(
            f"WHISPER_LANGUAGE={WHISPER_LANGUAGE} ist nicht aktiviert; "
            f"aktiviert sind: {', '.join(sorted(WHISPER_LANGUAGES))}"
        )
    return WHISPER_LANGUAGE


def transcribe_placeholder(media_key: str) -> tuple[str, str, float]:
    return f"Audio-MVP: Transkription für {media_key} liegt zur Verarbeitung bereit.", "de", 0.25


def _read_whisper_json(path: Path) -> tuple[str, str, float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    detected_language = str(result.get("language") or payload.get("language") or "unknown").lower()
    confidence = float(result.get("language_probability") or result.get("confidence") or 0.0)
    segments = payload.get("transcription") or payload.get("segments") or result.get("segments") or []
    transcript = " ".join(str(segment.get("text", "")).strip() for segment in segments if isinstance(segment, dict)).strip()
    return transcript, detected_language, confidence


def transcribe_with_whisper_cpp(source_path: str) -> tuple[str, str, float]:
    source = Path(source_path)
    if not source.is_file():
        raise FileNotFoundError(f"Audioquelle nicht gefunden: {source}")
    if not Path(WHISPER_CPP_BIN).is_file():
        raise FileNotFoundError(f"whisper.cpp CLI nicht gefunden: {WHISPER_CPP_BIN}")
    if not Path(WHISPER_MODEL_PATH).is_file():
        raise FileNotFoundError(f"whisper.cpp Modell nicht gefunden: {WHISPER_MODEL_PATH}")

    AUDIO_WORK_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="job-", dir=AUDIO_WORK_DIR) as temp_dir:
        temp_path = Path(temp_dir)
        wav_path = temp_path / "audio.wav"
        output_base = temp_path / "result"
        convert = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        if convert.returncode != 0:
            raise RuntimeError(f"ffmpeg konnte Audio nicht normalisieren: {convert.stderr[-500:]}")

        command = [
            WHISPER_CPP_BIN, "-m", WHISPER_MODEL_PATH, "-f", str(wav_path),
            "-l", configured_language(), "-oj", "-of", str(output_base), "-nt", "-np", "-ng",
            "-t", str(WHISPER_THREADS),
        ]
        run = subprocess.run(command, capture_output=True, text=True, check=False)
        json_path = Path(f"{output_base}.json")
        if run.returncode != 0 or not json_path.is_file():
            raise RuntimeError(f"whisper.cpp fehlgeschlagen: {run.stderr[-1000:]}")
        transcript, detected_language, confidence = _read_whisper_json(json_path)
        if detected_language not in WHISPER_LANGUAGES and detected_language != "unknown":
            log.warning("whisper.cpp erkannte %s; die aktivierte Allowlist ist %s", detected_language, sorted(WHISPER_LANGUAGES))
        return transcript, detected_language, confidence


async def publish(js, data: dict):
    event = {"id": os.urandom(16).hex(), "type": "media.audio.transcribed", "occurredAt": datetime.now(timezone.utc).isoformat(), "source": "media-worker", "data": data}
    await js.publish("media.audio.transcribed", json.dumps(event).encode())


async def main():
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=3)
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    try:
        await js.stream_info("WAGI_EVENTS")
    except Exception:
        try:
            await js.add_stream(name="WAGI_EVENTS", subjects=["wa.>", "media.>", "ai.>"])
        except Exception:
            await js.stream_info("WAGI_EVENTS")

    async def on_audio(message):
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            job_id = data["jobId"]
            await db.execute("UPDATE audio_jobs SET status='processing', updated_at=NOW() WHERE id=$1", job_id)
            source = data.get("objectPath") or data.get("mediaKey", "unknown")
            if WHISPER_ENABLED and os.path.exists(source):
                transcript, language, confidence = transcribe_with_whisper_cpp(source)
                provider = "whisper.cpp"
            else:
                transcript, language, confidence = transcribe_placeholder(source)
                provider = "placeholder-mvp"
            await publish(js, {"jobId": job_id, "messageId": data["messageId"], "transcript": transcript, "language": language, "confidence": confidence, "provider": provider})
            await message.ack()
        except Exception as exc:
            log.exception("audio job failed")
            if "job_id" in locals():
                await db.execute("UPDATE audio_jobs SET status='failed', error=$1, updated_at=NOW() WHERE id=$2", str(exc), job_id)

    await js.subscribe("media.audio.requested", durable="WAGI_MEDIA_AUDIO", stream="WAGI_EVENTS", cb=on_audio)
    log.info(
        "media worker listening on media.audio.requested (whisper.cpp=%s, model=%s, language=%s, enabled_languages=%s)",
        WHISPER_ENABLED, WHISPER_MODEL, WHISPER_LANGUAGE, sorted(WHISPER_LANGUAGES),
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
