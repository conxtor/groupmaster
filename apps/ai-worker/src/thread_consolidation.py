"""Bounded, deterministic conversation clustering; no model or network calls.

Replies and the latest user decisions are constraints. Automatic links need
content evidence, an unambiguous destination, and support across the proposed
cluster. A connected component alone is deliberately not a conversation.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

THREAD_WINDOW_HOURS = max(2.0, float(os.getenv("AI_THREAD_WINDOW_HOURS", "18")))
THREAD_MAX_CANDIDATES = max(2, min(12, int(os.getenv("AI_THREAD_MAX_CANDIDATES", "6"))))
THREAD_AUTO_LINK_THRESHOLD = min(0.92, max(0.45, float(os.getenv("AI_THREAD_AUTO_LINK_THRESHOLD", "0.50"))))
THREAD_CONTEXT_THRESHOLD = min(0.90, max(0.30, float(os.getenv("AI_THREAD_CONTEXT_THRESHOLD", "0.42"))))
CONSOLIDATION_MIN_SCORE = max(THREAD_AUTO_LINK_THRESHOLD, min(0.95, float(os.getenv("AI_THREAD_CONSOLIDATION_MIN_SCORE", "0.62"))))
CONSOLIDATION_MARGIN = max(0.0, min(0.25, float(os.getenv("AI_THREAD_CONSOLIDATION_MARGIN", "0.08"))))
CONSOLIDATION_COHESION = max(0.51, min(1.0, float(os.getenv("AI_THREAD_CONSOLIDATION_COHESION", "0.60"))))
CONSOLIDATION_MAX_MESSAGES = max(20, min(400, int(os.getenv("AI_THREAD_CONSOLIDATION_MAX_MESSAGES", "160"))))
VERSION = "consolidator-v1"
TOKEN_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)
URL_RE = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)


def as_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def as_object(value) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return {}
    return value if isinstance(value, dict) else {}


def identities(item: dict) -> set[str]:
    values = {str(item.get("id") or ""), str(item.get("waMessageId") or "")}
    if item.get("groupId") and item.get("waMessageId"):
        values.add(f"{item['groupId']}:{item['waMessageId']}")
    return values - {""}


def reply_target(item: dict) -> str | None:
    if item.get("replyToWaMessageId"):
        return str(item["replyToWaMessageId"])
    raw = as_object(item.get("raw"))
    if raw.get("replyToWaMessageId"):
        return str(raw["replyToWaMessageId"])
    reply = as_object(raw.get("reply_to_message"))
    if reply.get("message_id") is not None:
        return f"{item.get('groupId', '')}:{reply['message_id']}"
    # gotd uses exported Go field names when serialised by encoding/json.
    reply = as_object(raw.get("ReplyTo") or raw.get("reply_to"))
    target = reply.get("ReplyToMsgID") or reply.get("reply_to_msg_id")
    if target:
        top = reply.get("ReplyToTopID") or reply.get("reply_to_top_id")
        topic = str(item.get("groupId") or "").rsplit(":topic:", 1)
        # Telegram forum membership uses reply headers too. Its topic root is
        # not evidence that every post in the topic belongs to one conversation.
        if (reply.get("ForumTopic") or reply.get("forum_topic")) and top and str(target) == str(top):
            return None
        if len(topic) == 2 and str(target) == topic[1]:
            return None
        return f"{item.get('groupId', '')}:{target}"
    # whatsmeow stores a protobuf message directly; older Baileys records
    # wrapped it in `message`. Also unwrap ephemeral/view-once documents.
    message = as_object(raw.get("message")) or raw
    for _ in range(4):
        for key in ("extendedTextMessage", "imageMessage", "audioMessage", "videoMessage", "documentMessage", "locationMessage", "liveLocationMessage", "stickerMessage"):
            info = as_object(as_object(message.get(key)).get("contextInfo"))
            if info.get("stanzaId"):
                return str(info["stanzaId"])
        wrapped = next((as_object(message.get(key)) for key in ("ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage") if message.get(key)), {})
        message = as_object(wrapped.get("message"))
        if not message:
            break
    return None


def pair(left: str, right: str) -> tuple[str, str]:
    return tuple(sorted((str(left), str(right))))


def tokens(text: str, stopwords: set[str]) -> set[str]:
    text = URL_RE.sub(" ", str(text or "").casefold())
    # The exclusion vocabulary, including phrases, stays in the database.
    for phrase in sorted((word.casefold() for word in stopwords if " " in word), key=len, reverse=True):
        text = re.sub(rf"(?<!\w){re.escape(phrase)}(?!\w)", " ", text)
    return {word for word in TOKEN_RE.findall(text) if len(word) >= 3 and not word.isnumeric() and word not in stopwords}


def _hours(left: dict, right: dict) -> float | None:
    a, b = as_datetime(left.get("receivedAt")), as_datetime(right.get("receivedAt"))
    return abs((a - b).total_seconds()) / 3600 if a and b else None


def relation_score(current: dict, candidate: dict, stopwords: set[str] | None = None, *, weights: dict[str, float] | None = None, token_sets: dict[str, set[str]] | None = None) -> tuple[float, dict]:
    if current.get("groupId") != candidate.get("groupId"):
        return 0.0, {"reason": "different-group"}
    hours = _hours(current, candidate)
    evidence = {"version": VERSION, "timeHours": round(hours, 3) if hours is not None else None}
    if reply_target(current) in identities(candidate) or reply_target(candidate) in identities(current):
        return 1.0, {**evidence, "explicitReply": True}
    if hours is None or hours > THREAD_WINDOW_HOURS:
        return 0.0, {**evidence, "reason": "outside-window"}
    stopwords = stopwords or set()
    if token_sets is None:
        stopwords = {word.casefold() for word in stopwords}
    token_sets = token_sets or {}
    a = token_sets[str(current["id"])] if str(current.get("id")) in token_sets else tokens(str(current.get("text") or ""), stopwords)
    b = token_sets[str(candidate["id"])] if str(candidate.get("id")) in token_sets else tokens(str(candidate.get("text") or ""), stopwords)
    overlap = a & b
    urls_a = {url.rstrip(".,;!?)])") for url in URL_RE.findall(str(current.get("text") or ""))}
    urls_b = {url.rstrip(".,;!?)])") for url in URL_RE.findall(str(candidate.get("text") or ""))}
    shared_url = bool(urls_a & urls_b)
    evidence.update(tokenOverlap=sorted(overlap)[:12], sharedURL=shared_url, explicitReply=False)
    if len(overlap) < 2 and not shared_url:
        return 0.0, {**evidence, "reason": "insufficient-content"}
    weights = weights or {}
    mass = lambda terms: sum(weights.get(word, 1.0) for word in terms)
    shared = mass(overlap)
    coverage = shared / max(1.0, min(mass(a), mass(b)))
    jaccard = shared / max(1.0, mass(a | b))
    # Very common group/window vocabulary cannot establish a thread by itself.
    distinctive = sum(weights.get(word, 1.0) >= 1.15 for word in overlap)
    if weights and not distinctive and len(overlap) < 3 and not shared_url:
        return 0.0, {**evidence, "reason": "only-common-terms"}
    same_sender = bool(current.get("senderJid") and current.get("senderJid") == candidate.get("senderJid"))
    score = 0.65 * coverage + 0.25 * jaccard + 0.12 * math.exp(-hours / 3) + (0.025 if same_sender else 0)
    if shared_url:
        score = max(score, 0.84)
    return round(min(0.98, score), 4), {**evidence, "coverage": round(coverage, 4), "jaccard": round(jaccard, 4), "sameSender": same_sender}


@dataclass
class Consolidation:
    clusters: list[list[str]]
    edges: dict[tuple[str, str], tuple[float, dict, str]]
    ambiguous: set[str] = field(default_factory=set)
    blocked: set[tuple[str, str]] = field(default_factory=set)


def consolidate_messages(context: list[dict], stopwords: set[str] | None = None, feedback: list[dict] | None = None) -> Consolidation:
    """Constrained agglomeration of explicit-reply components.

    Feedback is supplied newest first. Unlink constraints apply transitively;
    a conflicting positive chain is left split instead of bypassing a rejection.
    """
    by_id = {str(item["id"]): item for item in context if item.get("id") and not item.get("deletedAt")}
    ids = sorted(by_id, key=lambda key: (str(by_id[key].get("receivedAt") or ""), key))
    latest = {}
    for row in feedback or []:
        left, right = str(row["message_id"]), str(row["related_message_id"])
        if left in by_id and right in by_id and by_id[left].get("groupId") == by_id[right].get("groupId"):
            latest.setdefault(pair(left, right), row["decision"])
    blocked = {key for key, decision in latest.items() if decision == "unlink"}
    ignored = {word.casefold() for word in (stopwords or set())}
    token_sets = {key: tokens(str(item.get("text") or ""), ignored) for key, item in by_id.items()}
    counts = Counter(word for terms in token_sets.values() for word in terms)
    # With tiny samples there is no evidence that a common word is boilerplate.
    weights = {word: 1 + math.log((len(ids) + 1) / (count + 1)) for word, count in counts.items()} if len(ids) >= 5 else {}
    scores = {}
    for pos, left in enumerate(ids):
        for right in ids[pos + 1:]:
            scores[pair(left, right)] = relation_score(by_id[left], by_id[right], ignored, weights=weights, token_sets=token_sets)
    components = {key: {key} for key in ids}
    owners = {key: key for key in ids}
    edges = {}

    def can_join(a, b):
        return not any(pair(left, right) in blocked for left in a for right in b)

    def join(left, right):
        a, b = owners[left], owners[right]
        if a != b:
            members = components.pop(b)
            components[a].update(members)
            for key in members:
                owners[key] = a

    hard = [(key, (1.0, {"version": VERSION, "userFeedback": "link"}), "user") for key, decision in latest.items() if decision == "link"]
    hard += [(key, value, "heuristic") for key, value in scores.items() if value[1].get("explicitReply") and key not in latest]
    for (left, right), (score, evidence), source in hard:
        if can_join(components[owners[left]], components[owners[right]]):
            join(left, right)
            edges[(left, right)] = (score, evidence, source)

    # Atomic components let a short explicit reply follow its parent without
    # weakening the cohesion check for every other automatic member.
    atoms = [set(members) for members in components.values()]
    atom_owner = {key: index for index, members in enumerate(atoms) for key in members}
    atom_scores = {}
    for i, left in enumerate(atoms):
        for j in range(i + 1, len(atoms)):
            right = atoms[j]
            atom_scores[i, j] = max((scores[pair(a, b)][0] for a in left for b in right), default=0)
    get_score = lambda a, b: atom_scores.get(tuple(sorted((a, b))), 0)
    ambiguous_atoms = set()
    for i in range(len(atoms)):
        ranked = sorted(((get_score(i, j), j) for j in range(len(atoms)) if i != j and can_join(atoms[i], atoms[j])), reverse=True)
        if len(ranked) < 2 or ranked[0][0] < CONSOLIDATION_MIN_SCORE:
            continue
        best, best_id = ranked[0]
        for runner_up, other_id in ranked[1:THREAD_MAX_CANDIDATES]:
            if runner_up < THREAD_CONTEXT_THRESHOLD or best - runner_up >= CONSOLIDATION_MARGIN:
                continue
            if get_score(best_id, other_id) < THREAD_CONTEXT_THRESHOLD or not can_join(atoms[best_id], atoms[other_id]):
                ambiguous_atoms.add(i)
    auto = sorted(scores.items(), key=lambda item: (-item[1][0], item[0]))
    for (left, right), (score, evidence) in auto:
        if score < CONSOLIDATION_MIN_SCORE or (left, right) in blocked:
            continue
        a, b = components[owners[left]], components[owners[right]]
        if a is b:
            continue
        if atom_owner[left] in ambiguous_atoms or atom_owner[right] in ambiguous_atoms or not can_join(a, b):
            continue
        left_atoms, right_atoms = {atom_owner[key] for key in a}, {atom_owner[key] for key in b}
        cross = [get_score(x, y) for x in left_atoms for y in right_atoms]
        cohesion = sum(value >= THREAD_CONTEXT_THRESHOLD for value in cross) / len(cross)
        if cohesion < CONSOLIDATION_COHESION or sum(cross) / len(cross) < THREAD_CONTEXT_THRESHOLD:
            continue
        join(left, right)
        edges[(left, right)] = (score, {**evidence, "clusterCohesion": round(cohesion, 4)}, "heuristic")
    clusters = [sorted(members, key=lambda key: (str(by_id[key].get("receivedAt") or ""), key)) for members in components.values() if len(members) > 1]
    ambiguous = {key for i in ambiguous_atoms for key in atoms[i]}
    return Consolidation(sorted(clusters, key=lambda members: members[0]), edges, ambiguous, blocked)


def annotate_consolidation(current_id: str, context: list[dict], result: Consolidation) -> list[dict]:
    cluster = next((set(members) for members in result.clusters if str(current_id) in members), {str(current_id)})
    for item in context:
        key = str(item.get("id") or "")
        related = key in cluster
        incident = [value for edge, value in result.edges.items() if key in edge]
        item["threadResolved"] = True
        item["threadBlocked"] = not related
        item["threadScore"] = max((value[0] for value in incident), default=0.0) if related else 0.0
        item["threadEvidence"] = {"version": VERSION, "ambiguous": key in result.ambiguous, "member": related}
    return context


def is_thread_context(current_id: str, item: dict, context: list[dict]) -> bool:
    if str(item.get("id")) == str(current_id):
        return True
    if item.get("threadBlocked"):
        return False
    if item.get("threadResolved"):
        return float(item.get("threadScore") or 0) >= THREAD_AUTO_LINK_THRESHOLD
    current = next((row for row in context if str(row.get("id")) == str(current_id)), {})
    if current.get("groupId") != item.get("groupId"):
        return False
    return bool(float(item.get("threadScore") or 0) >= THREAD_AUTO_LINK_THRESHOLD or reply_target(item) in identities(current) or reply_target(current) in identities(item))
