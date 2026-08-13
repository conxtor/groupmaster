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
PROMPT_VERSION = os.getenv("AI_PROMPT_VERSION", "cascade-v4")
SCHEMA_VERSION = "1.2"
SUPPORTED_GROUP_LANGUAGES = ("de", "es", "ca", "en", "fr")
_HERMES_CONFIGURED = os.getenv("AI_HERMES_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
_CONFIGURED_KNOWLEDGE_VERSION = os.getenv("AI_KNOWLEDGE_VERSION", "cascade-v4")
KNOWLEDGE_REBUILD_VERSION = _CONFIGURED_KNOWLEDGE_VERSION + ("-hermes" if _HERMES_CONFIGURED and not _CONFIGURED_KNOWLEDGE_VERSION.endswith("-hermes") else "")
KNOWLEDGE_STATE_CONNECTOR = "ai-worker-knowledge"
EMBEDDING_DIMENSIONS = 384
EMBEDDINGS_ENABLED = os.getenv("AI_EMBEDDINGS_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
EMBEDDING_MODEL = os.getenv("AI_EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
EMBEDDING_CACHE_DIR = os.getenv("AI_EMBEDDING_CACHE_DIR", "/root/.cache/fastembed")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
# The default embedding model is public. If no explicit token is configured,
# avoid silently reusing an expired token from the Hugging Face cache.
if not HF_TOKEN:
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
HF_MODEL_LOAD_INTERVAL_SECONDS = max(3600.0, float(os.getenv("AI_HF_MODEL_LOAD_INTERVAL_SECONDS", "86400")))
SEMANTIC_DISCOVERY_THRESHOLD = float(os.getenv("AI_SEMANTIC_DISCOVERY_THRESHOLD", "0.84"))
SEMANTIC_MERGE_THRESHOLD = float(os.getenv("AI_SEMANTIC_MERGE_THRESHOLD", "0.18"))
HERMES_ENABLED = _HERMES_CONFIGURED
HERMES_URL = os.getenv("AI_HERMES_URL", "").strip() or os.getenv("AI_ENDPOINT", "").strip()
HERMES_API_KEY = os.getenv("AI_HERMES_API_KEY", "").strip() or os.getenv("AI_API_KEY", "").strip()
HERMES_MODEL = os.getenv("AI_HERMES_MODEL", "hermes-agent").strip()
HERMES_TIMEOUT_SECONDS = max(5.0, float(os.getenv("AI_HERMES_TIMEOUT_MS", "60000")) / 1000)
HERMES_CONNECT_TIMEOUT_SECONDS = max(2.0, float(os.getenv("AI_HERMES_CONNECT_TIMEOUT_MS", "10000")) / 1000)
HERMES_RETRY_ATTEMPTS = max(1, min(5, int(os.getenv("AI_HERMES_RETRY_ATTEMPTS", "3"))))
HERMES_RETRY_BASE_SECONDS = max(0.1, float(os.getenv("AI_HERMES_RETRY_BASE_MS", "1500")) / 1000)
HERMES_RETRY_MAX_SECONDS = max(HERMES_RETRY_BASE_SECONDS, float(os.getenv("AI_HERMES_RETRY_MAX_MS", "10000")) / 1000)
HERMES_FAILURE_COOLDOWN_SECONDS = max(0.0, float(os.getenv("AI_HERMES_FAILURE_COOLDOWN_SECONDS", "60")))
HERMES_REVIEW_ALL = os.getenv("AI_HERMES_REVIEW_ALL", "false").lower() in {"1", "true", "yes", "on"}
HERMES_MIN_CONFIDENCE = float(os.getenv("AI_HERMES_MIN_CONFIDENCE", "0.78"))
AI_CONTEXT_MAX_MESSAGES = max(20, int(os.getenv("AI_CONTEXT_MAX_MESSAGES", "80")))
AI_EVENT_WINDOW_HOURS = max(2.0, float(os.getenv("AI_EVENT_WINDOW_HOURS", "36")))
AI_EVENT_MIN_CONFIDENCE = min(0.99, max(0.4, float(os.getenv("AI_EVENT_MIN_CONFIDENCE", "0.7"))))
AI_DOCUMENT_ANALYSIS_MAX_CHARS = max(2000, int(os.getenv("AI_DOCUMENT_ANALYSIS_MAX_CHARS", "12000")))
AI_NATS_PAYLOAD_LIMIT_BYTES = max(64 * 1024, min(900000, int(os.getenv("AI_NATS_PAYLOAD_LIMIT_BYTES", "900000"))))
# Automatic learning stays deliberately weaker than explicit user feedback.
# A message can add a small baseline signal, while already-known terms in the
# same group/language provide only a capped, weighted context bonus.
AI_LEARNING_INFERENCE_BASE_DELTA = max(0.0005, min(0.02, float(os.getenv("AI_LEARNING_INFERENCE_BASE_DELTA", "0.003"))))
AI_LEARNING_CONTEXT_BONUS = max(0.0, min(0.02, float(os.getenv("AI_LEARNING_CONTEXT_BONUS", "0.009"))))
AI_LEARNING_MAX_DELTA = max(AI_LEARNING_INFERENCE_BASE_DELTA, min(0.03, float(os.getenv("AI_LEARNING_MAX_DELTA", "0.015"))))
AI_LEARNING_MAX_TERMS_PER_SIGNAL = max(1, min(16, int(os.getenv("AI_LEARNING_MAX_TERMS_PER_SIGNAL", "8"))))

LANGUAGE_MARKERS = {
    # Keep language detection anchored to content-bearing terms. Function
    # words and conversational fillers are maintained in ai_learning_terms.
    "de": {"morgen", "heute", "treffen", "termin", "event", "wichtig", "ort", "straße"},
    "es": {"mañana", "hoy", "domingo", "viaje", "playa", "vamos"},
    "ca": {"demà", "avui", "diumenge", "viatge", "platja", "anem"},
    "en": {"tomorrow", "today", "meeting", "travel", "beach"},
    "fr": {"demain", "aujourd", "voyage", "plage", "rendez", "fait"},
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
    eventKey: str | None = None
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
    relevanceLevel: Literal["high", "medium", "low"]
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


class HermesEventDecision(BaseModel):
    decision: Literal["accept", "reject", "review"]
    event: Event | None = None
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
            except Exception as exc:
                # Keep the provider retryable, but never retry the Hub on
                # every incoming message. The next attempt is gated by the
                # configured interval above; inference errors remain
                # permanently disabled for this worker instance.
                error_text = str(exc)
                if any(marker in error_text.casefold() for marker in ("401", "unauthorized", "expired", "repository not found")):
                    log.error(
                        "could not download embedding model %s from Hugging Face: the configured HF_TOKEN is invalid or expired; "
                        "create a new read token or clear HF_TOKEN for the public model. Retrying after %.0f seconds",
                        EMBEDDING_MODEL,
                        HF_MODEL_LOAD_INTERVAL_SECONDS,
                        exc_info=True,
                    )
                else:
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
        self._failure_cooldown_until = 0.0
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

    @staticmethod
    def _retry_delay(attempt: int, response: httpx.Response | None = None) -> float:
        if response is not None:
            retry_after = response.headers.get("retry-after", "").strip()
            if retry_after:
                try:
                    return min(HERMES_RETRY_MAX_SECONDS, max(0.0, float(retry_after)))
                except ValueError:
                    pass
        return min(HERMES_RETRY_MAX_SECONDS, HERMES_RETRY_BASE_SECONDS * (2**attempt))

    async def _post_with_retry(self, client: httpx.AsyncClient, headers: dict, request_body: dict) -> httpx.Response:
        """Retry only transient Hermes failures; preserve client errors for validation/fallback."""
        for attempt in range(HERMES_RETRY_ATTEMPTS):
            try:
                response = await client.post(self.endpoint, headers=headers, json=request_body)
                transient_status = response.status_code in {408, 425, 429} or response.status_code >= 500
                if not transient_status or attempt + 1 >= HERMES_RETRY_ATTEMPTS:
                    return response
                delay = self._retry_delay(attempt, response)
                log.warning(
                    "Hermes returned HTTP %s; retrying in %.1fs (%d/%d)",
                    response.status_code,
                    delay,
                    attempt + 1,
                    HERMES_RETRY_ATTEMPTS - 1,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt + 1 >= HERMES_RETRY_ATTEMPTS:
                    raise
                delay = self._retry_delay(attempt)
                log.warning(
                    "Hermes request failed with %s; retrying in %.1fs (%d/%d)",
                    type(error).__name__,
                    delay,
                    attempt + 1,
                    HERMES_RETRY_ATTEMPTS - 1,
                )
            await asyncio.sleep(delay)
        raise RuntimeError("Hermes retry loop ended unexpectedly")

    async def review(self, item: KnowledgeItem, message_text: str, language: str) -> HermesDecision | None:
        if not self.enabled:
            return None
        if time.monotonic() < self._failure_cooldown_until:
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
            timeout = httpx.Timeout(HERMES_TIMEOUT_SECONDS, connect=HERMES_CONNECT_TIMEOUT_SECONDS)
            async with httpx.AsyncClient(timeout=timeout) as client:
                request_body = {
                    "model": HERMES_MODEL,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
                    ],
                    "response_format": {"type": "json_object"},
                }
                response = await self._post_with_retry(client, headers, request_body)
                # Some OpenAI-compatible Hermes deployments do not expose
                # response_format; the strict JSON instruction remains active.
                if response.status_code == 400:
                    request_body.pop("response_format", None)
                    response = await self._post_with_retry(client, headers, request_body)
                response.raise_for_status()
                payload = response.json()
            content = payload["choices"][0]["message"]["content"]
            decision = HermesDecision.model_validate(self._extract_json(content))
            if decision.topicKey not in {"travel", "technology", "radio", "shopping", "people", "places", None}:
                decision.topicKey = None
            self._failure_cooldown_until = 0.0
            return decision
        except Exception as error:
            self._failure_cooldown_until = time.monotonic() + HERMES_FAILURE_COOLDOWN_SECONDS
            log.warning(
                "Hermes knowledge verification failed after up to %d attempts; keeping deterministic result: %s: %s",
                HERMES_RETRY_ATTEMPTS,
                type(error).__name__,
                str(error)[:500],
            )
            log.debug("Hermes knowledge verification traceback", exc_info=True)
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


EVENT_ACTION_TERMS = (
    "treffen", "wanderung", "meeting", "termin", "event", "fahren", "fahrt", "ausflug", "reserv",
    "reunión", "reunion", "quedada", "viaje", "excursión", "excursion", "rendez-vous", "sortie",
    "trobem", "trobada", "viatge", "excursió", "meet", "gather", "go to", "let's go",
)
EVENT_TIME_TERMS = (
    "morgen", "heute", "samstag", "sonntag", "freitag", "montag", "dienstag", "mittwoch", "donnerstag",
    "mañana", "hoy", "sábado", "domingo", "demà", "avui", "dissabte", "diumenge", "tomorrow", "today",
    "saturday", "sunday", "demain", "aujourd", "samedi", "dimanche",
)
EVENT_CUE_TERMS = ("um", "uhr", "a las", "a la", "a les", "at", "às", "à", "gegen", "around", "vers")


def has_any_term(text: str, terms: tuple[str, ...]) -> bool:
    return any(has_term(text, term) for term in terms)


def explicit_time(text: str) -> str | None:
    match = re.search(r"(?:\b(?:um|a las|a la|a les|at|às|à|gegen|around|vers)\s+|\b)(\d{1,2})(?::(\d{2}))?\s*(?:uhr|h|hrs?|am|pm)?\b", text, flags=re.IGNORECASE)
    if not match:
        return None
    hour = int(match.group(1))
    if hour > 23:
        return None
    return f"{hour:02d}:{match.group(2) or '00'}"


def is_event_anchor(text: str, event_terms: list[str] | tuple[str, ...] | None = None) -> bool:
    normalized = " ".join(text.casefold().split())
    if not normalized or len(normalized) < 10:
        return False
    terms = event_terms or EVENT_ACTION_TERMS
    action = has_any_term(normalized, terms)
    temporal = has_any_term(normalized, EVENT_TIME_TERMS) or explicit_time(normalized) is not None
    return action and (temporal or has_any_term(normalized, EVENT_CUE_TERMS))


def starts_at(text: str) -> str | None:
    normalized = " ".join(text.split())
    weekday = re.search(
        r"\b(morgen|heute|samstag|sonntag|freitag|montag|dienstag|mittwoch|donnerstag|domingo|dimanche|mañana|hoy|sábado|demà|avui|dissabte|diumenge|tomorrow|today|saturday|sunday|demain|aujourd|samedi)\b",
        normalized,
        flags=re.IGNORECASE,
    )
    clock = explicit_time(normalized)
    if weekday and clock:
        return f"{weekday.group(1).capitalize()} {clock}"
    date = re.search(r"\b(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\b", normalized)
    if date and clock:
        return f"{date.group(1)} {clock}"
    return f"Zeit {clock}" if clock and has_any_term(normalized, EVENT_ACTION_TERMS) else None


def event_key_slug(value: str, limit: int = 64) -> str:
    value = re.sub(r"\b\d{1,2}(?::\d{2})?\b", " ", value.casefold())
    value = re.sub(r"\b(?:morgen|heute|mañana|hoy|demà|avui|tomorrow|today|demain|aujourd)\b", " ", value)
    value = re.sub(r"[^a-z0-9à-ÿäöüß]+", "-", value, flags=re.IGNORECASE).strip("-")
    return value[:limit].strip("-")


def stable_event_key(anchor_text: str, location: str | None) -> str:
    anchor = event_key_slug(anchor_text) or "event"
    place = event_key_slug(location or "")
    return f"{anchor}:{place}" if place else anchor


def event_evidence(item: dict, event_terms: list[str] | tuple[str, ...] | None = None) -> dict:
    text = str(item.get("text") or "")
    terms = event_terms or EVENT_ACTION_TERMS
    return {
        "action": has_any_term(text, terms),
        "temporal": has_any_term(text, EVENT_TIME_TERMS) or explicit_time(text) is not None or bool(re.search(r"\b\d{1,2}[./-]\d{1,2}\b", text)),
        "cue": has_any_term(text, EVENT_CUE_TERMS),
        "time": starts_at(text),
        "location": location_details(item),
    }


def item_time(item: dict) -> datetime | None:
    value = item.get("receivedAt")
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def within_event_window(left: dict, right: dict) -> bool:
    left_time = item_time(left)
    right_time = item_time(right)
    if not left_time or not right_time:
        return True
    return abs((left_time - right_time).total_seconds()) <= AI_EVENT_WINDOW_HOURS * 3600


def multi_message_events(message_id: str, context: list[dict], learning: dict | None = None) -> list[Event]:
    learned_event_terms = [term for term in (learning or {}).get("event", {}).keys() if term not in EVENT_TIME_TERMS and term not in EVENT_CUE_TERMS]
    event_terms = list(dict.fromkeys([*EVENT_ACTION_TERMS, *learned_event_terms]))
    ordered = sorted((item for item in context if item.get("id")), key=lambda item: item_time(item) or datetime.min.replace(tzinfo=timezone.utc))
    current = next((item for item in ordered if str(item.get("id")) == str(message_id)), None)
    if not current:
        return []
    anchors = [item for item in ordered if item.get("text") and is_event_anchor(str(item["text"]), event_terms)]
    candidates: list[Event] = []
    for anchor in anchors:
        evidence = event_evidence(anchor, event_terms)
        nearby = [item for item in ordered if within_event_window(anchor, item)]
        nearby_locations = [(item, location_details(item)) for item in nearby if location_details(item)]
        location_item, location = (None, None)
        if nearby_locations:
            location_item, location = min(nearby_locations, key=lambda pair: abs((ordered.index(pair[0]) - ordered.index(anchor))))
        related_ids = [str(anchor["id"])]
        if location_item:
            related_ids.append(str(location_item["id"]))
        anchor_refs = {str(anchor.get("waMessageId")), str(anchor.get("id"))}
        if location_item:
            anchor_refs.update({str(location_item.get("waMessageId")), str(location_item.get("id"))})
        for item in nearby:
            target = reply_target(item)
            if target and target in anchor_refs:
                related_ids.append(str(item["id"]))
            if item is not anchor and item.get("text") and event_evidence(item, event_terms)["time"] and within_event_window(anchor, item):
                related_ids.append(str(item["id"]))
        related_ids = list(dict.fromkeys(related_ids))
        current_related = str(current["id"]) in related_ids or str(reply_target(current)) in anchor_refs
        has_place = location is not None
        valid = bool(evidence["action"] and (evidence["temporal"] or (has_place and evidence["cue"])))
        if not valid or not current_related:
            continue
        support_time = evidence["time"] or next((event_evidence(item)["time"] for item in nearby if event_evidence(item)["time"]), None)
        confidence = 0.48
        confidence += 0.18 if evidence["action"] else 0
        confidence += 0.18 if evidence["temporal"] or support_time else 0
        confidence += 0.12 if has_place else 0
        confidence += 0.06 if len(related_ids) > 1 else 0
        confidence += 0.04 if any(reply_target(item) in anchor_refs for item in nearby) else 0
        if confidence < AI_EVENT_MIN_CONFIDENCE:
            continue
        anchor_text = " ".join(str(anchor["text"]).split())
        location_label = location["label"] if location else None
        title = f"{anchor_text[:140]} — {location_label}" if location_label else anchor_text[:140]
        candidates.append(Event(
            eventKey=stable_event_key(anchor_text, location_label),
            title=title,
            startsAt=support_time,
            location=location_label,
            confidence=round(min(0.98, confidence), 4),
            sourceMessageIds=related_ids,
        ))
    return candidates


def relevance_level_for_score(score: float) -> Literal["high", "medium", "low"]:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def heuristic_analysis(message_id: str, text: str, context: list[dict], language: str = "de", learning: dict | None = None) -> Analysis:
    normalized = text.strip()
    keywords = ("morgen", "heute", "treffen", "termin", "event", "wichtig", "ort", "straße", "bahnhof", "meeting", "samstag", "sonntag", "costa", "montserrat", "mañana", "hoy", "reunión", "estación", "lugar", "demà", "avui", "trobem", "estació", "lloc", "tomorrow", "today", "saturday", "sunday", "station", "place", "rendez-vous", "demain", "aujourd", "gare", "lieu")
    learned_relevance = learning_weight(learning, "relevance", normalized, keywords)
    score = min(0.18 + (learned_relevance if (learning or {}).get("relevance") else learned_relevance * 0.12), 0.98)
    events = multi_message_events(message_id, context, learning)
    if events:
        score = max(score, 0.78)
    media_signal = any(
        str(item.get("id")) == message_id and item.get("kind") in {"image", "video", "audio", "document", "location"}
        for item in context
    )
    if media_signal and normalized:
        score = max(score, 0.38)
    relevant = score >= 0.45 or bool(events) or (media_signal and bool(normalized))
    facts = [Fact(text=normalized, confidence=0.64)] if normalized else []
    entities = []
    for match in re.finditer(r"\b[A-ZÄÖÜ][\wÄÖÜäöüß-]{2,}\b", normalized):
        candidate = match.group(0)
        # A capitalized first word or a normal German noun is not enough
        # evidence for a named entity.
        if match.start() == 0 or candidate.casefold() in {"bitte", "treffen", "morgen", "heute", "danke", "hallo"}:
            continue
        entities.append(Entity(name=candidate, type="mention", confidence=0.55))
    current = next((item for item in context if str(item.get("id")) == message_id), {})
    location = location_details(current)
    place = {}
    if location:
        place = {"name": location["name"], "latitude": location["latitude"], "longitude": location["longitude"], "confidence": 0.9}
    elif any(has_term(normalized, word) for word in learning_terms_for(learning, "place", ("ort", "bahnhof", "straße", "lugar", "estación", "lloc", "estació", "place", "station", "lieu", "gare", "restaurant", "office", "oficina", "bureau"))):
        place = {"name": normalized[:80], "confidence": 0.45}
    provenance = [Provenance(field="summary", sourceMessageIds=[message_id], confidence=0.64)]
    if events:
        provenance.append(Provenance(field="events", sourceMessageIds=list(dict.fromkeys(source for event in events for source in event.sourceMessageIds)), confidence=max(event.confidence for event in events)))
    if place:
        provenance.append(Provenance(field="places", sourceMessageIds=[message_id], confidence=place["confidence"]))
    return Analysis(
        messageId=message_id,
        relevant=relevant,
        relevanceLevel=relevance_level_for_score(score),
        relevanceScore=round(score, 4),
        summary=normalized[:180] or "Leere Nachricht ohne Text",
        facts=facts,
        entities=entities[:10],
        events=events,
        places=[place] if place else [],
        knowledge=knowledge_items_for_message(message_id, normalized, context, entities, [place] if place else [], language, learning),
        provenance=provenance,
        model=MODEL,
    )


def deduplicate_events(events: list[Event]) -> list[Event]:
    merged: dict[str, Event] = {}
    for event in events:
        key = event.eventKey or stable_event_key(event.title, event.location)
        event.eventKey = key
        if key not in merged:
            merged[key] = event
        else:
            existing = merged[key]
            merged[key].sourceMessageIds = list(dict.fromkeys(merged[key].sourceMessageIds + event.sourceMessageIds))
            merged[key].confidence = max(merged[key].confidence, event.confidence)
            if event.startsAt and not existing.startsAt:
                existing.startsAt = event.startsAt
            if event.location and not existing.location:
                existing.location = event.location
            if len(event.title) > len(existing.title):
                existing.title = event.title
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
        "detail": ("name", "nombre", "nom", "adresse", "email", "mail", "telefon", "tel", "rolle", "zuständig", "responsab"),
    },
}

PLACE_INFORMATION_CUES = (
    "adresse", "address", "dirección", "adreça", "treff", "meeting point", "restaurant", "hotel", "öffnungs", "horario",
    "empfehl", "recomend", "route", "ruta", "parkplatz", "parking", "lugar", "lloc", "ort", "location",
)


def has_term(text: str, term: str) -> bool:
    """Match a word or stem without matching it inside another word."""
    return re.search(rf"(?<!\w){re.escape(term.casefold())}\w*", text.casefold()) is not None


def term_hits(text: str, terms: tuple[str, ...]) -> int:
    return sum(1 for term in terms if has_term(text, term))


def learning_terms_for(learning: dict | None, category: str, fallback: tuple[str, ...] = ()) -> list[str]:
    values = (learning or {}).get(category, {})
    if isinstance(values, dict):
        terms = list(values.keys())
    elif isinstance(values, (list, tuple, set)):
        terms = [str(value) for value in values]
    else:
        terms = []
    return terms or list(fallback)


def learning_weight(learning: dict | None, category: str, text: str, fallback: tuple[str, ...] = ()) -> float:
    values = (learning or {}).get(category, {})
    if values:
        return sum(float(weight) for term, weight in values.items() if has_term(text, term))
    return float(term_hits(text, fallback))


def learning_context_evidence(learning: dict | None, category: str, text: str, topic_key: str | None = None) -> float:
    """Return conservative evidence from already-known terms in this text.

    Relevance weights use a smaller normalization range because the seeded
    terms are around 0.12 and explicit feedback is around 0.30. Event/place
    weights use 1.0 as the strong system-term reference. Keyword evidence is
    intentionally based on the number of matching terms, not raw weights,
    because keyword terms are scoped to a topic.
    """
    if not learning:
        return 0.0
    if category == "keyword":
        topic = (learning.get("keyword") or {}).get(topic_key or "", {})
        known = [*topic.get("keywords", []), *topic.get("detail", [])]
        hits = term_hits(text, tuple(str(term) for term in known))
        return min(1.0, hits * 0.45)

    values = learning.get(category) or {}
    if not isinstance(values, dict):
        return 0.0
    matches = [float(weight) for term, weight in values.items() if has_term(text, str(term))]
    if not matches:
        return 0.0
    positive = sum(max(weight, 0.0) for weight in matches)
    negative = sum(max(-weight, 0.0) for weight in matches)
    if category == "relevance":
        evidence = min(1.0, positive / 0.24)
        # Negative feedback suppresses inheritance without making one
        # negative term erase all independent evidence.
        evidence *= max(0.0, 1.0 - min(1.0, negative / 0.30) * 0.75)
        return evidence
    return min(1.0, positive)


def learning_known_terms(learning: dict | None, category: str, topic_key: str | None = None) -> set[str]:
    if not learning:
        return set()
    if category == "keyword":
        topic = (learning.get("keyword") or {}).get(topic_key or "", {})
        return {str(term).casefold() for term in [*topic.get("keywords", []), *topic.get("detail", [])]}
    values = learning.get(category) or {}
    if isinstance(values, dict):
        return {str(term).casefold() for term in values}
    if isinstance(values, (list, tuple, set)):
        return {str(term).casefold() for term in values}
    return set()


def is_informative_text(text: str, stopwords: set[str] | None = None) -> bool:
    words = re.findall(r"[\wÀ-ÿÄÖÜäöüß-]+", text.casefold())
    content_words = [word for word in words if len(word) >= 3 and word not in (stopwords or set())]
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


def knowledge_topic_is_supported(topic_key: str, text: str, learning: dict | None = None) -> tuple[bool, int, int]:
    stopwords = set(learning_terms_for(learning, "exclusion"))
    if not is_informative_text(text, stopwords):
        return False, 0, 0
    rule = KNOWLEDGE_TOPIC_RULES[topic_key]
    learned_rules = (learning or {}).get("keyword", {})
    keyword_terms = learned_rules.get(topic_key, {}).get("keywords") or list(rule["keywords"])
    detail_terms = learned_rules.get(topic_key, {}).get("detail") or list(rule["detail"])
    keyword_count = term_hits(text, tuple(keyword_terms))
    detail_count = term_hits(text, tuple(detail_terms))
    if topic_key in {"travel", "shopping", "people"}:
        supported = keyword_count >= 1 and detail_count >= 1
    else:
        supported = (keyword_count >= 2) or (keyword_count >= 1 and detail_count >= 1)
    return supported, keyword_count, detail_count


def stable_knowledge_item_key(topic_key: str, text: str, entities: list[Entity], places: list[dict], message_id: str, stopwords: set[str] | None = None) -> str:
    named = [entity.name for entity in entities[:3]]
    named.extend(str(place.get("name") or "") for place in places[:2])
    source = " ".join(named) or text
    words = [word for word in re.findall(r"[\wÀ-ÿÄÖÜäöüß-]+", source.casefold()) if word not in (stopwords or set()) and len(word) >= 3]
    slug = re.sub(r"[^a-z0-9äöüß]+", "-", "-".join(words[:10]), flags=re.IGNORECASE).strip("-")
    return f"{topic_key}:{slug[:120]}" if slug else f"{topic_key}:{message_id}"


def knowledge_items_for_message(message_id: str, text: str, context: list[dict], entities: list[Entity], places: list[dict], language: str = "de", learning: dict | None = None) -> list[KnowledgeItem]:
    normalized = " ".join(text.split()).strip()
    stopwords = set(learning_terms_for(learning, "exclusion"))
    if not normalized or not is_informative_text(normalized, stopwords):
        return []
    matched: list[tuple[str, int, int]] = []
    for topic_key in KNOWLEDGE_TOPIC_RULES:
        supported, keyword_count, detail_count = knowledge_topic_is_supported(topic_key, normalized, learning)
        if supported:
            matched.append((topic_key, keyword_count, detail_count))

    current = next((item for item in context if str(item.get("id")) == str(message_id)), {})
    current_location = location_details(current)
    place_terms = learning_terms_for(learning, "place", PLACE_INFORMATION_CUES)
    if current_location and (location_is_repeated(current_location, context) or term_hits(normalized, tuple(place_terms)) >= 1):
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
                and term_hits(str(item.get("text") or ""), tuple(((learning or {}).get("keyword", {}).get(topic_key, {}).get("keywords") or list(rule["keywords"])))) >= 1
                and is_informative_text(" ".join(str(item.get("text") or "").split()), stopwords)
            )
        source_ids = list(dict.fromkeys([message_id, *related_ids]))[:12]
        item_key = stable_knowledge_item_key(topic_key, normalized, entities, places, message_id, stopwords)
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
    try:
        aliases = await db.fetch(
            "SELECT alias, canonical_key, topic_key FROM ai_canonical_aliases WHERE group_id=$1 ORDER BY updated_at DESC",
            group_id,
        )
    except Exception:
        aliases = []
    canonical_items = list(items)
    for alias_row in aliases:
        alias = str(alias_row["alias"] or "").strip()
        topic_key = str(alias_row["topic_key"] or "").strip()
        canonical_key = str(alias_row["canonical_key"] or "").strip()
        if not alias or not canonical_key or topic_key not in SEMANTIC_TOPIC_DESCRIPTIONS:
            continue
        if has_term(normalized, alias) and not any(item.topicKey == topic_key and item.itemKey == f"canonical:{canonical_key}" for item in canonical_items):
            canonical_items.append(KnowledgeItem(
                topicKey=topic_key,
                topicTitle=localized_topic_title(topic_key, language),
                itemKey=f"canonical:{canonical_key}",
                itemType="entity" if topic_key in {"people", "places"} else "insight",
                content=f"{canonical_key}: {normalized}",
                confidence=0.9,
                sourceMessageIds=[message_id],
            ))
    items = canonical_items
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
            itemKey=stable_knowledge_item_key(topic_key, normalized, [], [], message_id),
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


async def load_ai_feedback(db, group_id: str | None, message_id: str) -> list[dict]:
    if not group_id:
        return []
    try:
        rows = await db.fetch(
            """SELECT target_type, target_key, decision, correction, note
               FROM ai_feedback
               WHERE group_id=$1 AND message_id=$2::uuid
               ORDER BY created_at ASC""",
            group_id, message_id,
        )
    except Exception:
        # Allows a worker to start during a rolling deployment before the
        # optional feedback migration has been applied.
        return []
    result = []
    for row in rows:
        correction = row["correction"]
        if isinstance(correction, str):
            try:
                correction = json.loads(correction)
            except json.JSONDecodeError:
                correction = {}
        result.append({
            "targetType": str(row["target_type"]),
            "targetKey": str(row["target_key"]),
            "decision": str(row["decision"]),
            "correction": correction if isinstance(correction, dict) else {},
            "note": str(row["note"] or ""),
        })
    return result


def feedback_target_matches(target_key: str, *values: str | None) -> bool:
    normalized = target_key.casefold().strip()
    return normalized in {str(value).casefold().strip() for value in values if value}


def apply_feedback_overrides(analysis: Analysis, feedback: list[dict], language: str) -> tuple[Analysis, set[str]]:
    rejected_knowledge: set[str] = set()
    for item in feedback:
        target_type = item["targetType"]
        target_key = item["targetKey"]
        decision = item["decision"]
        correction = item["correction"]
        if target_type == "relevance" and feedback_target_matches(target_key, analysis.messageId, "message", "*"):
            level = str(correction.get("relevanceLevel") or "").casefold()
            if decision == "reject" or level == "low" or correction.get("relevant") is False:
                analysis.relevant = False
                analysis.relevanceScore = min(analysis.relevanceScore, 0.2)
                analysis.relevanceLevel = "low"
            elif decision in {"accept", "correct"}:
                if level == "medium":
                    analysis.relevant = True
                    analysis.relevanceScore = max(analysis.relevanceScore, 0.60)
                    analysis.relevanceLevel = "medium"
                else:
                    analysis.relevant = True
                    analysis.relevanceScore = max(analysis.relevanceScore, float(correction.get("relevanceScore") or 0.85))
                    analysis.relevanceLevel = "high"
        elif target_type == "event":
            next_events: list[Event] = []
            for event in analysis.events:
                matches = feedback_target_matches(target_key, event.eventKey, event.title, analysis.messageId) or target_key in event.sourceMessageIds
                if not matches:
                    next_events.append(event)
                    continue
                if decision == "reject":
                    continue
                if decision == "correct" and isinstance(correction.get("event"), dict):
                    corrected = dict(correction["event"])
                    corrected.setdefault("eventKey", event.eventKey)
                    corrected.setdefault("sourceMessageIds", event.sourceMessageIds)
                    try:
                        next_events.append(Event.model_validate(corrected))
                    except Exception:
                        next_events.append(event)
                else:
                    event.confidence = max(event.confidence, float(correction.get("confidence") or 0.9))
                    next_events.append(event)
            analysis.events = next_events
        elif target_type == "place":
            next_places: list[dict] = []
            for place in analysis.places:
                place_key = str(place.get("name") or place.get("label") or "")
                matches = feedback_target_matches(target_key, place_key, analysis.messageId) or target_key in {str(value) for value in place.values()}
                if not matches:
                    next_places.append(place)
                    continue
                if decision == "reject":
                    continue
                place["confidence"] = max(float(place.get("confidence") or 0), float(correction.get("confidence") or 0.9))
                next_places.append(place)
            analysis.places = next_places
        elif target_type == "knowledge":
            next_items: list[KnowledgeItem] = []
            for knowledge in analysis.knowledge:
                matches = feedback_target_matches(target_key, knowledge.itemKey, knowledge.topicKey, knowledge.content) or target_key in knowledge.sourceMessageIds
                if not matches:
                    next_items.append(knowledge)
                    continue
                if decision == "reject":
                    rejected_knowledge.add(knowledge.itemKey)
                    continue
                if decision == "correct":
                    if isinstance(correction.get("content"), str) and correction["content"].strip():
                        knowledge.content = correction["content"].strip()
                    if str(correction.get("topicKey") or "") in SEMANTIC_TOPIC_DESCRIPTIONS:
                        knowledge.topicKey = str(correction["topicKey"])
                        knowledge.topicTitle = localized_topic_title(knowledge.topicKey, language)
                    if str(correction.get("canonicalKey") or "").strip():
                        knowledge.itemKey = f"canonical:{str(correction['canonicalKey']).strip()}"
                knowledge.confidence = max(knowledge.confidence, float(correction.get("confidence") or 0.9))
                next_items.append(knowledge)
            analysis.knowledge = next_items
    if feedback:
        source_ids = [analysis.messageId]
        analysis.provenance.append(Provenance(field="feedback", sourceMessageIds=source_ids, confidence=0.95))
    return analysis, rejected_knowledge


async def remove_rejected_knowledge(db, group_id: str | None, rejected_keys: set[str]):
    if not group_id or not rejected_keys:
        return
    for item_key in rejected_keys:
        await db.execute(
            """DELETE FROM knowledge_items ki USING knowledge_topics kt
               WHERE ki.topic_id=kt.id AND kt.group_id=$1 AND ki.item_key=$2""",
            group_id, item_key,
        )


class AIAdapter:
    """Local adapter contract. External providers can implement this interface later."""

    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de", learning: dict | None = None) -> Analysis:
        raise NotImplementedError


class HeuristicAdapter(AIAdapter):
    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de", learning: dict | None = None) -> Analysis:
        return heuristic_analysis(message_id, text, context, language, learning)


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
    payload = json.dumps(event, default=str).encode()
    if len(payload) > AI_NATS_PAYLOAD_LIMIT_BYTES and event_type == "ai.messages.analyzed":
        original_size = len(payload)
        analysis = event["data"] if isinstance(event.get("data"), dict) else {}
        compact_analysis = {
            key: analysis.get(key)
            for key in (
                "messageId", "relevant", "relevanceLevel", "relevanceScore", "summary", "model",
                "schemaVersion", "promptVersion",
            )
            if key in analysis
        }
        compact_analysis["summary"] = str(compact_analysis.get("summary") or "")[:240]
        compact_analysis["facts"] = [
            {"text": str(item.get("text") or "")[:600], "confidence": item.get("confidence")}
            for item in analysis.get("facts", [])[:10]
            if isinstance(item, dict)
        ]
        compact_analysis["entities"] = analysis.get("entities", [])[:10]
        compact_analysis["events"] = analysis.get("events", [])[:10]
        compact_analysis["places"] = analysis.get("places", [])[:10]
        compact_analysis["knowledge"] = [
            {
                "topicKey": item.get("topicKey"),
                "topicTitle": item.get("topicTitle"),
                "itemKey": item.get("itemKey"),
                "itemType": item.get("itemType"),
                "content": str(item.get("content") or "")[:800],
                "confidence": item.get("confidence"),
                "sourceMessageIds": item.get("sourceMessageIds", [])[:20],
            }
            for item in analysis.get("knowledge", [])[:10]
            if isinstance(item, dict)
        ]
        compact_analysis["provenance"] = analysis.get("provenance", [])[:20]
        compact_analysis["conflicts"] = analysis.get("conflicts", [])[:20]
        event["data"] = compact_analysis
        payload = json.dumps(event, default=str).encode()
        if len(payload) > AI_NATS_PAYLOAD_LIMIT_BYTES:
            event["data"] = {
                key: compact_analysis.get(key)
                for key in (
                    "messageId", "relevant", "relevanceLevel", "relevanceScore", "summary", "model",
                    "schemaVersion", "promptVersion",
                )
                if key in compact_analysis
            }
            payload = json.dumps(event, default=str).encode()
        log.warning(
            "compacted oversized %s event from %d to %d bytes; full analysis remains persisted in PostgreSQL",
            event_type, original_size, len(payload),
        )
    await js.publish(subject, payload)


def bounded_document_text(value: str | None) -> str:
    """Keep large document contents out of AI contexts and NATS events.

    The complete extracted text is persisted in media_objects.ocr_text. The
    AI heuristic only needs a bounded excerpt to create a short summary and
    structured signals.
    """
    normalized = str(value or "").strip()
    if len(normalized) <= AI_DOCUMENT_ANALYSIS_MAX_CHARS:
        return normalized
    return (
        normalized[:AI_DOCUMENT_ANALYSIS_MAX_CHARS].rstrip()
        + "\n[Dokumentinhalt für die Analyse gekürzt; Original bleibt vollständig gespeichert.]"
    )


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


async def load_learning_terms(db, group_id: str | None, language: str) -> dict:
    """Load editable global defaults plus stronger group-local terms."""
    result: dict = {"relevance": {}, "event": {}, "place": {}, "exclusion": [], "keyword": {}}
    try:
        rows = await db.fetch(
            """SELECT category, topic_key, term, weight
               FROM ai_learning_terms
               WHERE enabled=TRUE AND language=$1 AND (group_id IS NULL OR group_id=$2)
               ORDER BY group_id NULLS FIRST, updated_at ASC""",
            language, group_id,
        )
    except Exception:
        return result
    for row in rows:
        category = str(row["category"] or "")
        term = str(row["term"] or "").strip().casefold()
        if not term:
            continue
        weight = float(row["weight"] or 0)
        if category == "keyword":
            topic_key = str(row["topic_key"] or "").strip()
            if not topic_key:
                continue
            is_detail = topic_key.endswith(":detail")
            topic_key = topic_key.removesuffix(":detail")
            result["keyword"].setdefault(topic_key, {"keywords": [], "detail": []})
            result["keyword"][topic_key]["detail" if is_detail else "keywords"].append(term)
        elif category == "exclusion":
            result["exclusion"].append(term)
        elif category in {"relevance", "event", "place"}:
            result[category][term] = result[category].get(term, 0.0) + weight
    return result


def inferred_learning_tokens(text: str, stopwords: set[str]) -> list[str]:
    tokens = re.findall(r"[\wÀ-ÿÄÖÜäöüß-]+", text.casefold())
    return list(dict.fromkeys(token for token in tokens if len(token) >= 3 and token not in stopwords and not token.isnumeric()))


async def record_inferred_learning(db, group_id: str | None, language: str, text: str, analysis: Analysis, learning: dict):
    """Persist weak, explainable signals from detected results.

    Explicit user feedback is stronger and is written by the API. New
    messages still create group-local terms, but the inferred delta is small.
    Existing terms in the same message act as conservative anchors: their
    current category weight determines a capped context bonus for *new* terms.
    This prevents one high-signal message from making every word important.
    """
    if not group_id:
        return
    stopwords = set(learning_terms_for(learning, "exclusion"))
    tokens = inferred_learning_tokens(text, stopwords)

    # One signal is kept per category/topic. If several detected items point
    # to the same scope, only the strongest conservative delta is applied.
    signals: dict[tuple[str, str | None], float] = {}

    def add_signal(category: str, base_delta: float, topic_key: str | None = None):
        evidence = learning_context_evidence(learning, category, text, topic_key)
        delta = min(AI_LEARNING_MAX_DELTA, base_delta + AI_LEARNING_CONTEXT_BONUS * evidence)
        key = (category, topic_key)
        signals[key] = max(signals.get(key, 0.0), delta)

    if analysis.relevanceLevel == "high":
        add_signal("relevance", AI_LEARNING_INFERENCE_BASE_DELTA * 1.5)
    elif analysis.relevanceLevel == "medium":
        add_signal("relevance", AI_LEARNING_INFERENCE_BASE_DELTA)
    if analysis.events:
        add_signal("event", AI_LEARNING_INFERENCE_BASE_DELTA)
    if analysis.places:
        add_signal("place", AI_LEARNING_INFERENCE_BASE_DELTA)
    for item in analysis.knowledge:
        topic_key = str(item.topicKey or "").strip()
        if topic_key and item.confidence >= 0.72:
            add_signal("keyword", AI_LEARNING_INFERENCE_BASE_DELTA * 0.75, topic_key)

    for (category, topic_key), delta in signals.items():
        # Do not repeatedly increase an already-known term merely because it
        # was seen again. The existing term is the anchor; only unseen terms
        # can be inferred from it in this pass.
        known = learning_known_terms(learning, category, topic_key)
        candidates = [term for term in tokens if term not in known]
        for term in candidates[:AI_LEARNING_MAX_TERMS_PER_SIGNAL]:
            topic_value = topic_key or ""
            row = await db.fetchrow(
                """INSERT INTO ai_learning_terms
                          (group_id, language, category, topic_key, term, weight, source, positive_count)
                   VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,'inferred',1)
                   ON CONFLICT DO NOTHING RETURNING id""",
                group_id, language, category, topic_value, term, delta,
            )
            if not row:
                await db.execute(
                    """UPDATE ai_learning_terms
                       SET weight=GREATEST(-10, LEAST(10, weight+$6)), positive_count=positive_count+1, updated_at=NOW()
                       WHERE group_id=$1 AND language=$2 AND category=$3
                         AND topic_key IS NOT DISTINCT FROM NULLIF($4,'')
                         AND lower(term)=lower($5) AND source <> 'admin'""",
                    group_id, language, category, topic_value, term, delta,
                )
            await db.execute(
                """INSERT INTO ai_learning_term_history
                       (term_id, group_id, language, category, term, event_type, weight_delta, source)
                   SELECT id, group_id, language, category, term, 'inferred', $6, 'inferred'
                   FROM ai_learning_terms
                   WHERE group_id=$1 AND language=$2 AND category=$3
                     AND topic_key IS NOT DISTINCT FROM NULLIF($4,'')
                     AND lower(term)=lower($5)""",
                group_id, language, category, topic_value, term, delta,
            )


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
AI_REASSESSMENT_DELAY_SECONDS = max(0.0, float(os.getenv("AI_REASSESSMENT_DELAY_MS", "100")) / 1000)


async def claim_ai_job(db, message_id: str, force: bool = False) -> bool:
    await db.execute(
        """INSERT INTO ai_jobs (message_id, status, next_attempt_at)
           VALUES ($1,'queued',NOW())
           ON CONFLICT (message_id) DO UPDATE SET
             status=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN 'queued' ELSE ai_jobs.status END,
             next_attempt_at=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN NOW() ELSE ai_jobs.next_attempt_at END,
             processing_started_at=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN NULL ELSE ai_jobs.processing_started_at END,
             processing_duration_ms=CASE WHEN $2 AND ai_jobs.status <> 'processing' THEN 0 ELSE ai_jobs.processing_duration_ms END,
             error=CASE WHEN $2 THEN NULL ELSE ai_jobs.error END,
             updated_at=NOW()""",
        message_id, force,
    )
    row = await db.fetchrow(
        """UPDATE ai_jobs SET status='processing', attempts=attempts+1,
                 next_attempt_at=NULL, processing_started_at=NOW(), updated_at=NOW()
           WHERE message_id=$1 AND status='queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           RETURNING id""",
        message_id,
    )
    return bool(row)


async def complete_ai_job(db, message_id: str):
    await db.execute(
        """UPDATE ai_jobs
           SET status='completed', error=NULL, next_attempt_at=NULL,
               processing_duration_ms=processing_duration_ms + CASE
                 WHEN processing_started_at IS NULL THEN 0
                 ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW()-processing_started_at))*1000)::bigint
               END,
               processing_started_at=NULL, updated_at=NOW()
           WHERE message_id=$1""",
        message_id,
    )


async def fail_ai_job(db, message_id: str, error: Exception):
    await db.execute(
        """UPDATE ai_jobs
           SET status=CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END,
               error=$3,
               next_attempt_at=CASE WHEN attempts < $2 THEN NOW() + INTERVAL '30 seconds' ELSE NULL END,
               processing_duration_ms=processing_duration_ms + CASE
                 WHEN processing_started_at IS NULL THEN 0
                 ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW()-processing_started_at))*1000)::bigint
               END,
               processing_started_at=NULL,
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


def knowledge_graph_key(prefix: str, value: str) -> str:
    return f"{prefix}:{event_key_slug(value, 96) or 'unknown'}"


async def upsert_knowledge_graph(db, group_id: str | None, analysis: Analysis):
    """Persist only source-backed associations for later navigation/search."""
    if not group_id:
        return
    entities = [knowledge_graph_key("entity", entity.name) for entity in analysis.entities if entity.name.strip()]
    places = [knowledge_graph_key("place", str(place.get("name") or "")) for place in analysis.places if str(place.get("name") or "").strip()]
    events = [knowledge_graph_key("event", event.eventKey or event.title) for event in analysis.events]
    source_ids = json.dumps([analysis.messageId])
    edges: list[tuple[str, str, str, float]] = []
    for index, source in enumerate(entities):
        for target in entities[index + 1:]:
            edges.append((source, target, "co-mentioned", 0.72))
        for target in places:
            edges.append((source, target, "associated-with", 0.78))
        for target in events:
            edges.append((source, target, "mentioned-in-event", 0.76))
    for source in places:
        for target in events:
            edges.append((source, target, "associated-with", 0.8))
    for source, target, relation, confidence in edges:
        await db.execute(
            """INSERT INTO ai_knowledge_edges (group_id, source_key, target_key, relation, source_message_ids, confidence)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6)
               ON CONFLICT (group_id, source_key, target_key, relation) DO UPDATE SET
                 source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                   FROM jsonb_array_elements(ai_knowledge_edges.source_message_ids || EXCLUDED.source_message_ids) AS merged(value)),
                 confidence=GREATEST(ai_knowledge_edges.confidence, EXCLUDED.confidence), updated_at=NOW()""",
            group_id, source, target, relation, source_ids, confidence,
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
            await js.add_stream(name="WAGI_EVENTS", subjects=["wa.>", "media.>", "ai.messages.>", "ai.feedback.>", "connector.>", "replay.>"])
        except Exception:
            await js.stream_info("WAGI_EVENTS")
    try:
        await js.stream_info("WAGI_REASSESSMENT")
    except Exception:
        try:
            await js.add_stream(name="WAGI_REASSESSMENT", subjects=["ai.reassessment.>"])
        except Exception:
            await js.stream_info("WAGI_REASSESSMENT")

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
            anchor_received_at = current["receivedAt"] if current else datetime.now(timezone.utc)
            rows = await db.fetch(
                """SELECT id::text AS id, wa_message_id AS "waMessageId", group_id AS "groupId", kind, text, received_at AS "receivedAt",
                          CASE WHEN raw ? 'reply_to_message' THEN group_id || ':' || (raw #>> '{reply_to_message,message_id}') END AS "replyToWaMessageId", raw
                   FROM messages
                   WHERE group_id = $1
                     AND received_at BETWEEN $2::timestamptz - ($3 * INTERVAL '1 hour')
                                         AND $2::timestamptz + ($3 * INTERVAL '1 hour')
                   ORDER BY received_at ASC LIMIT $4""",
                group_id, anchor_received_at, AI_EVENT_WINDOW_HOURS, AI_CONTEXT_MAX_MESSAGES,
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
        learning = await load_learning_terms(db, group_id, group_language)
        analysis = await adapter.analyze(message_id, text, context, group_language, learning)
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
        feedback = await load_ai_feedback(db, group_id, message_id)
        analysis, rejected_knowledge = apply_feedback_overrides(analysis, feedback, group_language)
        if not data.get("skipLearning"):
            await record_inferred_learning(db, group_id, group_language, text, analysis, learning)
        await remove_rejected_knowledge(db, group_id, rejected_knowledge)
        if analysis.knowledge and hermes_reviewer.enabled:
            analysis.provenance.append(Provenance(field="knowledge", sourceMessageIds=[message_id], confidence=max(item.confidence for item in analysis.knowledge)))
        serialized_analysis = analysis.model_dump(mode="json")
        await db.execute(
            """INSERT INTO message_analyses (message_id, relevant, relevance_level, relevance_score, summary, facts, entities, events, places, model, schema_version, prompt_version, provenance, conflicts)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14::jsonb)
               ON CONFLICT (message_id) DO UPDATE SET relevant=EXCLUDED.relevant, relevance_level=EXCLUDED.relevance_level, relevance_score=EXCLUDED.relevance_score,
               summary=EXCLUDED.summary, facts=EXCLUDED.facts, entities=EXCLUDED.entities, events=EXCLUDED.events,
               places=EXCLUDED.places, model=EXCLUDED.model, schema_version=EXCLUDED.schema_version, prompt_version=EXCLUDED.prompt_version,
               provenance=EXCLUDED.provenance, conflicts=EXCLUDED.conflicts, updated_at=NOW()""",
            message_id, analysis.relevant, analysis.relevanceLevel, analysis.relevanceScore, analysis.summary,
            json.dumps(serialized_analysis["facts"]), json.dumps(serialized_analysis["entities"]),
            json.dumps(serialized_analysis["events"]), json.dumps(serialized_analysis["places"]), analysis.model,
            analysis.schemaVersion, analysis.promptVersion, json.dumps(serialized_analysis["provenance"]), json.dumps(serialized_analysis["conflicts"]),
        )
        await upsert_knowledge(db, group_id, analysis.knowledge, encoder)
        await upsert_knowledge_graph(db, group_id, analysis)
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

    async def on_feedback(message):
        payload = {}
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            event_id = payload_id(payload, message.data)
            if not await claim_event(db, "ai.feedback", event_id, message.subject, payload):
                await message.ack()
                return
            message_id = data.get("messageId")
            if message_id:
                await process_analysis(db, analyze_message, {"data": {"messageId": message_id, "force": True}}, "feedback", force=True)
            await mark_processed(db, "ai.feedback", event_id)
            await message.ack()
        except Exception as error:
            log.exception("failed to consume AI feedback")
            await retry_or_dead_letter(db, js, message, payload, "ai.feedback", error)

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
            extracted = await db.fetchval(
                """SELECT ocr_text FROM media_objects
                   WHERE message_id=$1 AND ocr_text IS NOT NULL
                   ORDER BY updated_at DESC LIMIT 1""",
                data.get("messageId"),
            )
            extracted = extracted or data.get("text") or data.get("ocrText") or ""
            document_text = bounded_document_text(extracted)
            await process_analysis(
                db,
                analyze_message,
                {"data": {"messageId": data.get("messageId"), "text": f"{current or ''}\n[Dokument] {document_text}".strip(), "force": True}},
                "document",
                force=True,
            )
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

    async def on_reassessment(message):
        """Re-score persisted messages without touching connector/media queues."""
        payload = {}
        job_id = None
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            job_id = str(data.get("reassessmentId") or "")
            event_id = payload_id(payload, message.data)
            if not job_id:
                raise ValueError("reassessmentId missing")
            if not await claim_event(db, "ai.reassessment", event_id, message.subject, payload):
                await message.ack()
                return
            await db.execute(
                """UPDATE ai_reassessment_jobs
                   SET status='running', started_at=COALESCE(started_at,NOW()), updated_at=NOW(), error=NULL
                   WHERE id=$1::uuid AND status IN ('queued','running')""",
                job_id,
            )
            rows = await db.fetch(
                """SELECT m.id::text AS "messageId", m.group_id AS "groupId",
                          COALESCE(m.text,'') AS text,
                          COALESCE(aj.transcript,'') AS transcript,
                          COALESCE(mo.ocr_text,'') AS "ocrText"
                   FROM messages m
                   JOIN wa_groups g ON g.id=m.group_id
                   LEFT JOIN LATERAL (
                     SELECT transcript FROM audio_jobs
                     WHERE message_id=m.id AND transcript IS NOT NULL AND btrim(transcript) <> ''
                     ORDER BY updated_at DESC LIMIT 1
                   ) aj ON TRUE
                   LEFT JOIN LATERAL (
                     SELECT string_agg(ocr_text, E'\\n' ORDER BY updated_at DESC) AS ocr_text
                     FROM media_objects
                     WHERE message_id=m.id AND ocr_text IS NOT NULL AND btrim(ocr_text) <> ''
                   ) mo ON TRUE
                   WHERE TRUE
                   ORDER BY m.received_at ASC""",
            )
            await db.execute("UPDATE ai_reassessment_jobs SET total_count=$2, updated_at=NOW() WHERE id=$1::uuid", job_id, len(rows))
            processed = 0
            failed = 0
            skipped = 0
            for row in rows:
                message_id = str(row["messageId"])
                base_text = str(row["text"] or "").strip()
                transcript = str(row["transcript"] or "").strip()
                ocr_text = str(row["ocrText"] or "").strip()
                parts = [base_text]
                if transcript and transcript not in base_text:
                    parts.append("[Transkript]\n" + transcript)
                if ocr_text and ocr_text not in base_text:
                    parts.append("[Gespeicherter Medieninhalt]\n" + ocr_text)
                reassessment_text = "\n".join(part for part in parts if part).strip()
                try:
                    did_process = await process_analysis(
                        db,
                        analyze_message,
                        {"data": {"messageId": message_id, "groupId": row["groupId"], "text": reassessment_text, "force": True, "skipLearning": True}},
                        "reassessment",
                        force=True,
                    )
                    if did_process:
                        processed += 1
                    else:
                        skipped += 1
                except Exception:
                    failed += 1
                    log.exception("reassessment item failed: %s", message_id)
                await db.execute(
                    """UPDATE ai_reassessment_jobs SET processed_count=$2, failed_count=$3, skipped_count=$4, updated_at=NOW()
                       WHERE id=$1::uuid""",
                    job_id, processed, failed, skipped,
                )
                if AI_REASSESSMENT_DELAY_SECONDS:
                    await asyncio.sleep(AI_REASSESSMENT_DELAY_SECONDS)
            await db.execute(
                """UPDATE ai_reassessment_jobs
                   SET status=CASE WHEN failed_count > 0 AND processed_count=0 THEN 'failed' ELSE 'completed' END,
                       completed_at=NOW(), updated_at=NOW()
                   WHERE id=$1::uuid""",
                job_id,
            )
            await mark_processed(db, "ai.reassessment", event_id)
            await message.ack()
            log.info("AI reassessment %s completed: processed=%d failed=%d skipped=%d", job_id, processed, failed, skipped)
        except Exception as error:
            log.exception("AI reassessment failed")
            if job_id:
                await db.execute("UPDATE ai_reassessment_jobs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1::uuid", job_id, str(error)[:4000])
            await retry_or_dead_letter(db, js, message, payload, "ai.reassessment", error)

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
                           processing_duration_ms=processing_duration_ms + CASE
                             WHEN processing_started_at IS NULL THEN 0
                             ELSE LEAST($2 * 1000, GREATEST(0, EXTRACT(EPOCH FROM (NOW()-processing_started_at))*1000))::bigint
                           END,
                           processing_started_at=NULL,
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
    await js.subscribe("wa.messages.received", durable="WAGI_AI_MESSAGES", stream="WAGI_EVENTS", cb=on_message)
    await js.subscribe("ai.feedback.created", durable="WAGI_AI_FEEDBACK", stream="WAGI_EVENTS", cb=on_feedback)
    await js.subscribe("media.audio.transcribed", durable="WAGI_AI_TRANSCRIPTS", stream="WAGI_EVENTS", cb=on_transcript)
    await js.subscribe("media.image.analyzed", durable="WAGI_AI_IMAGES", stream="WAGI_EVENTS", cb=on_image)
    await js.subscribe("media.document.analyzed", durable="WAGI_AI_DOCUMENTS", stream="WAGI_EVENTS", cb=on_document)
    await js.subscribe("replay.requested", durable="WAGI_AI_REPLAY", stream="WAGI_EVENTS", cb=on_replay)
    await js.subscribe("ai.reassessment.requested", durable="WAGI_AI_REASSESSMENT", stream="WAGI_REASSESSMENT", cb=on_reassessment)

    async def run_knowledge_startup():
        """Refresh/rebuild the knowledge base without blocking live ingestion."""
        try:
            await refresh_knowledge_topic_titles(db)
            await backfill_existing_knowledge(force=knowledge_rebuild_required)
            if knowledge_rebuild_required:
                await mark_knowledge_rebuild_complete(db)
            log.info("knowledge startup refresh completed (rebuild=%s)", knowledge_rebuild_required)
        except Exception:
            log.exception("knowledge startup refresh failed; live consumers remain active")

    asyncio.create_task(run_knowledge_startup())
    asyncio.create_task(recover_ai_jobs())
    log.info("AI worker listening with durable consumers for messages, audio, images, documents, replay, feedback and isolated reassessment (provider=%s, prompt=%s)", AI_PROVIDER, PROMPT_VERSION)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
