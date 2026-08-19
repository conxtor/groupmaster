import asyncio
import hmac
import json
import logging
import os
import re
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import asyncpg
import boto3
import nats
from botocore.client import Config
from PIL import Image

from reliability import claim_event, mark_processed, payload_id, retry_or_dead_letter

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
MINIO_BUCKETS = {
    "image": os.getenv("MINIO_BUCKET_IMAGES", "wa-media-images"),
    "video": os.getenv("MINIO_BUCKET_VIDEOS", "wa-media-videos"),
    "audio": os.getenv("MINIO_BUCKET_AUDIO", "wa-media-audio"),
    "document": os.getenv("MINIO_BUCKET_DOCUMENTS", "wa-media-documents"),
    "other": os.getenv("MINIO_BUCKET_OTHER", "wa-media-other"),
}
MEDIA_MAX_RETRIES = max(1, int(os.getenv("MEDIA_MAX_RETRIES", "3")))
MEDIA_STALE_PROCESSING_SECONDS = max(60, int(os.getenv("MEDIA_STALE_PROCESSING_SECONDS", "900")))
MEDIA_ANALYSIS_EVENT_MAX_CHARS = max(2000, int(os.getenv("MEDIA_ANALYSIS_EVENT_MAX_CHARS", "12000")))
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


async def repair_placeholder_audio_jobs(db):
    """Requeue old MVP placeholders so they can be transcribed for real."""
    if not WHISPER_ENABLED:
        return
    result = await db.execute(
        """UPDATE audio_jobs
           SET status='queued', transcript=NULL, language=NULL, confidence=NULL,
               error='MVP-Platzhalter wurde als ungültige Transkription erkannt',
               next_attempt_at=NOW(), updated_at=NOW()
           WHERE status='completed' AND transcript LIKE 'Audio-MVP:%'"""
    )
    if result != "UPDATE 0":
        log.warning("requeued %s old placeholder audio job(s)", result.split()[-1])


async def publish(js, data: dict):
    subject = data.pop("_subject", "media.audio.transcribed")
    event_type = data.pop("_type", subject)
    event = {"id": os.urandom(16).hex(), "type": event_type, "occurredAt": datetime.now(timezone.utc).isoformat(), "source": "media-worker", "data": data}
    # asyncpg returns UUID/other PostgreSQL-native values. Events cross a JSON
    # boundary, so normalize those values before handing the payload to NATS.
    await js.publish(subject, json.dumps(event, default=str).encode())


def s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3", endpoint_url=MINIO_ENDPOINT, aws_access_key_id=MINIO_ACCESS_KEY, aws_secret_access_key=MINIO_SECRET_KEY, config=Config(signature_version="s3v4"), region_name="us-east-1")
    return _s3


def media_bucket(kind: str | None, mime: str | None) -> str:
    normalized_kind = str(kind or "").strip().lower()
    normalized_mime = str(mime or "").split(";", 1)[0].strip().lower()
    if normalized_kind in MINIO_BUCKETS:
        return MINIO_BUCKETS[normalized_kind]
    for media_kind in ("image", "video", "audio", "document"):
        if normalized_mime.startswith(f"{media_kind}/") or (media_kind == "document" and (normalized_mime.startswith("application/") or normalized_mime.startswith("text/"))):
            return MINIO_BUCKETS[media_kind]
    return MINIO_BUCKETS["other"]


def cleanup_group_media(object_keys_by_bucket: dict[str, set[str]], local_paths: set[str]) -> tuple[int, int]:
    deleted_objects = 0
    if object_keys_by_bucket:
        client = s3_client()
        for bucket, object_keys in object_keys_by_bucket.items():
            ensure_bucket(bucket)
            for start in range(0, len(object_keys), 1000):
                batch = sorted(object_keys)[start:start + 1000]
                client.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True})
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
            """SELECT mo.object_key, mo.thumbnail_key, mo.bucket, mo.object_path, mo.thumbnail_path, mo.mime, m.kind, m.media_mime, aj.object_path AS audio_object_path
               FROM wa_groups g
               LEFT JOIN messages m ON m.group_id = g.id
               LEFT JOIN media_objects mo ON mo.message_id = m.id
               LEFT JOIN audio_jobs aj ON aj.message_id = m.id
               WHERE g.platform=$1 AND g.id=ANY($2::text[])""",
            platform, group_ids,
        )
        object_keys_by_bucket: dict[str, set[str]] = {}
        for row in rows:
            bucket = str(row["bucket"] or MINIO_BUCKET)
            object_keys_by_bucket.setdefault(bucket, set()).update(str(value) for value in (row["object_key"], row["thumbnail_key"]) if value)
        local_paths = {str(value) for row in rows for value in (row["object_path"], row["thumbnail_path"], row["audio_object_path"]) if value}
        deleted_objects, deleted_files = await asyncio.to_thread(cleanup_group_media, object_keys_by_bucket, local_paths)
        await message.respond(json.dumps({"ok": True, "deletedObjects": deleted_objects, "deletedFiles": deleted_files}).encode())
    except Exception as error:
        log.exception("group media cleanup failed")
        await message.respond(json.dumps({"ok": False, "error": str(error)}).encode())


