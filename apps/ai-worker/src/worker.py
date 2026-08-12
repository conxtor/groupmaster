import asyncio
import json
import logging
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Literal

import asyncpg
import nats
import httpx
from pydantic import BaseModel, Field

from reliability import claim_event, mark_processed, payload_id, retry_or_dead_letter

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("wagi-ai-worker")

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
MODEL = os.getenv("AI_MODEL", "heuristic-mvp")
AI_PROVIDER = os.getenv("AI_PROVIDER", "hybrid").lower()
PROMPT_VERSION = os.getenv("AI_PROMPT_VERSION", "phase1-v2-precision")
SCHEMA_VERSION = "1.1"
SUPPORTED_GROUP_LANGUAGES = ("de", "es", "ca", "en", "fr")
_HERMES_CONFIGURED = os.getenv("AI_HERMES_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
_CONFIGURED_KNOWLEDGE_VERSION = os.getenv("AI_KNOWLEDGE_VERSION", "hierarchy-v3")
KNOWLEDGE_REBUILD_VERSION = _CONFIGURED_KNOWLEDGE_VERSION + ("-hermes" if _HERMES_CONFIGURED and not _CONFIGURED_KNOWLEDGE_VERSION.endswith("-hermes") else "")
KNOWLEDGE_STATE_CONNECTOR = "ai-worker-knowledge"
EMBEDDING_DIMENSIONS = 384
EMBEDDINGS_ENABLED = os.getenv("AI_EMBEDDINGS_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
EMBEDDING_MODEL = os.getenv("AI_EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
EMBEDDING_CACHE_DIR = os.getenv("AI_EMBEDDING_CACHE_DIR", "/root/.cache/fastembed")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
HF_MODEL_LOAD_INTERVAL_SECONDS = max(3600.0, float(os.getenv("AI_HF_MODEL_LOAD_INTERVAL_SECONDS", "86400")))
SEMANTIC_DISCOVERY_THRESHOLD = float(os.getenv("AI_SEMANTIC_DISCOVERY_THRESHOLD", "0.84"))
SEMANTIC_MERGE_THRESHOLD = float(os.getenv("AI_SEMANTIC_MERGE_THRESHOLD", "0.18"))
HERMES_ENABLED = _HERMES_CONFIGURED
HERMES_URL = os.getenv("AI_HERMES_URL", "").strip() or os.getenv("AI_ENDPOINT", "").strip()
HERMES_API_KEY = os.getenv("AI_HERMES_API_KEY", "").strip() or os.getenv("AI_API_KEY", "").strip()
HERMES_MODEL = os.getenv("AI_HERMES_MODEL", "hermes-agent").strip()
HERMES_TIMEOUT_SECONDS = max(5.0, float(os.getenv("AI_HERMES_TIMEOUT_MS", "30000")) / 1000)
HERMES_REVIEW_ALL = os.getenv("AI_HERMES_REVIEW_ALL", "false").lower() in {"1", "true", "yes", "on"}
HERMES_MIN_CONFIDENCE = float(os.getenv("AI_HERMES_MIN_CONFIDENCE", "0.78"))

LANGUAGE_MARKERS = {
    "de": {"der", "die", "das", "und", "für", "nicht", "mit", "ist", "sind", "auf", "von", "eine", "einer", "morgen", "heute", "treffen", "danke", "bitte", "auch", "wird", "straße"},
    "es": {"el", "la", "los", "las", "que", "para", "con", "una", "uno", "está", "están", "mañana", "hoy", "domingo", "gracias", "desde", "viaje", "playa", "vamos"},
    "ca": {"els", "les", "que", "per", "amb", "una", "està", "estan", "demà", "avui", "diumenge", "gràcies", "també", "aquest", "aquesta", "viatge", "platja", "anem", "fins"},
    "en": {"the", "and", "for", "with", "this", "that", "are", "is", "tomorrow", "today", "meeting", "thanks", "please", "from", "travel", "beach", "we", "will"},
    "fr": {"le", "la", "les", "des", "que", "pour", "avec", "une", "est", "sont", "demain", "aujourd", "merci", "voyage", "plage", "nous", "vous", "rendez", "fait"},
}

KNOWLEDGE_TOPIC_TITLES = {
    "de": {
        "travel": "Reisen und Ausflüge",
        "technology": "Technik und Software",
        "radio": "Funk und Elektronik",
        "shopping": "Käufe und Empfehlungen",
        "people": "Personen und Organisationen",
        "places": "Orte und Treffpunkte",
        "entities": "Erwähnte Personen und Begriffe",
        "general": "Allgemeine Erkenntnisse",
    },
    "es": {
        "travel": "Viajes y excursiones",
        "technology": "Tecnología y software",
        "radio": "Radio y electrónica",
        "shopping": "Compras y recomendaciones",
        "people": "Personas y organizaciones",
        "places": "Lugares y puntos de encuentro",
        "entities": "Personas y términos mencionados",
        "general": "Conocimientos generales",
    },
    "ca": {
        "travel": "Viatges i excursions",
        "technology": "Tecnologia i programari",
        "radio": "Ràdio i electrònica",
        "shopping": "Compres i recomanacions",
        "people": "Persones i organitzacions",
        "places": "Llocs i punts de trobada",
        "entities": "Persones i termes esmentats",
        "general": "Coneixements generals",
    },
    "en": {
        "travel": "Travel and outings",
        "technology": "Technology and software",
        "radio": "Radio and electronics",
        "shopping": "Purchases and recommendations",
        "people": "People and organizations",
        "places": "Places and meeting points",
        "entities": "Mentioned people and terms",
        "general": "General insights",
    },
    "fr": {
        "travel": "Voyages et excursions",
        "technology": "Technologie et logiciels",
        "radio": "Radio et électronique",
        "shopping": "Achats et recommandations",
        "people": "Personnes et organisations",
        "places": "Lieux et points de rendez-vous",
        "entities": "Personnes et termes mentionnés",
        "general": "Connaissances générales",
    },
}


def detect_group_language(texts: list[str]) -> str | None:
    normalized = " ".join(text.strip().casefold() for text in texts if text and text.strip())
    if not normalized:
        return None
    words = re.findall(r"[a-zà-ÿäöüß]+", normalized)
    if len(words) < 2:
        return None
    scores = {language: sum(1 for word in words if word in markers) for language, markers in LANGUAGE_MARKERS.items()}
    # Accented words provide a useful tie-breaker for Catalan, Spanish, French and German.
    accent_hints = {
        "ca": ("à", "è", "ò", "ç", "ï", "l·l"),
        "es": ("á", "é", "í", "ó", "ú", "ñ"),
        "fr": ("à", "â", "ç", "é", "è", "ê", "ë", "î", "ï", "ô", "û", "ù", "ü", "œ"),
        "de": ("ä", "ö", "ü", "ß"),
    }
    for language, hints in accent_hints.items():
        scores[language] += sum(normalized.count(hint) for hint in hints) * 0.25
    best_language, best_score = max(scores.items(), key=lambda item: item[1])
    return best_language if best_score >= 1 else None


def localized_topic_title(topic_key: str, language: str | None) -> str:
    language = language if language in SUPPORTED_GROUP_LANGUAGES else "de"
    return KNOWLEDGE_TOPIC_TITLES[language].get(topic_key, KNOWLEDGE_TOPIC_TITLES["de"].get(topic_key, topic_key))


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


class Provenance(BaseModel):
    field: str
    sourceMessageIds: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0, le=1)


class Conflict(BaseModel):
    field: str
    messageIds: list[str] = Field(default_factory=list)
    description: str
    confidence: float | None = Field(default=None, ge=0, le=1)


class KnowledgeItem(BaseModel):
    topicKey: str
    topicTitle: str
    itemKey: str
    itemType: Literal["fact", "insight", "entity"] = "fact"
    content: str
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
    knowledge: list[KnowledgeItem]
    model: str
    schemaVersion: str = SCHEMA_VERSION
    promptVersion: str = PROMPT_VERSION
    provenance: list[Provenance] = Field(default_factory=list)
    conflicts: list[Conflict] = Field(default_factory=list)


class HermesDecision(BaseModel):
    decision: Literal["accept", "reject", "review"]
    topicKey: str | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str = ""


class EmbeddingProvider:
    """Lazy multilingual embedding provider with a safe lexical fallback."""

    def __init__(self):
        self.enabled = EMBEDDINGS_ENABLED
        self._model = None
        self._failed = False
        self._cache: dict[str, list[float]] = {}
        self._load_lock = threading.Lock()
        self._last_load_attempt = 0.0

    def _load(self):
        if self._model is not None or self._failed or not self.enabled:
            return
        with self._load_lock:
            if self._model is not None or self._failed:
                return
            now = time.monotonic()
            if now - self._last_load_attempt < HF_MODEL_LOAD_INTERVAL_SECONDS:
                return
            self._last_load_attempt = now
            try:
                from fastembed import TextEmbedding

                self._model = TextEmbedding(model_name=EMBEDDING_MODEL, cache_dir=EMBEDDING_CACHE_DIR)
                log.info(
                    "loaded embedding model %s from persistent cache %s (HF token=%s)",
                    EMBEDDING_MODEL,
                    EMBEDDING_CACHE_DIR,
                    "configured" if HF_TOKEN else "not configured",
                )
            except Exception:
                # Keep the provider retryable, but never retry the Hub on
                # every incoming message. The next attempt is gated by the
                # configured interval above; inference errors remain
                # permanently disabled for this worker instance.
                log.exception(
                    "could not load embedding model %s; retrying after %.0f seconds",
                    EMBEDDING_MODEL,
                    HF_MODEL_LOAD_INTERVAL_SECONDS,
                )

    def _embed_sync(self, text: str) -> list[float] | None:
        self._load()
        if self._model is None:
            return None
        try:
            input_text = f"passage: {text}" if "e5" in EMBEDDING_MODEL.casefold() else text
            values = list(self._model.embed([input_text]))[0]
            vector = [float(value) for value in values]
            if len(vector) != EMBEDDING_DIMENSIONS or not all(math.isfinite(value) for value in vector):
                raise ValueError(f"embedding dimension must be {EMBEDDING_DIMENSIONS}")
            norm = math.sqrt(sum(value * value for value in vector))
            return [value / norm for value in vector] if norm else None
        except Exception:
            self._failed = True
            log.exception("embedding inference failed; semantic stage disabled")
            return None

    async def embed(self, text: str) -> list[float] | None:
        normalized = " ".join(text.split()).strip()
        if not normalized or not self.enabled or self._failed:
            return None
        if normalized not in self._cache:
            vector = await asyncio.to_thread(self._embed_sync, normalized)
            if vector is not None:
                self._cache[normalized] = vector
        return self._cache.get(normalized)


class HermesReviewer:
    """Optional strict verifier for uncertain knowledge candidates."""

    def __init__(self):
        self.enabled = HERMES_ENABLED and bool(HERMES_URL)
        self.endpoint = self._normalize_endpoint(HERMES_URL) if self.enabled else ""
        if self.enabled:
            log.info("Hermes knowledge verifier enabled at %s", self.endpoint)

    @staticmethod
    def _normalize_endpoint(url: str) -> str:
        normalized = url.rstrip("/")
        if normalized.endswith("/chat/completions"):
            return normalized
        if normalized.endswith("/v1"):
            return f"{normalized}/chat/completions"
        return f"{normalized}/v1/chat/completions"

    @staticmethod
    def _extract_json(content: str) -> dict:
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.DOTALL)
        try:
            parsed = json.loads(cleaned)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
            if not match:
                return {}
            try:
                parsed = json.loads(match.group(0))
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}

    async def review(self, item: KnowledgeItem, message_text: str, language: str) -> HermesDecision | None:
        if not self.enabled:
            return None
        system = (
            "You are a strict multilingual knowledge-base verifier. "
            "Accept only durable, concrete information that would be useful later in the group. "
            "Reject casual conversation, greetings, short plans, transient status updates, duplicate wording, "
            "unsupported guesses and generic named entities. Return JSON only."
        )
        user = {
            "language": language,
            "candidate": {
                "topicKey": item.topicKey,
                "content": item.content,
                "sourceMessageIds": item.sourceMessageIds,
            },
            "message": message_text[:2000],
            "allowedTopicKeys": ["travel", "technology", "radio", "shopping", "people", "places"],
            "responseSchema": {
                "decision": "accept|reject|review",
                "topicKey": "one allowed key or null",
                "confidence": "number 0..1",
                "reason": "short explanation",
            },
        }
        headers = {"content-type": "application/json"}
        if HERMES_API_KEY:
            headers["authorization"] = f"Bearer {HERMES_API_KEY}"
        try:
            async with httpx.AsyncClient(timeout=HERMES_TIMEOUT_SECONDS) as client:
                request_body = {
                    "model": HERMES_MODEL,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
                    ],
                    "response_format": {"type": "json_object"},
                }
                response = await client.post(self.endpoint, headers=headers, json=request_body)
                # Some OpenAI-compatible Hermes deployments do not expose
                # response_format; the strict JSON instruction remains active.
                if response.status_code == 400:
                    request_body.pop("response_format", None)
                    response = await client.post(self.endpoint, headers=headers, json=request_body)
                response.raise_for_status()
                payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            decision = HermesDecision.model_validate(self._extract_json(content))
            if decision.topicKey not in {"travel", "technology", "radio", "shopping", "people", "places", None}:
                decision.topicKey = None
            return decision
        except Exception:
            log.exception("Hermes knowledge verification failed; keeping deterministic result")
            return None


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
        "event", "fahren", "fahrt", "domingo", "dimanche", "reunion", "mañana", "hoy", "sábado", "domingo",
        "demà", "avui", "dissabte", "diumenge", "tomorrow", "today", "saturday", "sunday", "rendez-vous",
    ))


