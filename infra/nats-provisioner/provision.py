import asyncio
import logging
import os

import nats
from nats.js.api import AckPolicy, ConsumerConfig, RetentionPolicy, StorageType, StreamConfig

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("wagi-nats-provisioner")

NATS_URL = os.getenv("NATS_URL", "nats://nats:4222")

STREAMS = [
    StreamConfig(
        name="WAGI_EVENTS",
        # Keep reassessment traffic out of the live event stream. The narrow
        # AI subjects also prevent overlap with WAGI_REASSESSMENT.
        subjects=["wa.>", "media.>", "ai.messages.>", "ai.feedback.>", "connector.>", "replay.>"],
        storage=StorageType.FILE,
        retention=RetentionPolicy.LIMITS,
        max_msgs=-1,
        max_age=int(os.getenv("NATS_EVENT_MAX_AGE_DAYS", "30")) * 24 * 60 * 60,
        duplicate_window=10 * 60,
    ),
    StreamConfig(
        name="WAGI_DLQ",
        subjects=["dlq.>"],
        storage=StorageType.FILE,
        retention=RetentionPolicy.LIMITS,
        max_msgs=-1,
        max_age=int(os.getenv("NATS_DLQ_MAX_AGE_DAYS", "90")) * 24 * 60 * 60,
    ),
    StreamConfig(
        name="WAGI_REASSESSMENT",
        subjects=["ai.reassessment.>"],
        storage=StorageType.FILE,
        retention=RetentionPolicy.LIMITS,
        max_msgs=-1,
        max_age=int(os.getenv("NATS_REASSESSMENT_MAX_AGE_DAYS", "30")) * 24 * 60 * 60,
        duplicate_window=10 * 60,
    ),
    StreamConfig(
        name="WAGI_KB_REBUILD",
        subjects=["knowledge.rebuild.>"],
        storage=StorageType.FILE,
        retention=RetentionPolicy.LIMITS,
        max_msgs=-1,
        max_age=int(os.getenv("NATS_KB_REBUILD_MAX_AGE_DAYS", "30")) * 24 * 60 * 60,
        duplicate_window=10 * 60,
    ),
]

CONSUMERS = [
    ("WAGI_EVENTS", "WAGI_AI_MESSAGES", "wa.messages.received"),
    ("WAGI_EVENTS", "WAGI_AI_TRANSCRIPTS", "media.audio.transcribed"),
    ("WAGI_EVENTS", "WAGI_AI_IMAGES", "media.image.analyzed"),
    ("WAGI_EVENTS", "WAGI_AI_DOCUMENTS", "media.document.analyzed"),
    ("WAGI_EVENTS", "WAGI_AI_REPLAY", "replay.requested"),
    ("WAGI_EVENTS", "WAGI_MEDIA_OBJECTS", "media.objects.requested"),
    ("WAGI_EVENTS", "WAGI_MEDIA_AUDIO", "media.audio.requested"),
    ("WAGI_REASSESSMENT", "WAGI_AI_REASSESSMENT", "ai.reassessment.requested"),
    ("WAGI_KB_REBUILD", "WAGI_KB_REBUILD", "knowledge.rebuild.requested"),
]


async def provision(js):
    for config in STREAMS:
        try:
            await js.add_stream(config=config)
        except Exception as error:
            if "stream name already in use" in str(error).lower() or "already exists" in str(error).lower():
                try:
                    await js.update_stream(config=config)
                except Exception:
                    log.info("stream %s already provisioned", config.name)
            else:
                raise
    for stream, durable, subject in CONSUMERS:
        ack_wait = 5 * 60
        if durable == "WAGI_AI_REASSESSMENT":
            ack_wait = int(os.getenv("NATS_REASSESSMENT_ACK_WAIT_SECONDS", "86400"))
        if durable == "WAGI_KB_REBUILD":
            ack_wait = int(os.getenv("NATS_KB_REBUILD_ACK_WAIT_SECONDS", "86400"))
        config = ConsumerConfig(
            durable_name=durable,
            filter_subject=subject,
            deliver_subject=f"_INBOX.wagi.{durable.lower()}",
            ack_policy=AckPolicy.EXPLICIT,
            ack_wait=ack_wait,
            max_deliver=int(os.getenv("NATS_MAX_DELIVERIES", "5")),
        )
        try:
            await js.add_consumer(stream, config=config)
        except Exception as error:
            if "consumer name already in use" in str(error).lower() or "already exists" in str(error).lower():
                log.info("consumer %s already provisioned", durable)
            else:
                raise
    log.info("provisioned %d streams and %d durable consumers", len(STREAMS), len(CONSUMERS))


async def main():
    nc = await nats.connect(NATS_URL, reconnect_time_wait=2, max_reconnect_attempts=20)
    try:
        await provision(nc.jetstream())
    finally:
        await nc.drain()


if __name__ == "__main__":
    asyncio.run(main())