def ensure_bucket(bucket: str = MINIO_BUCKET):
    client = s3_client()
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
        except Exception as error:
            log.warning("MinIO bucket %s could not be created: %s", bucket, error)


def extract_ocr(source: Path) -> str:
    try:
        run = subprocess.run(["tesseract", str(source), "stdout", "-l", "eng+deu+spa+fra"], capture_output=True, text=True, check=False, timeout=90)
        return run.stdout.strip() if run.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def extract_document_text(source: Path, mime: str) -> str:
    """Extract searchable text from common documents without sending them remotely."""
    AUDIO_WORK_DIR.mkdir(parents=True, exist_ok=True)
    normalized = mime.split(";", 1)[0].lower()
    suffix = source.suffix.lower()
    if normalized == "application/pdf" or suffix == ".pdf":
        run = subprocess.run(["pdftotext", "-layout", str(source), "-"], capture_output=True, text=True, check=False, timeout=120)
        text = run.stdout.strip() if run.returncode == 0 else ""
        if text:
            return text
        with tempfile.TemporaryDirectory(prefix="pdf-pages-", dir=AUDIO_WORK_DIR) as temp_dir:
            prefix = str(Path(temp_dir) / "page")
            subprocess.run(["pdftoppm", "-f", "1", "-l", "5", "-r", "150", "-png", str(source), prefix], capture_output=True, check=False, timeout=180)
            pages = sorted(Path(temp_dir).glob("page-*.png"))
            return "\n".join(filter(None, (extract_ocr(page) for page in pages))).strip()
    if normalized in {"text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/xml"} or suffix in {".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm"}:
        return source.read_text(encoding="utf-8", errors="replace").strip()[:200_000]
    if normalized == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" or suffix == ".docx":
        try:
            with zipfile.ZipFile(source) as archive:
                xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
            return re.sub(r"<[^>]+>", " ", xml).replace("&amp;", "&").strip()[:200_000]
        except (KeyError, zipfile.BadZipFile, OSError):
            return ""
    return ""


def bounded_analysis_text(value: str | None) -> str:
    """Avoid placing complete OCR/document contents in a NATS event.

    The complete result is written to media_objects.ocr_text before this
    helper is used. AI can fetch that persisted value and apply its own
    analysis limit.
    """
    normalized = str(value or "").strip()
    if len(normalized) <= MEDIA_ANALYSIS_EVENT_MAX_CHARS:
        return normalized
    return (
        normalized[:MEDIA_ANALYSIS_EVENT_MAX_CHARS].rstrip()
        + "\n[Dokumentinhalt für die Analyse gekürzt; Original bleibt vollständig gespeichert.]"
    )


def stage_media(data: dict) -> tuple[str, str, str | None, str, int, str]:
    source = Path(str(data["objectPath"]))
    if not source.is_file():
        raise FileNotFoundError(f"Medienquelle nicht gefunden: {source}")
    message_id = str(data["messageId"])
    media_key = str(data["mediaKey"])
    mime = str(data.get("mediaMime") or "application/octet-stream")
    bucket = media_bucket(data.get("kind"), mime)
    suffix = source.suffix.lower() or ".bin"
    object_key = f"messages/{message_id}/original{suffix}"
    thumbnail_key = None
    thumbnail_path = None
    ocr_text = ""
    ensure_bucket(bucket)
    client = s3_client()
    client.upload_file(str(source), bucket, object_key, ExtraArgs={"ContentType": mime})
    if mime.startswith("image/"):
        try:
            thumb_dir = MEDIA_DIR / "thumbs"
            thumb_dir.mkdir(parents=True, exist_ok=True)
            thumb = thumb_dir / f"{message_id}.jpg"
            with Image.open(source) as image:
                image.thumbnail((640, 640))
                image.convert("RGB").save(thumb, format="JPEG", quality=82)
            thumbnail_key = f"messages/{message_id}/thumbnail.jpg"
            client.upload_file(str(thumb), bucket, thumbnail_key, ExtraArgs={"ContentType": "image/jpeg"})
            thumbnail_path = str(thumb)
            ocr_text = extract_ocr(source)
        except Exception as error:
            log.warning("image processing failed for %s: %s", message_id, error)
    elif mime.startswith("application/") or source.suffix.lower() in {".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm"}:
        try:
            ocr_text = extract_document_text(source, mime)
        except Exception as error:
            log.warning("document analysis failed for %s: %s", message_id, error)
    return bucket, object_key, thumbnail_key, thumbnail_path or "", source.stat().st_size, ocr_text