def starts_at(text: str) -> str | None:
    match = re.search(
        r"\b(morgen|heute|samstag|sonntag|domingo|dimanche|mañana|hoy|sábado|demà|avui|dissabte|diumenge|tomorrow|today|saturday|sunday)\b(?:\s+\w+){0,4}\s+(\d{1,2})(?::(\d{2}))?\s*(?:uhr|h|hrs?)?",
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


def heuristic_analysis(message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
    normalized = text.strip()
    keywords = ("morgen", "heute", "treffen", "termin", "event", "wichtig", "ort", "straße", "bahnhof", "meeting", "samstag", "sonntag", "costa", "montserrat", "mañana", "hoy", "reunión", "estación", "lugar", "demà", "avui", "trobem", "estació", "lloc", "tomorrow", "today", "saturday", "sunday", "meeting", "station", "place", "rendez-vous", "demain", "aujourd", "gare", "lieu")
    hits = sum(1 for word in keywords if word in normalized.lower())
    score = min(0.25 + hits * 0.12, 0.98)
    events = multi_message_events(message_id, context)
    if events:
        score = max(score, 0.78)
    media_signal = any(
        str(item.get("id")) == message_id and item.get("kind") in {"image", "video", "audio", "document", "location"}
        for item in context
    )
    if media_signal:
        score = max(score, 0.55)
    relevant = score >= 0.45 or bool(events) or media_signal
    facts = [Fact(text=normalized, confidence=0.64)] if normalized else []
    entities = []
    for match in re.finditer(r"\b[A-ZÄÖÜ][\wÄÖÜäöüß-]{2,}\b", normalized):
        candidate = match.group(0)
        # A capitalized first word or a normal German noun is not enough
        # evidence for a named entity.
        if match.start() == 0 or candidate.casefold() in {"bitte", "treffen", "morgen", "heute", "danke", "hallo"}:
            continue
        entities.append(Entity(name=candidate, type="mention", confidence=0.55))
    event = {}
    event_signal = any(word in normalized.lower() for word in ("morgen", "heute", "termin", "treffen", "mañana", "hoy", "reunión", "demà", "avui", "trobem", "tomorrow", "today", "meeting", "rendez-vous", "demain", "aujourd"))
    if event_signal:
        event = {"title": normalized[:120], "confidence": 0.58}
    current = next((item for item in context if str(item.get("id")) == message_id), {})
    location = location_details(current)
    place = {}
    if location:
        place = {"name": location["name"], "latitude": location["latitude"], "longitude": location["longitude"], "confidence": 0.9}
    elif any(word in normalized.lower() for word in ("ort", "bahnhof", "straße", "lugar", "estación", "lloc", "estació", "place", "station", "lieu", "gare", "restaurant", "office", "oficina", "bureau")):
        place = {"name": normalized[:80], "confidence": 0.45}
    provenance = [Provenance(field="summary", sourceMessageIds=[message_id], confidence=0.64)]
    if events:
        provenance.append(Provenance(field="events", sourceMessageIds=list(dict.fromkeys(source for event in events for source in event.sourceMessageIds)), confidence=max(event.confidence for event in events)))
    if place:
        provenance.append(Provenance(field="places", sourceMessageIds=[message_id], confidence=place["confidence"]))
    return Analysis(
        messageId=message_id,
        relevant=relevant,
        relevanceScore=round(score, 4),
        summary=normalized[:180] or "Leere Nachricht ohne Text",
        facts=facts,
        entities=entities[:10],
        events=events or ([Event(**event)] if event else []),
        places=[place] if place else [],
        knowledge=knowledge_items_for_message(message_id, normalized, context, entities, [place] if place else [], language),
        provenance=provenance,
        model=MODEL,
    )


def deduplicate_events(events: list[Event]) -> list[Event]:
    merged: dict[tuple[str, str | None, str | None], Event] = {}
    for event in events:
        key = (event.title.strip().lower(), event.startsAt, event.location.strip().lower() if event.location else None)
        if key not in merged:
            merged[key] = event
        else:
            merged[key].sourceMessageIds = list(dict.fromkeys(merged[key].sourceMessageIds + event.sourceMessageIds))
            merged[key].confidence = max(merged[key].confidence, event.confidence)
    return list(merged.values())


def find_conflicts(context: list[dict]) -> list[Conflict]:
	items = [item for item in context if item.get("id")]
	anchors = [item for item in items if is_event_anchor(str(item.get("text") or ""))]
	anchor_ids = {str(item.get("waMessageId")) for item in anchors if item.get("waMessageId")}

	def related(item: dict) -> bool:
		if item in anchors or location_details(item) is not None:
			return True
		target = reply_target(item)
		return bool(target and target in anchor_ids)

	scoped = [item for item in items if related(item)]
	if len(scoped) < 2:
		return []
	conflicts: list[Conflict] = []
	time_candidates = [(str(item["id"]), starts_at(str(item.get("text") or ""))) for item in scoped]
	time_values = {value for _, value in time_candidates if value}
	if len(time_values) > 1:
		ids = [item_id for item_id, value in time_candidates if value]
		conflicts.append(Conflict(
			field="startsAt",
			messageIds=ids,
			description=f"Widersprüchliche Terminzeiten: {', '.join(sorted(time_values))}.",
			confidence=0.82,
		))

	location_candidates: list[tuple[str, str]] = []
	for item in scoped:
		location = location_details(item)
		if not location:
			continue
		name = str(location.get("name") or location.get("label") or "").strip()
		latitude = location.get("latitude")
		longitude = location.get("longitude")
		key = f"{name.casefold()}|{latitude}|{longitude}"
		location_candidates.append((str(item["id"]), key))
	location_values = {value for _, value in location_candidates}
	if len(location_values) > 1:
		ids = [item_id for item_id, _ in location_candidates]
		labels = []
		for item in scoped:
			location = location_details(item)
			if location:
				label = str(location.get("label") or location.get("name") or "").strip()
				if label and label not in labels:
					labels.append(label)
		conflicts.append(Conflict(
			field="location",
			messageIds=ids,
			description=f"Widersprüchliche Ortsangaben: {', '.join(labels)}.",
			confidence=0.78,
		))
	return conflicts


KNOWLEDGE_TOPIC_RULES = {
    # A topic keyword alone is deliberately insufficient. Each topic also
    # needs a concrete detail, recommendation, transaction or explanation.
    "travel": {
        "keywords": ("reise", "reisen", "urlaub", "ausflug", "wanderung", "hotel", "flug", "playa", "viaje", "vacaciones", "excursión", "excursion", "voyage", "vacances", "randonnée", "viatge", "platja"),
        "detail": ("route", "ruta", "itiner", "strecke", "entfernung", "distanz", "kilometer", "km", "kosten", "preis", "öffnungs", "horario", "horaris", "unterkunft", "alojamiento", "hébergement", "fahrplan", "buchen", "buchung", "reserv", "empfehl", "recomend", "recoman", "recommend", "lohn", "besuchen"),
    },
    "technology": {
        "keywords": ("server", "api", "docker", "software", "cloud", "python", "javascript", "netzwerk", "network", "konfig", "version", "fehler", "error", "install", "technolog", "tecnolog", "telegram", "whatsapp"),
        "detail": ("problem", "lösung", "loesung", "deploy", "container", "port", "einstell", "update", "läuft", "funktioniert", "fehl", "log", "script", "code", "config", "repar", "verbund", "conect", "connect", "réseau"),
    },
    "radio": {
        "keywords": ("amateurfunk", "funk", "radio", "aprs", "dmr", "antenne", "antenna", "repeater", "meshcore", "lora", "hamnet", "c4fm", "frequenz", "frecuencia", "fréquence"),
        "detail": ("qrg", "kanal", "channel", "leistung", "reichweite", "signal", "db", "mhz", "khz", "watt", "konfig", "konfiguration", "standort", "modulation", "gateway", "digipeater", "netz", "antenne"),
    },
    "shopping": {
        "keywords": ("kauf", "kaufen", "verkauf", "verkaufen", "preis", "angebot", "bestell", "compra", "comprar", "venta", "precio", "acheter", "prix", "achat"),
        "detail": ("produkt", "modell", "link", "empfehl", "kosten", "liefer", "versand", "verfügbar", "disponible", "talla", "größe", "rabatt", "vergleich", "compar", "avis", "recomend"),
    },
    "people": {
        "keywords": ("kontakt", "verein", "firma", "organisation", "empresa", "contacto", "contact", "équipe", "team", "leiter", "vorstand", "responsable"),
        "detail": ("name", "nombre", "nom", "adresse", "email", "mail", "telefon", "tel", "rolle", "zuständig", "responsab", "bei", "von", "mit"),
    },
}

KNOWLEDGE_STOPWORDS = {
    *LANGUAGE_MARKERS["de"], *LANGUAGE_MARKERS["es"], *LANGUAGE_MARKERS["ca"],
    *LANGUAGE_MARKERS["en"], *LANGUAGE_MARKERS["fr"],
    "ich", "du", "wir", "ihr", "sie", "ein", "eine", "einer", "einem", "den", "dem",
}
ENTITY_RELATION_CUES = (
    "kontakt", "contact", "contacto", "name", "nombre", "nom", "firma", "empresa", "verein", "organisation",
    "team", "équipe", "leiter", "vorstand", "zuständig", "responsab", "empfehl", "recomend", "mit", "bei", "von",
)
PLACE_INFORMATION_CUES = (
    "adresse", "address", "dirección", "adreça", "treff", "meeting point", "restaurant", "hotel", "öffnungs", "horario",
    "empfehl", "recomend", "route", "ruta", "parkplatz", "parking", "lugar", "lloc", "ort", "location",
)


def has_term(text: str, term: str) -> bool:
    """Match a word or stem without matching it inside another word."""
    return re.search(rf"(?<!\w){re.escape(term.casefold())}\w*", text.casefold()) is not None


def term_hits(text: str, terms: tuple[str, ...]) -> int:
    return sum(1 for term in terms if has_term(text, term))


def is_informative_text(text: str) -> bool:
    words = re.findall(r"[\wÀ-ÿÄÖÜäöüß-]+", text.casefold())
    content_words = [word for word in words if len(word) >= 3 and word not in KNOWLEDGE_STOPWORDS]
    return len(text) >= 28 and len(content_words) >= 4


def location_is_repeated(location: dict, context: list[dict]) -> bool:
    name = str(location.get("name") or "").strip().casefold()
    latitude = location.get("latitude")
    longitude = location.get("longitude")
    if not name or name.startswith("telegram-ort:"):
        return False
    count = 0
    for item in context:
        other = location_details(item)
        if not other:
            continue
        same_name = name == str(other.get("name") or "").strip().casefold()
        same_coordinates = latitude is not None and longitude is not None and latitude == other.get("latitude") and longitude == other.get("longitude")
        if same_name or same_coordinates:
            count += 1
    return count >= 2


def knowledge_topic_is_supported(topic_key: str, text: str) -> tuple[bool, int, int]:
    if not is_informative_text(text):
        return False, 0, 0
    rule = KNOWLEDGE_TOPIC_RULES[topic_key]
    keyword_count = term_hits(text, rule["keywords"])
    detail_count = term_hits(text, rule["detail"])
    if topic_key in {"travel", "shopping", "people"}:
        supported = keyword_count >= 1 and detail_count >= 1
    else:
        supported = (keyword_count >= 2) or (keyword_count >= 1 and detail_count >= 1)
    return supported, keyword_count, detail_count


def knowledge_items_for_message(message_id: str, text: str, context: list[dict], entities: list[Entity], places: list[dict], language: str = "de") -> list[KnowledgeItem]:
    normalized = " ".join(text.split()).strip()
    if not normalized or not is_informative_text(normalized):
        return []
    matched: list[tuple[str, int, int]] = []
    for topic_key in KNOWLEDGE_TOPIC_RULES:
        supported, keyword_count, detail_count = knowledge_topic_is_supported(topic_key, normalized)
        if supported:
            matched.append((topic_key, keyword_count, detail_count))

    current = next((item for item in context if str(item.get("id")) == str(message_id)), {})
    current_location = location_details(current)
    if current_location and (location_is_repeated(current_location, context) or term_hits(normalized, PLACE_INFORMATION_CUES) >= 1):
        matched.append(("places", 1, 1))

    result: list[KnowledgeItem] = []
    for topic_key, keyword_count, detail_count in matched:
        topic_title = localized_topic_title(topic_key, language)
        rule = KNOWLEDGE_TOPIC_RULES.get(topic_key)
        related_ids = [str(message_id)]
        if rule:
            related_ids.extend(
                str(item.get("id")) for item in context
                if item.get("id") and str(item.get("id")) != str(message_id)
                and term_hits(str(item.get("text") or ""), rule["keywords"]) >= 1
                and is_informative_text(" ".join(str(item.get("text") or "").split()))
            )
        source_ids = list(dict.fromkeys([message_id, *related_ids]))[:12]
        item_key = re.sub(r"[^a-z0-9äöüß]+", "-", normalized.casefold(), flags=re.IGNORECASE).strip("-")[:180] or message_id
        confidence = min(0.96, 0.7 + 0.04 * min(keyword_count, 3) + 0.04 * min(detail_count, 3) + 0.04 * min(len(source_ids) - 1, 3))
        if topic_key in {"places", "entities"}:
            confidence = min(0.96, confidence + 0.04)
        result.append(KnowledgeItem(
            topicKey=topic_key,
            topicTitle=topic_title,
            itemKey=item_key,
            itemType="insight" if len(source_ids) > 1 else "fact",
            content=normalized,
            confidence=round(confidence, 4),
            sourceMessageIds=source_ids,
        ))
    return result


SEMANTIC_TOPIC_DESCRIPTIONS = {
    "travel": "durable travel information: trip planning, route, accommodation, opening hours, travel recommendation or cost",
    "technology": "durable technical information: software, server, configuration, error, deployment, network or API explanation",
    "radio": "durable amateur radio information: radio equipment, antenna, frequency, repeater, APRS, signal or network configuration",
    "shopping": "durable purchase information: product, model, price, availability, delivery or recommendation",
    "people": "durable contact information: person, organization, role, address, email or responsible contact",
    "places": "durable place information: named venue, address, location details, opening hours or meeting place",
}


def vector_to_pg(vector: list[float] | None) -> str | None:
    if vector is None:
        return None
    return "[" + ",".join(f"{value:.8f}" for value in vector) + "]"


async def semantic_topic_match(encoder: EmbeddingProvider, text: str) -> tuple[str, float] | None:
    vector = await encoder.embed(text)
    if vector is None:
        return None
    best: tuple[str, float] | None = None
    for topic_key, description in SEMANTIC_TOPIC_DESCRIPTIONS.items():
        prototype = await encoder.embed(description)
        if prototype is None:
            continue
        similarity = sum(left * right for left, right in zip(vector, prototype))
        if best is None or similarity > best[1]:
            best = (topic_key, similarity)
    return best


async def semantic_enrich_knowledge(db, encoder: EmbeddingProvider, group_id: str | None, message_id: str, text: str, language: str, items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    normalized = " ".join(text.split()).strip()
    if not group_id or not is_informative_text(normalized):
        return items
    vector = await encoder.embed(normalized)
    if vector is None:
        return items

    existing = await db.fetchrow(
        """SELECT kt.topic_key, kt.title, (ki.embedding <=> $2::vector) AS distance
           FROM knowledge_items ki JOIN knowledge_topics kt ON kt.id=ki.topic_id
           WHERE kt.group_id=$1 AND ki.parent_item_id IS NULL AND ki.embedding IS NOT NULL
           ORDER BY ki.embedding <=> $2::vector LIMIT 1""",
        group_id, vector_to_pg(vector),
    )
    topic_key = None
    score = 0.0
    if existing and float(existing["distance"]) <= SEMANTIC_MERGE_THRESHOLD:
        topic_key = str(existing["topic_key"])
        score = 1.0 - float(existing["distance"])
    else:
        prototype = await semantic_topic_match(encoder, normalized)
        if prototype and prototype[1] >= SEMANTIC_DISCOVERY_THRESHOLD:
            topic_key, score = prototype

    if not topic_key or any(item.topicKey == topic_key for item in items):
        return items
    return [
        *items,
        KnowledgeItem(
            topicKey=topic_key,
            topicTitle=localized_topic_title(topic_key, language),
            itemKey=re.sub(r"[^a-z0-9äöüß]+", "-", normalized.casefold(), flags=re.IGNORECASE).strip("-")[:180] or message_id,
            itemType="insight" if existing else "fact",
            content=normalized,
            confidence=round(min(0.95, max(0.78, score)), 4),
            sourceMessageIds=[message_id],
        ),
    ]


async def verify_knowledge_items(reviewer: HermesReviewer, text: str, language: str, items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    if not reviewer.enabled:
        return items
    verified: list[KnowledgeItem] = []
    for item in items:
        if not HERMES_REVIEW_ALL and item.confidence >= 0.9:
            verified.append(item)
            continue
        decision = await reviewer.review(item, text, language)
        # A network or provider failure must not stop ingestion. Only a valid
        # explicit rejection removes a deterministic candidate.
        if decision is None:
            verified.append(item)
            continue
        if decision.decision == "reject" or (decision.decision != "accept" and decision.confidence < HERMES_MIN_CONFIDENCE):
            continue
        if decision.topicKey in SEMANTIC_TOPIC_DESCRIPTIONS:
            item.topicKey = decision.topicKey
            item.topicTitle = localized_topic_title(decision.topicKey, language)
        item.confidence = round(max(item.confidence, decision.confidence), 4)
        verified.append(item)
    return verified


class AIAdapter:
    """Local adapter contract. External providers can implement this interface later."""

    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
        raise NotImplementedError


class HeuristicAdapter(AIAdapter):
    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
        return heuristic_analysis(message_id, text, context, language)


def build_adapter() -> AIAdapter:
    if AI_PROVIDER not in {"heuristic", "hybrid"}:
        log.warning("AI_PROVIDER=%s ist in dieser Beta lokal nicht aktiviert; benutze HeuristicAdapter", AI_PROVIDER)
    return HeuristicAdapter()


async def publish(js, subject: str, event_type: str, data: dict):
    event = {
        "id": os.urandom(16).hex(),
        "type": event_type,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "source": "ai-worker",
        "data": data,
    }
    await js.publish(subject, json.dumps(event, default=str).encode())


def source_id_list(value) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = []
    return [str(item) for item in value] if isinstance(value, list) else []


async def upsert_knowledge(db, group_id: str | None, items: list[KnowledgeItem], encoder: EmbeddingProvider | None = None):
    if not group_id or not items:
        return
    for item in items:
        embedding = await encoder.embed(item.content) if encoder else None
        embedding_pg = vector_to_pg(embedding)
        topic = await db.fetchrow(
            """INSERT INTO knowledge_topics (group_id, topic_key, title, summary, confidence, source_message_ids)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)
               ON CONFLICT (group_id, topic_key) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
               confidence=GREATEST(knowledge_topics.confidence, EXCLUDED.confidence),
               source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                                   FROM jsonb_array_elements(knowledge_topics.source_message_ids || EXCLUDED.source_message_ids) AS merged(value)),
               updated_at=NOW()
               RETURNING id""",
            group_id, item.topicKey, item.topicTitle, item.content, item.confidence, json.dumps(item.sourceMessageIds),
        )
        # Exact keys update the existing node. This is important when a
        # transcript or OCR result causes the same source message to be
        # analysed again: it must not create another child below the topic.
        exact_match = await db.fetchrow(
            """SELECT id, parent_item_id, item_role, content, item_type, confidence, source_message_ids
               FROM knowledge_items WHERE topic_id=$1 AND item_key=$2""",
            topic["id"], item.itemKey,
        )
        semantic_match = None
        if embedding_pg:
            semantic_match = await db.fetchrow(
                """SELECT id, item_key, content, item_type, source_message_ids, confidence
                   FROM knowledge_items
                   WHERE topic_id=$1 AND parent_item_id IS NULL AND embedding IS NOT NULL
                     AND (embedding <=> $2::vector) <= $3
                   ORDER BY embedding <=> $2::vector LIMIT 1""",
                topic["id"], embedding_pg, SEMANTIC_MERGE_THRESHOLD,
            )
        # A topic is itself a meaningful semantic boundary. If a new post is
        # clearly about the same classified topic but is not close enough to
        # the current summary vector, keep it as a child of the newest topic
        # summary instead of creating another flat entry.
        if not semantic_match:
            semantic_match = await db.fetchrow(
                """SELECT id, item_key, content, item_type, source_message_ids, confidence
                   FROM knowledge_items
                   WHERE topic_id=$1 AND parent_item_id IS NULL
                   ORDER BY updated_at DESC LIMIT 1""",
                topic["id"],
            )

        if exact_match:
            existing_sources = source_id_list(exact_match["source_message_ids"])
            merged_sources = list(dict.fromkeys([*existing_sources, *item.sourceMessageIds]))[:50]
            merged_content = max((str(exact_match["content"] or ""), item.content), key=len)
            merged_type = "insight" if len(merged_sources) > 1 else item.itemType
            await db.execute(
                """UPDATE knowledge_items
                   SET item_type=$1, content=$2, confidence=GREATEST(confidence, $3),
                       source_message_ids=$4::jsonb, embedding=COALESCE($5::vector, embedding),
                       item_role=CASE WHEN parent_item_id IS NULL THEN 'summary' ELSE 'detail' END,
                       updated_at=NOW()
                   WHERE id=$6""",
                merged_type, merged_content, item.confidence, json.dumps(merged_sources), embedding_pg, exact_match["id"],
            )
            if exact_match["parent_item_id"]:
                await db.execute(
                    """UPDATE knowledge_items
                       SET source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                           FROM jsonb_array_elements(source_message_ids || $1::jsonb) AS merged(value)),
                           updated_at=NOW()
                       WHERE id=$2""",
                    json.dumps(item.sourceMessageIds), exact_match["parent_item_id"],
                )
            continue

        if semantic_match:
            parent_sources = list(dict.fromkeys([*source_id_list(semantic_match["source_message_ids"]), *item.sourceMessageIds]))[:50]
            merged_content = max((str(semantic_match["content"] or ""), item.content), key=len)
            merged_type = "insight" if len(parent_sources) > 1 else str(semantic_match["item_type"] or item.itemType)
            await db.execute(
                """UPDATE knowledge_items
                   SET item_role='summary', item_type=$1, content=$2, confidence=GREATEST(confidence, $3),
                       source_message_ids=$4::jsonb, embedding=COALESCE($5::vector, embedding), updated_at=NOW()
                   WHERE id=$6""",
                merged_type, merged_content, item.confidence, json.dumps(parent_sources), embedding_pg, semantic_match["id"],
            )
            await db.execute(
                """INSERT INTO knowledge_items
                       (topic_id, item_key, item_type, content, confidence, source_message_ids,
                        embedding, parent_item_id, item_role)
                   VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::vector,$8,'detail')
                   ON CONFLICT (topic_id, item_key) DO UPDATE SET
                       item_type=EXCLUDED.item_type, content=EXCLUDED.content,
                       confidence=GREATEST(knowledge_items.confidence, EXCLUDED.confidence),
                       source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                           FROM jsonb_array_elements(knowledge_items.source_message_ids || EXCLUDED.source_message_ids) AS merged(value)),
                       embedding=COALESCE(EXCLUDED.embedding, knowledge_items.embedding),
                       parent_item_id=COALESCE(knowledge_items.parent_item_id, EXCLUDED.parent_item_id),
                       item_role=CASE WHEN COALESCE(knowledge_items.parent_item_id, EXCLUDED.parent_item_id) IS NULL THEN 'summary' ELSE 'detail' END,
                       updated_at=NOW()""",
                topic["id"], item.itemKey, item.itemType, item.content, item.confidence,
                json.dumps(item.sourceMessageIds), embedding_pg, semantic_match["id"],
            )
            continue
        await db.execute(
            """INSERT INTO knowledge_items
                   (topic_id, item_key, item_type, content, confidence, source_message_ids, embedding, item_role)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::vector,'summary')
               ON CONFLICT (topic_id, item_key) DO UPDATE SET item_type=EXCLUDED.item_type, content=EXCLUDED.content,
               confidence=GREATEST(knowledge_items.confidence, EXCLUDED.confidence),
               source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                                   FROM jsonb_array_elements(knowledge_items.source_message_ids || EXCLUDED.source_message_ids) AS merged(value)),
               embedding=COALESCE(EXCLUDED.embedding, knowledge_items.embedding), item_role='summary', updated_at=NOW()""",
            topic["id"], item.itemKey, item.itemType, item.content, item.confidence, json.dumps(item.sourceMessageIds), embedding_pg,
        )


async def resolve_group_language(db, group_id: str | None, context: list[dict], current_text: str) -> str:
    if not group_id:
        return "de"
    stored = await db.fetchval("SELECT language FROM wa_groups WHERE id=$1", group_id)
    if stored in SUPPORTED_GROUP_LANGUAGES:
        return stored
    detected = detect_group_language([current_text, *(str(item.get("text") or "") for item in context)])
    if detected:
        await db.execute("UPDATE wa_groups SET language=$1, updated_at=NOW() WHERE id=$2", detected, group_id)
        return detected
    return "de"


async def refresh_knowledge_topic_titles(db):
    topics = await db.fetch("SELECT kt.id, kt.topic_key, kt.group_id, g.language FROM knowledge_topics kt JOIN wa_groups g ON g.id=kt.group_id")
    if not topics:
        return
    languages: dict[str, str] = {}
    for topic in topics:
        group_id = str(topic["group_id"])
        if group_id not in languages:
            language = topic["language"]
            if language not in SUPPORTED_GROUP_LANGUAGES:
                rows = await db.fetch("SELECT text FROM messages WHERE group_id=$1 AND text IS NOT NULL ORDER BY received_at DESC LIMIT 100", group_id)
                language = detect_group_language([str(row["text"] or "") for row in rows])
                if language:
                    await db.execute("UPDATE wa_groups SET language=$1, updated_at=NOW() WHERE id=$2", language, group_id)
            languages[group_id] = language if language in SUPPORTED_GROUP_LANGUAGES else "de"
        title = localized_topic_title(str(topic["topic_key"]), languages[group_id])
        await db.execute("UPDATE knowledge_topics SET title=$1 WHERE id=$2 AND title IS DISTINCT FROM $1", title, topic["id"])


async def prepare_knowledge_rebuild(db) -> bool:
    current_version = await db.fetchval("SELECT detail FROM connector_states WHERE connector=$1", KNOWLEDGE_STATE_CONNECTOR)
    if current_version == KNOWLEDGE_REBUILD_VERSION:
        return False
    # The old heuristic created broad topics and item rows. Rebuilding from
    # source messages makes the stricter rules remove those stale entries too.
    await db.execute("DELETE FROM knowledge_topics")
    return True


async def mark_knowledge_rebuild_complete(db):
    await db.execute(
        """INSERT INTO connector_states (connector, status, detail, updated_at)
           VALUES ($1, 'ready', $2, NOW())
           ON CONFLICT (connector) DO UPDATE SET status='ready', detail=EXCLUDED.detail, last_error=NULL, updated_at=NOW()""",
        KNOWLEDGE_STATE_CONNECTOR, KNOWLEDGE_REBUILD_VERSION,
    )


AI_MAX_RETRIES = max(1, int(os.getenv("AI_MAX_RETRIES", "5")))
AI_STALE_PROCESSING_SECONDS = max(60, int(os.getenv("AI_STALE_PROCESSING_SECONDS", "900")))


async def claim_ai_job(db, message_id: str, force: bool = False) -> bool:
    await db.execute(
        """INSERT INTO ai_jobs (message_id, status, next_attempt_at)
           VALUES ($1,'queued',NOW())
           ON CONFLICT (message_id) DO UPDATE SET
             status=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN 'queued' ELSE ai_jobs.status END,
             next_attempt_at=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN NOW() ELSE ai_jobs.next_attempt_at END,
             error=CASE WHEN $2 THEN NULL ELSE ai_jobs.error END,
             updated_at=NOW()""",
        message_id, force,
    )
    row = await db.fetchrow(
        """UPDATE ai_jobs SET status='processing', attempts=attempts+1,
                 next_attempt_at=NULL, updated_at=NOW()
           WHERE message_id=$1 AND status='queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           RETURNING id""",
        message_id,
    )
    return bool(row)


async def complete_ai_job(db, message_id: str):
    await db.execute(
        "UPDATE ai_jobs SET status='completed', error=NULL, next_attempt_at=NULL, updated_at=NOW() WHERE message_id=$1",
        message_id,
    )


async def fail_ai_job(db, message_id: str, error: Exception):
    await db.execute(
        """UPDATE ai_jobs
           SET status=CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END,
               error=$3,
               next_attempt_at=CASE WHEN attempts < $2 THEN NOW() + INTERVAL '30 seconds' ELSE NULL END,
               updated_at=NOW()
           WHERE message_id=$1""",
        message_id, AI_MAX_RETRIES, str(error)[:4000],
    )


async def process_analysis(db, analyzer, payload: dict, trigger: str, force: bool = False):
    data = payload.get("data", payload)
    message_id = str(data.get("messageId") or "")
    if not message_id or not await claim_ai_job(db, message_id, force=force):
        return False
    try:
        await analyzer(payload)
        await complete_ai_job(db, message_id)
        return True
    except Exception as error:
        await fail_ai_job(db, message_id, error)
        raise


async def publish_ai_job(js, row):
    await publish(
        js, "wa.messages.received", "wa.messages.received",
        {"messageId": str(row["message_id"]), "groupId": row["group_id"], "text": row["text"] or "", "receivedAt": row["received_at"].isoformat(), "force": True},
    )


async def main():
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    adapter = build_adapter()
    encoder = EmbeddingProvider()
    hermes_reviewer = HermesReviewer()
    try:
        await js.stream_info("WAGI_EVENTS")
    except Exception:
        try:
            await js.add_stream(name="WAGI_EVENTS", subjects=["wa.>", "media.>", "ai.>", "connector.>", "replay.>"])
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
        group_language = await resolve_group_language(db, group_id, context, text)
        analysis = await adapter.analyze(message_id, text, context, group_language)
        analysis.events = deduplicate_events(analysis.events)
        analysis.conflicts = find_conflicts(context)
        if analysis.conflicts:
            analysis.provenance.append(Provenance(
                field="conflicts",
                sourceMessageIds=list(dict.fromkeys(source_id for conflict in analysis.conflicts for source_id in conflict.messageIds)),
                confidence=min(conflict.confidence for conflict in analysis.conflicts if conflict.confidence is not None),
            ))
        analysis.knowledge = await semantic_enrich_knowledge(db, encoder, group_id, message_id, text, group_language, analysis.knowledge)
        analysis.knowledge = await verify_knowledge_items(hermes_reviewer, text, group_language, analysis.knowledge)
        if analysis.knowledge and hermes_reviewer.enabled:
            analysis.provenance.append(Provenance(field="knowledge", sourceMessageIds=[message_id], confidence=max(item.confidence for item in analysis.knowledge)))
        serialized_analysis = analysis.model_dump(mode="json")
        await db.execute(
            """INSERT INTO message_analyses (message_id, relevant, relevance_score, summary, facts, entities, events, places, model, schema_version, prompt_version, provenance, conflicts)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb)
               ON CONFLICT (message_id) DO UPDATE SET relevant=EXCLUDED.relevant, relevance_score=EXCLUDED.relevance_score,
               summary=EXCLUDED.summary, facts=EXCLUDED.facts, entities=EXCLUDED.entities, events=EXCLUDED.events,
               places=EXCLUDED.places, model=EXCLUDED.model, schema_version=EXCLUDED.schema_version, prompt_version=EXCLUDED.prompt_version,
               provenance=EXCLUDED.provenance, conflicts=EXCLUDED.conflicts, updated_at=NOW()""",
            message_id, analysis.relevant, analysis.relevanceScore, analysis.summary,
            json.dumps(serialized_analysis["facts"]), json.dumps(serialized_analysis["entities"]),
            json.dumps(serialized_analysis["events"]), json.dumps(serialized_analysis["places"]), analysis.model,
            analysis.schemaVersion, analysis.promptVersion, json.dumps(serialized_analysis["provenance"]), json.dumps(serialized_analysis["conflicts"]),
        )
        await upsert_knowledge(db, group_id, analysis.knowledge, encoder)
        await publish(js, "ai.messages.analyzed", "ai.messages.analyzed", serialized_analysis)

    async def on_message(message):
        payload = {}
        try:
            payload = json.loads(message.data)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.messages", event_id, message.subject, payload):
                await message.ack()
                return
            await process_analysis(db, analyze_message, payload, "message")
            await mark_processed(db, "ai.messages", event_id)
            await message.ack()
        except Exception as error:
            log.exception("failed to analyze message")
            await retry_or_dead_letter(db, js, message, payload, "ai.messages", error)

    async def on_transcript(message):
        payload = {}
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.transcripts", event_id, message.subject, payload):
                await message.ack()
                return
            await db.execute("UPDATE audio_jobs SET status='completed', transcript=$1, language=$2, confidence=$3, updated_at=NOW() WHERE id=$4", data.get("transcript", ""), data.get("language"), data.get("confidence"), data.get("jobId"))
            await process_analysis(db, analyze_message, {"data": {"messageId": data.get("messageId"), "text": data.get("transcript", ""), "force": True}}, "transcript", force=True)
            await mark_processed(db, "ai.transcripts", event_id)
            await message.ack()
        except Exception as error:
            log.exception("failed to consume transcript")
            await retry_or_dead_letter(db, js, message, payload, "ai.transcripts", error)

    async def on_image(message):
        payload = {}
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.images", event_id, message.subject, payload):
                await message.ack()
                return
            current = await db.fetchval("SELECT COALESCE(text, '') FROM messages WHERE id=$1", data.get("messageId"))
            ocr = data.get("ocrText") or ""
            await process_analysis(db, analyze_message, {"data": {"messageId": data.get("messageId"), "text": f"{current or ''}\n[OCR] {ocr}".strip(), "force": True}}, "image", force=True)
            await mark_processed(db, "ai.images", event_id)
            await message.ack()
        except Exception as error:
            log.exception("failed to consume image analysis")
            await retry_or_dead_letter(db, js, message, payload, "ai.images", error)

    async def on_document(message):
        payload = {}
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.documents", event_id, message.subject, payload):
                await message.ack()
                return
            current = await db.fetchval("SELECT COALESCE(text, '') FROM messages WHERE id=$1", data.get("messageId"))
            extracted = data.get("text") or data.get("ocrText") or ""
            await process_analysis(db, analyze_message, {"data": {"messageId": data.get("messageId"), "text": f"{current or ''}\n[Dokument] {extracted}".strip(), "force": True}}, "document", force=True)
            await mark_processed(db, "ai.documents", event_id)
            await message.ack()
        except Exception as error:
            log.exception("failed to consume document analysis")
            await retry_or_dead_letter(db, js, message, payload, "ai.documents", error)

    async def on_replay(message):
        payload = {}
        replay_id = None
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            replay_id = str(data["replayId"])
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.replays", event_id, message.subject, payload):
                await message.ack()
                return
            group_ids = [str(value) for value in data.get("groupIds", [])]
            from_at = data["fromAt"]
            to_at = data["toAt"]
            await db.execute("UPDATE replay_jobs SET status='running', started_at=COALESCE(started_at,NOW()), updated_at=NOW() WHERE id=$1::uuid", replay_id)
            rows = await db.fetch(
                """SELECT m.id::text AS \"messageId\", m.group_id AS \"groupId\", COALESCE(m.text,'') AS text,
                          m.received_at AS \"receivedAt\", m.kind, m.media_key AS \"mediaKey\", m.media_mime AS \"mediaMime\",
                          mo.object_path AS \"objectPath\", aj.id::text AS \"jobId\"
                   FROM messages m
                   LEFT JOIN LATERAL (SELECT object_path FROM media_objects WHERE message_id=m.id AND status='completed' ORDER BY updated_at DESC LIMIT 1) mo ON TRUE
                   LEFT JOIN LATERAL (SELECT id FROM audio_jobs WHERE message_id=m.id ORDER BY updated_at DESC LIMIT 1) aj ON TRUE
                   WHERE m.group_id = ANY($1::text[]) AND m.received_at >= $2::timestamptz AND m.received_at < $3::timestamptz
                   ORDER BY m.received_at ASC""",
                group_ids, from_at, to_at,
            )
            await db.execute("UPDATE replay_jobs SET total_count=$2, updated_at=NOW() WHERE id=$1::uuid", replay_id, len(rows))
            processed = 0
            failed = 0
            for row in rows:
                try:
                    await process_analysis(db, analyze_message, {"data": {"messageId": row["messageId"], "groupId": row["groupId"], "text": row["text"], "force": True}}, "replay", force=True)
                    if data.get("includeMedia") and row["objectPath"]:
                        subject = "media.audio.requested" if row["kind"] == "audio" else "media.objects.requested"
                        event_data = {"messageId": row["messageId"], "mediaKey": row["mediaKey"], "mediaMime": row["mediaMime"], "objectPath": row["objectPath"]}
                        if row["kind"] == "audio":
                            event_data["jobId"] = row["jobId"]
                            if row["jobId"]:
                                await db.execute("UPDATE audio_jobs SET status='queued', attempts=0, transcript=NULL, language=NULL, confidence=NULL, error=NULL, next_attempt_at=NOW(), updated_at=NOW() WHERE id=$1", row["jobId"])
                        await publish(js, subject, subject, event_data)
                    processed += 1
                except Exception:
                    failed += 1
                    log.exception("replay item failed: %s", row["messageId"])
                await db.execute("UPDATE replay_jobs SET processed_count=$2, failed_count=$3, updated_at=NOW() WHERE id=$1::uuid", replay_id, processed, failed)
            await db.execute("UPDATE replay_jobs SET status=CASE WHEN failed_count > 0 AND processed_count=0 THEN 'failed' ELSE 'completed' END, completed_at=NOW(), updated_at=NOW() WHERE id=$1::uuid", replay_id)
            await mark_processed(db, "ai.replays", event_id)
            await message.ack()
        except Exception as error:
            log.exception("replay failed")
            if replay_id:
                await db.execute("UPDATE replay_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid", replay_id, str(error)[:4000])
            await retry_or_dead_letter(db, js, message, payload, "ai.replays", error)

    async def backfill_existing_knowledge(force: bool = False):
        if force:
            rows = await db.fetch(
                """SELECT m.id::text AS "messageId", m.group_id AS "groupId", COALESCE(m.text, '') AS text
                   FROM messages m JOIN wa_groups g ON g.id = m.group_id
                   WHERE g.is_selected = TRUE ORDER BY m.received_at ASC LIMIT 5000"""
            )
        else:
            rows = await db.fetch(
                """SELECT m.id::text AS "messageId", m.group_id AS "groupId", COALESCE(m.text, '') AS text
                   FROM messages m JOIN wa_groups g ON g.id = m.group_id
                   LEFT JOIN message_analyses a ON a.message_id = m.id
                   WHERE g.is_selected = TRUE AND m.kind IN ('image', 'video', 'audio', 'document', 'location')
                     AND COALESCE(a.relevant, FALSE) = FALSE
                   ORDER BY m.received_at ASC LIMIT 1000"""
            )
        if not rows:
            return
        log.info("backfilling knowledge base for %d existing selected messages", len(rows))
        for row in rows:
            await process_analysis(db, analyze_message, {"data": dict(row)}, "startup-backfill", force=force)

    async def recover_ai_jobs():
        """Requeue stale AI work and publish queued jobs after a restart."""
        while True:
            try:
                await db.execute(
                    """UPDATE ai_jobs
                       SET status=CASE WHEN attempts < $1 THEN 'queued' ELSE 'failed' END,
                           error=COALESCE(error, 'AI worker restarted while processing'),
                           next_attempt_at=CASE WHEN attempts < $1 THEN NOW() ELSE NULL END,
                           updated_at=NOW()
                       WHERE status='processing' AND updated_at < NOW() - ($2 * INTERVAL '1 second')""",
                    AI_MAX_RETRIES, AI_STALE_PROCESSING_SECONDS,
                )
                rows = await db.fetch(
                    """SELECT aj.id::text, aj.message_id::text, m.group_id, COALESCE(m.text,'') AS text, m.received_at
                       FROM ai_jobs aj JOIN messages m ON m.id=aj.message_id
                       WHERE aj.status='queued' AND (aj.next_attempt_at IS NULL OR aj.next_attempt_at <= NOW())
                       ORDER BY COALESCE(aj.next_attempt_at, aj.created_at), aj.created_at LIMIT 20"""
                )
                for row in rows:
                    claimed = await db.execute(
                        """UPDATE ai_jobs SET next_attempt_at=NOW()+INTERVAL '2 minutes', updated_at=NOW()
                           WHERE id=$1 AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())""",
                        row["id"],
                    )
                    if claimed == "UPDATE 1":
                        await publish_ai_job(js, row)
            except Exception:
                log.exception("AI recovery scheduler failed")
            await asyncio.sleep(5)

    knowledge_rebuild_required = await prepare_knowledge_rebuild(db)
    await refresh_knowledge_topic_titles(db)
    await backfill_existing_knowledge(force=knowledge_rebuild_required)
    if knowledge_rebuild_required:
        await mark_knowledge_rebuild_complete(db)
    await js.subscribe("wa.messages.received", durable="WAGI_AI_MESSAGES", stream="WAGI_EVENTS", cb=on_message)
    await js.subscribe("media.audio.transcribed", durable="WAGI_AI_TRANSCRIPTS", stream="WAGI_EVENTS", cb=on_transcript)
    await js.subscribe("media.image.analyzed", durable="WAGI_AI_IMAGES", stream="WAGI_EVENTS", cb=on_image)
    await js.subscribe("media.document.analyzed", durable="WAGI_AI_DOCUMENTS", stream="WAGI_EVENTS", cb=on_document)
    await js.subscribe("replay.requested", durable="WAGI_AI_REPLAY", stream="WAGI_EVENTS", cb=on_replay)
    asyncio.create_task(recover_ai_jobs())
    log.info("AI worker listening with durable consumers for messages, audio, images, documents and replay (provider=%s, prompt=%s)", AI_PROVIDER, PROMPT_VERSION)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
