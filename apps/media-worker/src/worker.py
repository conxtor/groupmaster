import asyncio
import hmac
import json
import logging
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import boto3
import nats
from botocore.client import Config
from PIL import Image

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
MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "/data/media"))
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://localhost:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minio")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "miniosecret")
MINIO_BUCKET = os.getenv("MINIO_BUCKET", "wa-media")
MEDIA_MAX_RETRIES = max(1, int(os.getenv("MEDIA_MAX_RETRIES", "3")))
MEDIA_CLEANUP_TOKEN = os.getenv("MEDIA_CLEANUP_TOKEN", "").strip()
_s3 = None


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
    subject = data.pop("_subject", "media.audio.transcribed")
    event_type = data.pop("_type", subject)
    event = {"id": os.urandom(16).hex(), "type": event_type, "occurredAt": datetime.now(timezone.utc).isoformat(), "source": "media-worker", "data": data}
    await js.publish(subject, json.dumps(event).encode())


def s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", endpoint_url=MINIO_ENDPOINT, aws_access_key_id=MINIO_ACCESS_KEY, aws_secret_access_key=MINIO_SECRET_KEY, config=Config(signature_version="s3v4"), region_name="us-east-1")
    return _s3


def cleanup_group_media(object_keys: set[str], local_paths: set[str]) -> tuple[int, int]:
    deleted_objects = 0
    if object_keys:
        client = s3_client()
        ensure_bucket()
        for start in range(0, len(object_keys), 1000):
            batch = sorted(object_keys)[start:start + 1000]
            client.delete_objects(Bucket=MINIO_BUCKET, Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True})
            deleted_objects += len(batch)

    media_root = MEDIA_DIR.resolve()
    deleted_files = 0
    for raw_path in local_paths:
        path = Path(raw_path)
        try:
            resolved = path.resolve()
            if resolved == media_root or not resolved.is_relative_to(media_root):
                log.warning("refusing to delete media path outside MEDIA_DIR: %s", raw_path)
                continue
            if resolved.is_file():
                resolved.unlink()
                deleted_files += 1
        except OSError as error:
            raise RuntimeError(f"could not remove local media file {raw_path}: {error}") from error
    return deleted_objects, deleted_files


async def on_group_cleanup(db, message):
    try:
        payload = json.loads(message.data)
        token = str(payload.get("token") or "")
        platform = str(payload.get("platform") or "")
        group_ids = [str(value) for value in payload.get("groupIds", []) if value]
        if not MEDIA_CLEANUP_TOKEN or not hmac.compare_digest(token, MEDIA_CLEANUP_TOKEN):
            await message.respond(json.dumps({"ok": False, "error": "cleanup not authorized"}).encode())
            return
        if platform not in {"whatsapp", "telegram"} or not group_ids or len(group_ids) > 5000:
            await message.respond(json.dumps({"ok": False, "error": "invalid cleanup scope"}).encode())
            return
        rows = await db.fetch(
            """SELECT mo.object_key, mo.thumbnail_key, mo.object_path, mo.thumbnail_path, aj.object_path AS audio_object_path
               FROM wa_groups g
               LEFT JOIN messages m ON m.group_id = g.id
               LEFT JOIN media_objects mo ON mo.message_id = m.id
               LEFT JOIN audio_jobs aj ON aj.message_id = m.id
               WHERE g.platform=$1 AND g.id=ANY($2::text[])""",
            platform, group_ids,
        )
        object_keys = {str(value) for row in rows for value in (row["object_key"], row["thumbnail_key"]) if value}
        local_paths = {str(value) for row in rows for value in (row["object_path"], row["thumbnail_path"], row["audio_object_path"]) if value}
        deleted_objects, deleted_files = await asyncio.to_thread(cleanup_group_media, object_keys, local_paths)
        await message.respond(json.dumps({"ok": True, "deletedObjects": deleted_objects, "deletedFiles": deleted_files}).encode())
    except Exception as error:
        log.exception("group media cleanup failed")
        await message.respond(json.dumps({"ok": False, "error": str(error)}).encode())


def ensure_bucket():
    client = s3_client()
    try:
        client.head_bucket(Bucket=MINIO_BUCKET)
    except Exception:
        try:
            client.create_bucket(Bucket=MINIO_BUCKET)
        except Exception as error:
            log.warning("MinIO bucket could not be created: %s", error)


def extract_ocr(source: Path) -> str:
    try:
        run = subprocess.run(["tesseract", str(source), "stdout", "-l", "eng+deu+spa+fra"], capture_output=True, text=True, check=False, timeout=90)
        return run.stdout.strip() if run.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def stage_media(data: dict) -> tuple[str, str | None, str, int, str]:
    source = Path(str(data["objectPath"]))
    if not source.is_file():
        raise FileNotFoundError(f"Medienquelle nicht gefunden: {source}")
    message_id = str(data["messageId"])
    media_key = str(data["mediaKey"])
    mime = str(data.get("mediaMime") or "application/octet-stream")
    suffix = source.suffix.lower() or ".bin"
    object_key = f"messages/{message_id}/original{suffix}"
    thumbnail_key = None
    thumbnail_path = None
    ocr_text = ""
    ensure_bucket()
    client = s3_client()
    client.upload_file(str(source), MINIO_BUCKET, object_key, ExtraArgs={"ContentType": mime})
    if mime.startswith("image/"):
        try:
            thumb_dir = MEDIA_DIR / "thumbs"
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb = thumb_dir / f"{message_id}.jpg"
            with Image.open(source) as image:
                image.thumbnail((640, 640))
                image.convert("RGB").save(thumb, format="JPEG", quality=82)
            thumbnail_key = f"messages/{message_id}/thumbnail.jpg"
            client.upload_file(str(thumb), MINIO_BUCKET, thumbnail_key, ExtraArgs={"ContentType": "image/jpeg"})
            thumbnail_path = str(thumb)
            ocr_text = extract_ocr(source)
        except Exception as error:
            log.warning("image processing failed for %s: %s", message_id, error)
    return object_key, thumbnail_key, thumbnail_path or "", source.stat().st_size, ocr_text