async def on_media(db, js, message):
    payload = json.loads(message.data)
    data = payload.get("data", payload)
    message_id = data["messageId"]
    media_key = data["mediaKey"]
    event_id = payload_id(payload, message.data)
    if not await claim_event(db, "media.objects", event_id, message.subject, payload):
        await message.ack()
        return
    try:
        await db.execute("UPDATE messages SET media_status='processing' WHERE id=$1", message_id)
        ocr_text = await stage_and_record_media(db, data)
        await db.execute("UPDATE messages SET media_status='completed' WHERE id=$1", message_id)
        message_kind = await db.fetchval("SELECT kind FROM messages WHERE id=$1", message_id)
        if ocr_text:
            if message_kind == "image":
                await publish(js, {"_subject": "media.image.analyzed", "_type": "media.image.analyzed", "messageId": message_id, "ocrText": bounded_analysis_text(ocr_text), "provider": "tesseract"})
            elif message_kind == "document":
                await publish(js, {"_subject": "media.document.analyzed", "_type": "media.document.analyzed", "messageId": message_id, "text": bounded_analysis_text(ocr_text), "mime": data.get("mediaMime"), "provider": "local-document-extractor"})
        if str(data.get("mediaMime", "")).startswith("audio/"):
            job = await db.fetchrow(
                """UPDATE audio_jobs
                   SET object_path=COALESCE(NULLIF($1, ''), object_path),
                       media_mime=COALESCE(media_mime, $4),
                       updated_at=NOW()
                   WHERE message_id=$2 AND media_key=$3
                   RETURNING id::text, status, media_mime, object_path""",
                data.get("objectPath"), message_id, media_key, data.get("mediaMime"),
            )
            # The connector may publish an audio event before or alongside the
            # media event. Only a queued canonical job needs another trigger;
            # completed, processing and failed jobs must not be started again.
            if job and job["status"] == "queued":
                await publish(js, {"_subject": "media.audio.requested", "_type": "media.audio.requested", "jobId": str(job["id"]), "messageId": message_id, "mediaKey": media_key, "mediaMime": job["media_mime"] or data.get("mediaMime"), "objectPath": job["object_path"] or data.get("objectPath")})
        await mark_processed(db, "media.objects", event_id)
        await message.ack()
    except Exception as error:
        deliveries = int(getattr(message.metadata, "num_delivered", 1) or 1) if message.metadata else 1
        await db.execute("UPDATE messages SET media_status=$2 WHERE id=$1", message_id, "failed" if deliveries >= 5 else "pending")
        await db.execute("INSERT INTO media_objects (message_id, media_key, status, error, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (message_id, media_key) DO UPDATE SET status=$3, error=$4, updated_at=NOW()", message_id, media_key, "failed" if deliveries >= 5 else "pending", str(error))
        log.exception("media job failed")
        await retry_or_dead_letter(db, js, message, payload, "media.objects", error)


async def stage_and_record_media(db, data: dict) -> str:
    bucket, object_key, thumbnail_key, thumbnail_path, size, ocr_text = await asyncio.to_thread(stage_media, data)
    await db.execute(
        """INSERT INTO media_objects (message_id, media_key, bucket, object_key, thumbnail_key, object_path, thumbnail_path, mime, bytes, status, ocr_text, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10,NOW())
           ON CONFLICT (message_id, media_key) DO UPDATE SET object_key=EXCLUDED.object_key, thumbnail_key=EXCLUDED.thumbnail_key,
             object_path=EXCLUDED.object_path, thumbnail_path=EXCLUDED.thumbnail_path, mime=EXCLUDED.mime, bytes=EXCLUDED.bytes,
             bucket=EXCLUDED.bucket, status='completed', error=NULL, ocr_text=EXCLUDED.ocr_text, updated_at=NOW()""",
        data["messageId"], data["mediaKey"], bucket, object_key, thumbnail_key, data.get("objectPath"), thumbnail_path or None,
        data.get("mediaMime"), size, ocr_text or None,
    )
    return ocr_text


