import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Literal

import asyncpg
import nats
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("wagi-ai-worker")

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://wagi_app:app@localhost:5432/app")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
MODEL = os.getenv("AI_MODEL", "heuristic-mvp")
AI_PROVIDER = os.getenv("AI_PROVIDER", "heuristic").lower()
PROMPT_VERSION = os.getenv("AI_PROMPT_VERSION", "phase1-v2-precision")
SCHEMA_VERSION = "1.1"
SUPPORTED_GROUP_LANGUAGES = ("de", "es", "ca", "en", "fr")
KNOWLEDGE_REBUILD_VERSION = os.getenv("AI_KNOWLEDGE_VERSION", "precision-v3")
KNOWLEDGE_STATE_CONNECTOR = "ai-worker-knowledge"

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


def heuristic_analysis(message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
    normalized = text.strip()
    keywords = ("morgen", "heute", "treffen", "termin", "event", "wichtig", "ort", "straße", "bahnhof", "meeting", "samstag", "sonntag", "costa", "montserrat")
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
    if any(word in normalized.lower() for word in ("morgen", "heute", "termin", "treffen")):
        event = {"title": normalized[:120], "confidence": 0.58}
    current = next((item for item in context if str(item.get("id")) == message_id), {})
    location = location_details(current)
    place = {}
    if location:
        place = {"name": location["name"], "latitude": location["latitude"], "longitude": location["longitude"], "confidence": 0.9}
    elif any(word in normalized.lower() for word in ("ort", "bahnhof", "straße")):
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
    candidates = [(str(item["id"]), starts_at(str(item.get("text") or ""))) for item in context if item.get("id") and starts_at(str(item.get("text") or ""))]
    dates = {value for _, value in candidates if value}
    if len(dates) <= 1:
        return []
    return [Conflict(field="startsAt", messageIds=[item_id for item_id, _ in candidates], description="Mehrere Nachrichten nennen unterschiedliche Zeitangaben für denselben Gesprächskontext.", confidence=0.72)]


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
            content=normalized[:280],
            confidence=round(confidence, 4),
            sourceMessageIds=source_ids,
        ))
    return result


class AIAdapter:
    """Local adapter contract. External providers can implement this interface later."""

    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
        raise NotImplementedError


class HeuristicAdapter(AIAdapter):
    async def analyze(self, message_id: str, text: str, context: list[dict], language: str = "de") -> Analysis:
        return heuristic_analysis(message_id, text, context, language)


def build_adapter() -> AIAdapter:
    if AI_PROVIDER != "heuristic":
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
    await js.publish(subject, json.dumps(event).encode())


async def upsert_knowledge(db, group_id: str | None, items: list[KnowledgeItem]):
    if not group_id or not items:
        return
    for item in items:
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
        await db.execute(
            """INSERT INTO knowledge_items (topic_id, item_key, item_type, content, confidence, source_message_ids)
               VALUES ($1,$2,$3,$4,$5,$6::jsonb)
               ON CONFLICT (topic_id, item_key) DO UPDATE SET item_type=EXCLUDED.item_type, content=EXCLUDED.content,
               confidence=GREATEST(knowledge_items.confidence, EXCLUDED.confidence),
               source_message_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
                                   FROM jsonb_array_elements(knowledge_items.source_message_ids || EXCLUDED.source_message_ids) AS merged(value)),
               updated_at=NOW()""",
            topic["id"], item.itemKey, item.itemType, item.content, item.confidence, json.dumps(item.sourceMessageIds),
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


async def main():
    db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    adapter = build_adapter()
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
        group_language = await resolve_group_language(db, group_id, context, text)
        analysis = await adapter.analyze(message_id, text, context, group_language)
        analysis.events = deduplicate_events(analysis.events)
        analysis.conflicts = find_conflicts(context)
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
        await upsert_knowledge(db, group_id, analysis.knowledge)
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

    async def on_image(message):
        try:
            payload = json.loads(message.data)
            data = payload.get("data", payload)
            current = await db.fetchval("SELECT COALESCE(text, '') FROM messages WHERE id=$1", data.get("messageId"))
            ocr = data.get("ocrText") or ""
            await analyze_message({"data": {"messageId": data.get("messageId"), "text": f"{current or ''}\n[OCR] {ocr}".strip()}})
            await message.ack()
        except Exception:
            log.exception("failed to consume image analysis")

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
            await analyze_message({"data": dict(row)})

    knowledge_rebuild_required = await prepare_knowledge_rebuild(db)
    await refresh_knowledge_topic_titles(db)
    await backfill_existing_knowledge(force=knowledge_rebuild_required)
    if knowledge_rebuild_required:
        await mark_knowledge_rebuild_complete(db)
    await js.subscribe("wa.messages.received", durable="WAGI_AI_MESSAGES", stream="WAGI_EVENTS", cb=on_message)
    await js.subscribe("media.audio.transcribed", durable="WAGI_AI_TRANSCRIPTS", stream="WAGI_EVENTS", cb=on_transcript)
    await js.subscribe("media.image.analyzed", durable="WAGI_AI_IMAGES", stream="WAGI_EVENTS", cb=on_image)
    log.info("AI worker listening on wa.messages.received, media.audio.transcribed and media.image.analyzed (provider=%s, prompt=%s)", AI_PROVIDER, PROMPT_VERSION)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
