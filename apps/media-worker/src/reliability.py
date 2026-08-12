import json
import os
from datetime import datetime, timezone
from hashlib import sha256


MAX_EVENT_DELIVERIES = max(1, int(os.getenv("NATS_MAX_DELIVERIES", "5")))
RETRY_BASE_SECONDS = max(1.0, float(os.getenv("NATS_RETRY_BASE_SECONDS", "5")))
RETRY_MAX_SECONDS = max(RETRY_BASE_SECONDS, float(os.getenv("NATS_RETRY_MAX_SECONDS", "300")))


def payload_id(payload: dict, raw: bytes) -> str:
    return str(payload.get("id") or sha256(raw).hexdigest())


async def claim_event(db, consumer: str, event_id: str, subject: str, payload: dict) -> bool:
    encoded = json.dumps(payload, default=str)
    inserted = await db.fetchrow(
        """INSERT INTO event_inbox (consumer_name, event_id, subject, payload, status, attempts)
           VALUES ($1,$2,$3,$4::jsonb,'processing',1)
           ON CONFLICT DO NOTHING RETURNING event_id""",
        consumer, event_id, subject, encoded,
    )
    if inserted:
        return True
    resumed = await db.fetchrow(
        """UPDATE event_inbox
           SET status='processing', attempts=attempts+1, updated_at=NOW(), last_error=NULL
           WHERE consumer_name=$1 AND event_id=$2 AND status <> 'processed'
             AND (status <> 'processing' OR updated_at < NOW() - INTERVAL '15 minutes')
           RETURNING event_id""",
        consumer, event_id,
    )
    return bool(resumed)


async def mark_processed(db, consumer: str, event_id: str):
    await db.execute(
        """UPDATE event_inbox SET status='processed', processed_at=NOW(), updated_at=NOW(), last_error=NULL
           WHERE consumer_name=$1 AND event_id=$2""",
        consumer, event_id,
    )


async def mark_retry(db, consumer: str, event_id: str, error: str):
    await db.execute(
        """UPDATE event_inbox SET status='retry', last_error=$3, updated_at=NOW()
           WHERE consumer_name=$1 AND event_id=$2""",
        consumer, event_id, error[:2000],
    )


async def retry_or_dead_letter(db, js, message, payload: dict, consumer: str, error: Exception):
    event_id = payload_id(payload, message.data)
    metadata = message.metadata
    deliveries = int(getattr(metadata, "num_delivered", 1) or 1) if metadata else 1
    if deliveries < MAX_EVENT_DELIVERIES:
        await mark_retry(db, consumer, event_id, str(error))
        delay = min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** max(0, deliveries - 1)))
        await message.nak(delay=delay)
        return
    subject = getattr(message, "subject", "unknown")
    await db.execute(
        """INSERT INTO event_failures (event_id, subject, consumer_name, payload, error, attempts)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6)
           ON CONFLICT (event_id, consumer_name) DO UPDATE SET error=EXCLUDED.error, attempts=EXCLUDED.attempts""",
        event_id, subject, consumer, json.dumps(payload, default=str), str(error)[:4000], deliveries,
    )
    dlq_event = {
        "id": event_id,
        "type": f"dlq.{subject}",
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "source": consumer,
        "data": {"originalSubject": subject, "deliveries": deliveries, "error": str(error), "event": payload},
    }
    await js.publish(f"dlq.{subject}", json.dumps(dlq_event, default=str).encode())
    await db.execute(
        "UPDATE event_inbox SET status='failed', last_error=$3, updated_at=NOW() WHERE consumer_name=$1 AND event_id=$2",
        consumer, event_id, str(error)[:2000],
    )
    await message.ack()