def local_media_path(data: dict) -> Path | None:
    platform = str(data.get("platform") or "")
    message_id = str(data.get("waMessageId") or "")
    media_key = str(data.get("mediaKey") or "")
    if platform == "whatsapp" and message_id:
        base = message_id
    else:
        base = "".join(value if value.isalnum() or value in "_-" else "_" for value in media_key)
    if not base:
        return None
    candidates = sorted(path for path in (MEDIA_DIR / "incoming").glob(f"{base}*") if path.is_file())
    if not candidates:
        return None
    media_mime = str(data.get("mediaMime") or "")
    preferred = "." + media_mime.split("/", 1)[1].split(";", 1)[0] if "/" in media_mime else ""
    for path in candidates:
        if preferred and path.suffix.lower() == preferred.lower():
            return path
    return candidates[0]


async def repair_local_media(db, js):
    rows = await db.fetch(
        """SELECT m.id, m.platform, m.wa_message_id, m.media_key, m.media_mime, m.kind
           FROM messages m
           WHERE m.has_media=TRUE AND m.media_key IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM media_objects mo
               WHERE mo.message_id=m.id AND mo.status='completed' AND mo.object_path IS NOT NULL
             )
           ORDER BY m.received_at DESC"""
    )
    if not rows:
        return
    repaired = 0
    for row in rows:
        data = {
            "messageId": str(row["id"]),
            "mediaKey": str(row["media_key"]),
            "mediaMime": row["media_mime"],
            "kind": row["kind"],
            "platform": row["platform"],
            "waMessageId": row["wa_message_id"],
        }
        source = local_media_path(data)
        if source is None:
            continue
        data["objectPath"] = str(source)
        try:
            analysis_text = await stage_and_record_media(db, data)
            await db.execute("UPDATE messages SET media_status='completed' WHERE id=$1", data["messageId"])
            if analysis_text and row["kind"] == "image":
                await publish(js, {"_subject": "media.image.analyzed", "_type": "media.image.analyzed", "messageId": data["messageId"], "ocrText": bounded_analysis_text(analysis_text), "provider": "tesseract"})
            elif analysis_text and row["kind"] == "document":
                await publish(js, {"_subject": "media.document.analyzed", "_type": "media.document.analyzed", "messageId": data["messageId"], "text": bounded_analysis_text(analysis_text), "mime": row["media_mime"], "provider": "local-document-extractor"})
            repaired += 1
        except Exception:
            log.exception("local media repair failed for %s", data["messageId"])
    if repaired:
        log.info("repaired %s local media file(s) without a completed media object", repaired)


