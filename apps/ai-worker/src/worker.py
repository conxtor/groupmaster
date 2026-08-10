import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone

import asyncpg
import nats
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("wagi-ai-worker")

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
MODEL = os.getenv("AI_MODEL", "heuristic-mvp")


class Fact(BaseModel):
    text: str
    confidence: float = Field(ge=0, le=1)


class Entity(BaseModel):
    name: str
    type: str
    confidence: float = Field(ge=0, le=1)


class Event(BaseModel):
    title: str
    startsAt: str | None = None
    location: str | None = None
    confidence: float = Field(ge=0, le=1)
    sourceMessageIds: list[str] = Field(default_factory=list)


class Analysis(BaseModel):
    messageId: str
    relevant: bool
    relevanceScore: float = Field(ge=0, le=1)
    summary: str
    facts: list[Fact]
    entities: list[Entity]
    events: list[Event]
    places: list[dict]
    model: str


def as_object(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def location_details(item: dict) -> dict | None:
    raw = as_object(item.get("raw"))
    message = as_object(raw.get("message"))
    location = as_object(message.get("locationMessage"))
    if not location:
        telegram_location = as_object(raw.get("location"))
        if telegram_location:
            latitude = telegram_location.get("latitude")
            longitude = telegram_location.get("longitude")
            label = f"Telegram-Ort: {latitude}, {longitude}"
            return {
                "label": label,
                "name": label,
                "latitude": latitude,
                "longitude": longitude,
            }
    if not location:
        return None
    name = str(location.get("name") or "").strip()
    address = str(location.get("address") or "").strip()
    label = " — ".join(part for part in (name, address) if part) or "Geteilter Ort"
    return {
        "label": label,
        "name": name or label,
        "latitude": location.get("degreesLatitude"),
        "longitude": location.get("degreesLongitude"),
    }


def reply_target(item: dict) -> str | None:
    if item.get("replyToWaMessageId"):
        return str(item["replyToWaMessageId"])
    raw = as_object(item.get("raw"))
    message = as_object(raw.get("message"))
    telegram_reply = as_object(raw.get("reply_to_message"))
    if telegram_reply.get("message_id") is not None and item.get("groupId"):
        return f"{item['groupId']}:{telegram_reply['message_id']}"
    for key in ("extendedTextMessage", "imageMessage", "audioMessage", "videoMessage"):
        context = as_object(as_object(message.get(key)).get("contextInfo"))
        if context.get("stanzaId"):
            return str(context["stanzaId"])
    return None


def is_event_anchor(text: str) -> bool:
    normalized = text.lower()
    return any(word in normalized for word in (
        "morgen", "heute", "samstag", "sonntag", "treffen", "wanderung", "meeting", "termin",
        "event", "fahren", "fahrt", "domingo", "dimanche", "reunion",
    ))


def starts_at(text: str) -> str | None:
    match = re.search(
        r"\b(morgen|heute|samstag|sonntag|domingo|dimanche)\b(?:\s+\w+){0,3}\s+(\d{1,2})(?::(\d{2}))?\s*(?:uhr|h)?",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return f"{match.group(1).capitalize()} {int(match.group(2)):02d}:{match.group(3) or '00'}"


def multi_message_events(message_id: str, context: list[dict]) -> list[Event]:
    ordered = sorted((item for item in context if item.get("id")), key=lambda item: str(item.get("receivedAt") or ""))
    anchors = [item for item in ordered if item.get("text") and is_event_anchor(str(item["text"]))]
    locations = [(item, location_details(item)) for item in ordered]
    locations = [(item, location) for item, location in locations if location]
    if not anchors or not locations:
        return []

    anchor = anchors[0]
    current_location = next(((item, location) for item, location in locations if item.get("id") == message_id), None)
    if current_location is None:
        current = next((item for item in ordered if str(item.get("id")) == message_id), None)
        reply_wa_id = reply_target(current) if current else None
        current_location = next(
            ((item, location) for item, location in locations if str(item.get("waMessageId")) == str(reply_wa_id)),
            None,
        )
    location_item, location = current_location or min(
        locations,
        key=lambda pair: abs(ordered.index(pair[0]) - ordered.index(anchor)),
    )
    source_ids = [str(anchor["id"]), str(location_item["id"])]
    source_wa_ids = {str(anchor.get("waMessageId")), str(location_item.get("waMessageId"))}
    for item in ordered:
        if reply_target(item) in source_wa_ids:
            source_ids.append(str(item["id"]))

    current = next((item for item in ordered if str(item.get("id")) == message_id), None)
    current_is_related = message_id in source_ids or (current is not None and reply_target(current) in source_wa_ids)
    if not current_is_related or len(set(source_ids)) < 2:
        return []

    anchor_text = str(anchor["text"]).strip()
    title = f"{anchor_text[:100]} — {location['name']}"
    return [Event(
        title=title,
        startsAt=starts_at(anchor_text),
        location=location["label"],
        confidence=0.82,
        sourceMessageIds=list(dict.fromkeys(source_ids)),
    )]


def heuristic_analysis(message_id: str, text: str, context: list[dict]) -> Analysis:
    normalized = text.strip()
    keywords = ("morgen", "heute", "treffen", "termin", "event", "wichtig", "ort", "straße", "bahnhof", "meeting", "samstag", "sonntag", "costa", "montserrat")
    hits = sum(1 for word in keywords if word in normalized.lower())
    score = min(0.25 + hits * 0.12, 0.98)
    events = multi_message_events(message_id, context)
    if events:
        score = max(score, 0.78)
    relevant = score >= 0.45 or bool(events)
    facts = [Fact(text=normalized, confidence=0.64)] if normalized else []
    entities = []
    for candidate in re.findall(r"\b[A-ZÄÖÜ][\wÄÖÜäöüß-]{2,}\b", normalized):
        if candidate.lower() not in {"Bitte", "Treffen"}:
            entities.append(Entity(name=candidate, type="mention", confidence=0.55))
    event = {}
    if any(word in normalized.lower() for word in ("morgen", "heute", "termin", "treffen")):
        event = {"title": normalized[:120], "confidence": 0.58}
    current = next((item for item in context if str(item.get("id")) == message_id), {})
    location = location_details(current)
    place = {}
    if location:
        place = {"name": location["name"], "latitude": location["latitude"], "longitude": location["longitude"], "confidence": 0.9}
    elif any(word in normalized.lower() for word in ("ort", "bahnhof", "straße")):
        place = {"name": normalized[:80], "confidence": 0.45}
    return Analysis(
        messageId=message_id,
        relevant=relevant,
        relevanceScore=round(score, 4),
        summary=normalized[:180] or "Leere Nachricht ohne Text",
        facts=facts,
        entities=entities[:10],
        events=events or ([Event(**event)] if event else []),
        places=[place] if place else [],
        model=MODEL,
    )


async def publish(js, subject: str, event_type: str, data: dict):
    event = {
        "id": os.urandom(16).hex(),
        "type": event_type,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "source": "ai-worker",
        "data": data,
    }
    await js.publish(subject, json.dumps(event).encode())


async def main():
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    try:
        await js.stream_info("WAGI_EVENTS")
    except Exception:
        try:
            await js.add_stream(name="WAGI_EVENTS", subjects=["wa.>", "media.>", "ai.>"])
        except Exception:
            await js.stream_info("WAGI_EVENTS")

    async def analyze_message(payload: dict):
        data = payload.get("data", payload)
        message_id = data.get("messageId")
        text = data.get("text") or ""
        if not message_id:
            return
        current = await db.fetchrow(
            """SELECT id::text AS id, wa_message_id AS "waMessageId", group_id AS "groupId", kind, text, received_at AS "receivedAt",
                      CASE WHEN raw ? 'reply_to_message' THEN group_id || ':' || (raw #>> '{reply_to_message,message_id}') END AS "replyToWaMessageId", raw
               FROM messages WHERE id = $1""",
            message_id,
        )
        group_id = data.get("groupId") or (current["groupId"] if current else None)
        context: list[dict] = []
        if group_id:
            rows = await db.fetch(
                """SELECT id::text AS id, wa_message_id AS "waMessageId", group_id AS "groupId", kind, text, received_at AS "receivedAt",
                          CASE WHEN raw ? 'reply_to_message' THEN group_id || ':' || (raw #>> '{reply_to_message,message_id}') END AS "replyToWaMessageId", raw
                   FROM messages WHERE group_id = $1 ORDER BY received_at DESC LIMIT 25""",
                group_id,
            )
            context = [dict(row) for row in rows]
        if current:
            current_item = dict(current)
            if "text" in data and data.get("text") is not None:
                current_item["text"] = data.get("text")
            if not any(str(item.get("id")) == str(message_id) for item in context):
                context.append(current_item)
            else:
                for item in context:
                    if str(item.get("id")) == str(message_id) and "text" in data and data.get("text") is not None:
                        item["text"] = data.get("text")
        analysis = heuristic_analysis(message_id, text, context)
        serialized_analysis = analysis.model_dump(mode="json")
        await db.execute(
            """INSERT INTO message_analyses (message_id, relevant, relevance_score, summary, facts, entities, events, places, model)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)
               ON CONFLICT (message_id) DO UPDATE SET relevant=EXCLUDED.relevant, relevance_score=EXCLUDED.relevance_score,
               summary=EXCLUDED.summary, facts=EXCLUDED.facts, entities=EXCLUDED.entities, events=EXCLUDED.events,
               places=EXCLUDED.places, model=EXCLUDED.model, updated_at=NOW()""",
            message_id, analysis.relevant, analysis.relevanceScore, analysis.summary,
            json.dumps(serialized_analysis["facts"]), json.dumps(serialized_analysis["entities"]),
            json.dumps(serialized_analysis["events"]), json.dumps(serialized_analysis["places"]), analysis.model,
        )
        await publish(js, "ai.messages.analyzed", "ai.messages.analyzed", serialized_analysis)

    async def on_message(message):
        try:
            await analyze_message(json.loads(message.data))
            await message.ack()
        except Exception:
            log.exception("failed to analyze message")

    async def on_transcript(message):
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            await db.execute("UPDATE audio_jobs SET status='completed', transcript=$1, language=$2, confidence=$3, updated_at=NOW() WHERE id=$4", data.get("transcript", ""), data.get("language"), data.get("confidence"), data.get("jobId"))
            await analyze_message({"data": {"messageId": data.get("messageId"), "text": data.get("transcript", "")}})
            await message.ack()
        except Exception:
            log.exception("failed to consume transcript")

    await js.subscribe("wa.messages.received", durable="WAGI_AI_MESSAGES", stream="WAGI_EVENTS", cb=on_message)
    await js.subscribe("media.audio.transcribed", durable="WAGI_AI_TRANSCRIPTS", stream="WAGI_EVENTS", cb=on_transcript)
    log.info("AI worker listening on wa.messages.received and media.audio.transcribed")
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