async def on_media(db, js, message):
    data = json.loads(message.data).get("data", json.loads(message.data))
    message_id = data["messageId"]
    media_key = data["mediaKey"]
    try:
        await db.execute("UPDATE messages SET media_status='processing' WHERE id=$1", message_id)
        object_key, thumbnail_key, thumbnail_path, size, ocr_text = await asyncio.to_thread(stage_media, data)
        await db.execute(
            """INSERT INTO media_objects (message_id, media_key, object_key, thumbnail_key, object_path, thumbnail_path, mime, bytes, status, ocr_text, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,NOW())
               ON CONFLICT (message_id, media_key) DO UPDATE SET object_key=EXCLUDED.object_key, thumbnail_key=EXCLUDED.thumbnail_key,
                 object_path=EXCLUDED.object_path, thumbnail_path=EXCLUDED.thumbnail_path, mime=EXCLUDED.mime, bytes=EXCLUDED.bytes,
                 status='completed', error=NULL, ocr_text=EXCLUDED.ocr_text, updated_at=NOW()""",
            message_id, media_key, object_key, thumbnail_key, data.get("objectPath"), thumbnail_path or None, data.get("mediaMime"), size, ocr_text or None,
        )
        await db.execute("UPDATE messages SET media_status='completed' WHERE id=$1", message_id)
        if ocr_text:
            await publish(js, {"_subject": "media.image.analyzed", "_type": "media.image.analyzed", "messageId": message_id, "ocrText": ocr_text, "provider": "tesseract"})
        if str(data.get("mediaMime", "")).startswith("audio/"):
            await db.execute("UPDATE audio_jobs SET object_path=$1 WHERE message_id=$2 AND media_key=$3", data.get("objectPath"), message_id, media_key)
            await publish(js, {"_subject": "media.audio.requested", "_type": "media.audio.requested", "jobId": (await db.fetchval("SELECT id FROM audio_jobs WHERE message_id=$1 AND media_key=$2 ORDER BY created_at DESC LIMIT 1", message_id, media_key)), "messageId": message_id, "mediaKey": media_key, "mediaMime": data.get("mediaMime"), "objectPath": data.get("objectPath")})
        await message.ack()
    except Exception as error:
        await db.execute("UPDATE messages SET media_status='failed' WHERE id=$1", message_id)
        await db.execute("INSERT INTO media_objects (message_id, media_key, status, error, updated_at) VALUES ($1,$2,'failed',$3,NOW()) ON CONFLICT (message_id, media_key) DO UPDATE SET status='failed', error=$3, updated_at=NOW()", message_id, media_key, str(error))
        log.exception("media job failed")
        await message.ack()


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
            await db.execute("UPDATE audio_jobs SET status='processing', attempts=attempts+1, updated_at=NOW() WHERE id=$1", job_id)
            source = data.get("objectPath") or (await db.fetchval("SELECT object_path FROM audio_jobs WHERE id=$1", job_id)) or data.get("mediaKey", "unknown")
            if WHISPER_ENABLED and os.path.exists(source):
                transcript, language, confidence = transcribe_with_whisper_cpp(source)
                provider = "whisper.cpp"
            else:
                transcript, language, confidence = transcribe_placeholder(source)
                provider = "placeholder-mvp"
            await publish(js, {"jobId": job_id, "messageId": data["messageId"], "transcript": transcript, "language": language, "confidence": confidence, "provider": provider})
            await db.execute("UPDATE audio_jobs SET status='completed', transcript=$1, language=$2, confidence=$3, error=NULL, updated_at=NOW() WHERE id=$4", transcript, language, confidence, job_id)
            await message.ack()
        except Exception as exc:
            log.exception("audio job failed")
            if "job_id" in locals():
                attempts = await db.fetchval("SELECT attempts FROM audio_jobs WHERE id=$1", job_id) or MEDIA_MAX_RETRIES
                next_status = "queued" if attempts < MEDIA_MAX_RETRIES else "failed"
                await db.execute("UPDATE audio_jobs SET status=$1, error=$2, next_attempt_at=CASE WHEN $1='queued' THEN NOW()+INTERVAL '30 seconds' ELSE NULL END, updated_at=NOW() WHERE id=$3", next_status, str(exc), job_id)
            await message.ack()

    await js.subscribe("media.objects.requested", durable="WAGI_MEDIA_OBJECTS", stream="WAGI_EVENTS", cb=lambda message: on_media(db, js, message))
    await js.subscribe("media.audio.requested", durable="WAGI_MEDIA_AUDIO", stream="WAGI_EVENTS", cb=on_audio)
    async def on_cleanup_request(message):
        await on_group_cleanup(db, message)

    await nc.subscribe("internal.groups.cleanup.requested", cb=on_cleanup_request)
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