async def main():
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=3)

    async def on_disconnected():
        log.warning("NATS connection lost; waiting for reconnect")

    async def on_reconnected():
        log.info("NATS connection restored")

    async def on_nats_error(error):
        log.error("NATS client error: %s", error)

    nc = await nats.connect(
        NATS_URL,
        reconnect_time_wait=2,
        max_reconnect_attempts=-1,
        disconnected_cb=on_disconnected,
        reconnected_cb=on_reconnected,
        error_cb=on_nats_error,
    )
    js = nc.jetstream()
    try:
        await js.stream_info("WAGI_EVENTS")
    except Exception:
        try:
            await js.add_stream(name="WAGI_EVENTS", subjects=["wa.>", "media.>", "ai.messages.>", "ai.feedback.>", "connector.>", "replay.>"])
        except Exception:
            await js.stream_info("WAGI_EVENTS")

    async def on_audio(message):
        payload = {}
        job_id = None
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "media.audio", event_id, message.subject, payload):
                await message.ack()
                return
            job_id = str(data.get("jobId") or "").strip()
            if not job_id:
                await mark_processed(db, "media.audio", event_id)
                await message.ack()
                return
            # Claim the durable job atomically. This closes the race between
            # duplicate connector events and duplicate JetStream deliveries:
            # exactly one worker can transition queued -> processing.
            claimed = await db.fetchrow(
                """UPDATE audio_jobs
                   SET status='processing', attempts=attempts+1,
                       next_attempt_at=NULL, updated_at=NOW()
                   WHERE id=$1 AND status='queued'
                   RETURNING id::text, message_id::text, media_mime, object_path""",
                job_id,
            )
            if not claimed:
                await mark_processed(db, "media.audio", event_id)
                await message.ack()
                return
            source = data.get("objectPath") or claimed["object_path"]
            if WHISPER_ENABLED:
                if not source or not os.path.isfile(source):
                    raise FileNotFoundError(f"Audioquelle nicht verfügbar: {source or data.get('mediaKey', 'unbekannt')}")
                # whisper.cpp can run for minutes with the medium model. Keep
                # the asyncio/NATS loop responsive so media jobs and JetStream
                # heartbeats continue while transcription is in progress.
                transcript, language, confidence = await asyncio.to_thread(transcribe_with_whisper_cpp, source)
                provider = "whisper.cpp"
            else:
                transcript, language, confidence = transcribe_placeholder(source or data.get("mediaKey", "unknown"))
                provider = "placeholder-mvp"
            await publish(js, {"jobId": job_id, "messageId": data["messageId"], "transcript": transcript, "language": language, "confidence": confidence, "provider": provider})
            await db.execute("UPDATE audio_jobs SET status='completed', transcript=$1, language=$2, confidence=$3, error=NULL, updated_at=NOW() WHERE id=$4", transcript, language, confidence, job_id)
            await mark_processed(db, "media.audio", event_id)
            await message.ack()
        except Exception as exc:
            log.exception("audio job failed")
            if job_id:
                attempts = await db.fetchval("SELECT attempts FROM audio_jobs WHERE id=$1", job_id) or MEDIA_MAX_RETRIES
                next_status = "queued" if attempts < MEDIA_MAX_RETRIES else "failed"
                await db.execute("UPDATE audio_jobs SET status=$1, error=$2, next_attempt_at=CASE WHEN $1='queued' THEN NOW()+INTERVAL '30 seconds' ELSE NULL END, updated_at=NOW() WHERE id=$3", next_status, str(exc), job_id)
            await retry_or_dead_letter(db, js, message, payload, "media.audio", exc)

    async def republish_due_audio_jobs():
        """Recover queued jobs after a worker restart or a transient failure."""
        while True:
            try:
                await db.execute(
                    """UPDATE audio_jobs
                       SET status=CASE WHEN attempts < $1 THEN 'queued' ELSE 'failed' END,
                           error=COALESCE(error, 'worker restarted while audio job was processing'),
                           next_attempt_at=CASE WHEN attempts < $1 THEN NOW() ELSE NULL END,
                           updated_at=NOW()
                       WHERE status='processing' AND updated_at < NOW() - ($2 * INTERVAL '1 second')""",
                    MEDIA_MAX_RETRIES,
                    MEDIA_STALE_PROCESSING_SECONDS,
                )
                rows = await db.fetch(
                    """SELECT id::text, message_id::text, media_key, media_mime, object_path
                       FROM audio_jobs
                       WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
                       ORDER BY COALESCE(next_attempt_at, created_at), created_at
                       LIMIT 20"""
                )
                for row in rows:
                    claimed = await db.execute(
                        """UPDATE audio_jobs SET next_attempt_at=NOW()+INTERVAL '2 minutes', updated_at=NOW()
                           WHERE id=$1 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())""",
                        row["id"],
                    )
                    if claimed != "UPDATE 1":
                        continue
                    try:
                        await publish(js, {
                            "_subject": "media.audio.requested",
                            "_type": "media.audio.requested",
                            "jobId": str(row["id"]),
                            "messageId": str(row["message_id"]),
                            "mediaKey": row["media_key"],
                            "mediaMime": row["media_mime"],
                            "objectPath": row["object_path"],
                        })
                    except Exception:
                        await db.execute("UPDATE audio_jobs SET next_attempt_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='queued'", row["id"])
                        log.exception("could not republish audio job %s", row["id"])
            except Exception:
                log.exception("audio retry scheduler failed")
            await asyncio.sleep(5)

    await js.subscribe("media.objects.requested", durable="WAGI_MEDIA_OBJECTS", stream="WAGI_EVENTS", cb=lambda message: on_media(db, js, message))
    await js.subscribe("media.audio.requested", durable="WAGI_MEDIA_AUDIO", stream="WAGI_EVENTS", cb=on_audio)
    await repair_placeholder_audio_jobs(db)
    asyncio.create_task(repair_local_media(db, js))
    asyncio.create_task(republish_due_audio_jobs())
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
