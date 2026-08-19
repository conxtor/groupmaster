"""Conservative, explainable conversation threading for one group.

The connector protocols only expose an explicit reply for some messages. This
module adds a small PostgreSQL-backed relation graph for ordinary follow-up
messages. It intentionally uses time, content overlap and reply evidence only;
the graph can be corrected by group-scoped user feedback and every automatic
edge keeps its evidence.
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timezone


THREAD_WINDOW_HOURS = max(2.0, float(os.getenv("AI_THREAD_WINDOW_HOURS", "18")))
THREAD_MAX_CANDIDATES = max(2, min(12, int(os.getenv("AI_THREAD_MAX_CANDIDATES", "6"))))
THREAD_AUTO_LINK_THRESHOLD = min(0.92, max(0.45, float(os.getenv("AI_THREAD_AUTO_LINK_THRESHOLD", "0.50"))))
THREAD_CONTEXT_THRESHOLD = min(0.90, max(0.30, float(os.getenv("AI_THREAD_CONTEXT_THRESHOLD", "0.42"))))
TOKEN_RE = re.compile(r"[\wÀ-ÿÄÖÜäöüß-]+", re.IGNORECASE)


def _as_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _tokens(text: str, stopwords: set[str] | None = None) -> set[str]:
    ignored = stopwords or set()
    return {
        token.casefold()
        for token in TOKEN_RE.findall(str(text or ""))
        if len(token) >= 3 and token.casefold() not in ignored and not token.isnumeric()
    }


def _identities(item: dict) -> set[str]:
    group_id = str(item.get("groupId") or "")
    values = {str(item.get("id") or ""), str(item.get("waMessageId") or "")}
    if group_id and item.get("waMessageId"):
        values.add(f"{group_id}:{item['waMessageId']}")
    return {value for value in values if value}


def _reply_target(item: dict) -> str | None:
    value = item.get("replyToWaMessageId")
    return str(value) if value else None


def _hours_between(left: dict, right: dict) -> float:
    left_time = _as_datetime(left.get("receivedAt"))
    right_time = _as_datetime(right.get("receivedAt"))
    if not left_time or not right_time:
        return 0.0
    return abs((left_time - right_time).total_seconds()) / 3600


def relation_score(current: dict, candidate: dict, stopwords: set[str] | None = None) -> tuple[float, dict]:
    """Score one possible relation and return the explainable components."""
    current_ids = _identities(current)
    candidate_ids = _identities(candidate)
    current_reply = _reply_target(current)
    candidate_reply = _reply_target(candidate)
    explicit_reply = bool(
        (current_reply and current_reply in candidate_ids)
        or (candidate_reply and candidate_reply in current_ids)
    )
    if explicit_reply:
        return 1.0, {"explicitReply": True, "tokenOverlap": 0, "timeHours": round(_hours_between(current, candidate), 3)}

    current_tokens = _tokens(str(current.get("text") or ""), stopwords)
    candidate_tokens = _tokens(str(candidate.get("text") or ""), stopwords)
    overlap = current_tokens & candidate_tokens
    union = current_tokens | candidate_tokens
    shorter = max(1, min(len(current_tokens), len(candidate_tokens)))
    coverage = len(overlap) / shorter if current_tokens and candidate_tokens else 0.0
    jaccard = len(overlap) / max(1, len(union))
    hours = _hours_between(current, candidate)
    if hours <= 0.25:
        time_signal = 0.18
    elif hours <= 1:
        time_signal = 0.14
    elif hours <= 4:
        time_signal = 0.09
    elif hours <= THREAD_WINDOW_HOURS:
        time_signal = 0.04
    else:
        time_signal = 0.0
    same_sender = bool(current.get("senderJid") and current.get("senderJid") == candidate.get("senderJid"))
    # Short confirmations such as “Samstag passt” are useful when they share
    # one strong content token with a nearby message. Long generic messages
    # need substantially more overlap and therefore remain below the gate.
    short_confirmation = len(current_tokens) <= 5 or len(candidate_tokens) <= 5
    overlap_signal = 0.0
    if len(overlap) >= 2 or (short_confirmation and len(overlap) >= 1):
        overlap_signal = 0.50 * coverage + 0.30 * jaccard
    score = min(0.99, overlap_signal + time_signal + (0.04 if same_sender else 0.0))
    return score, {
        "explicitReply": False,
        "tokenOverlap": sorted(overlap)[:12],
        "coverage": round(coverage, 4),
        "jaccard": round(jaccard, 4),
        "timeHours": round(hours, 3),
        "sameSender": same_sender,
    }


def annotate_thread_context(current_id: str, context: list[dict], stopwords: set[str] | None = None) -> list[dict]:
    """Annotate the existing AI context without adding another DB query."""
    current = next((item for item in context if str(item.get("id")) == str(current_id)), None)
    if not current:
        return context
    candidates = []
    for item in context:
        if str(item.get("id")) == str(current_id):
            continue
        score, evidence = relation_score(current, item, stopwords)
        if score >= THREAD_CONTEXT_THRESHOLD and _hours_between(current, item) <= THREAD_WINDOW_HOURS:
            candidates.append((score, item, evidence))
    candidates.sort(key=lambda entry: (entry[0], str(entry[1].get("receivedAt") or "")), reverse=True)
    allowed = {str(item.get("id")): (score, evidence) for score, item, evidence in candidates[:THREAD_MAX_CANDIDATES]}
    for item in context:
        item_id = str(item.get("id") or "")
        if item_id in allowed:
            score, evidence = allowed[item_id]
            item["threadScore"] = round(score, 4)
            item["threadEvidence"] = evidence
    return context


def _pair(left: str, right: str) -> tuple[str, str]:
    return (left, right) if left < right else (right, left)


async def _latest_feedback(db, group_id: str, message_id: str, related_ids: list[str]) -> dict[tuple[str, str], str]:
    if not related_ids:
        return {}
    try:
        rows = await db.fetch(
            """SELECT message_id::text, related_message_id::text, decision
               FROM conversation_relation_feedback
               WHERE group_id=$1 AND ((message_id=$2::uuid AND related_message_id=ANY($3::uuid[]))
                  OR (related_message_id=$2::uuid AND message_id=ANY($3::uuid[])))
               ORDER BY created_at DESC""",
            group_id, message_id, related_ids,
        )
    except Exception:
        return {}
    result: dict[tuple[str, str], str] = {}
    for row in rows:
        key = _pair(str(row["message_id"]), str(row["related_message_id"]))
        result.setdefault(key, str(row["decision"]))
    return result


async def annotate_feedback_context(db, group_id: str | None, current_id: str, context: list[dict]) -> list[dict]:
    """Apply the latest group-scoped link/unlink decisions to AI context."""
    if not group_id:
        return context
    related_ids = [str(item.get("id")) for item in context if str(item.get("id")) and str(item.get("id")) != str(current_id)]
    feedback = await _latest_feedback(db, group_id, str(current_id), related_ids)
    for item in context:
        item_id = str(item.get("id") or "")
        if not item_id or item_id == str(current_id):
            continue
        decision = feedback.get(_pair(str(current_id), item_id))
        if decision == "link":
            item["threadScore"] = 1.0
            item["threadEvidence"] = {"userFeedback": "link"}
            item["threadBlocked"] = False
        elif decision == "unlink":
            item["threadScore"] = 0.0
            item["threadEvidence"] = {"userFeedback": "unlink"}
            item["threadBlocked"] = True
    return context


async def _thread_assignments(db, message_ids: list[str]) -> dict[str, list[str]]:
    if not message_ids:
        return {}
    try:
        rows = await db.fetch(
            """SELECT message_id::text, thread_id::text
               FROM conversation_thread_messages
               WHERE message_id=ANY($1::uuid[])
               ORDER BY confidence DESC, updated_at DESC""",
            message_ids,
        )
    except Exception:
        return {}
    result: dict[str, list[str]] = {}
    for row in rows:
        result.setdefault(str(row["message_id"]), []).append(str(row["thread_id"]))
    return result


def _thread_title(current: dict, analysis: dict | None = None) -> str:
    summary = str((analysis or {}).get("summary") or "").strip()
    text = summary or str(current.get("text") or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:120].rstrip(" .,:;-") or "Conversation thread"


async def persist_conversation_thread(
    db,
    group_id: str | None,
    current: dict,
    context: list[dict],
    analysis: dict | None = None,
) -> str | None:
    """Persist high-confidence links and the corresponding thread membership."""
    if not group_id or not current.get("id"):
        return None
    current_id = str(current["id"])
    candidates: list[tuple[float, dict, dict, bool]] = []
    for item in context:
        item_id = str(item.get("id") or "")
        if not item_id or item_id == current_id:
            continue
        score = float(item.get("threadScore") or 0)
        evidence = item.get("threadEvidence") if isinstance(item.get("threadEvidence"), dict) else {}
        if score >= THREAD_AUTO_LINK_THRESHOLD:
            candidates.append((score, item, evidence, False))
    candidates.sort(key=lambda entry: entry[0], reverse=True)
    candidates = candidates[:THREAD_MAX_CANDIDATES]
    candidate_ids = [str(item.get("id")) for _, item, _, _ in candidates]
    feedback = await _latest_feedback(db, group_id, current_id, candidate_ids)
    filtered: list[tuple[float, dict, dict, bool]] = []
    for score, item, evidence, _ in candidates:
        item_id = str(item["id"])
        decision = feedback.get(_pair(current_id, item_id))
        if decision == "unlink":
            continue
        filtered.append((1.0 if decision == "link" else score, item, evidence, decision == "link"))
    # A positive user link may intentionally connect messages that did not
    # pass the automatic gate. Load it as an additional explicit candidate.
    try:
        positive_rows = await db.fetch(
            """SELECT CASE WHEN message_id=$2::uuid THEN related_message_id::text ELSE message_id::text END AS id
               FROM conversation_relation_feedback
               WHERE group_id=$1 AND decision='link'
                 AND (message_id=$2::uuid OR related_message_id=$2::uuid)
               ORDER BY created_at DESC LIMIT $3""",
            group_id, current_id, THREAD_MAX_CANDIDATES,
        )
    except Exception:
        positive_rows = []
    known_ids = {str(item.get("id")) for _, item, _, _ in filtered}
    for row in positive_rows:
        related_id = str(row["id"])
        if related_id in known_ids:
            continue
        item = next((candidate for candidate in context if str(candidate.get("id")) == related_id), None)
        if item:
            filtered.append((1.0, item, {"userFeedback": "link"}, True))
            known_ids.add(related_id)
    if not filtered:
        return None

    selected_ids = [current_id, *(str(item.get("id")) for _, item, _, _ in filtered)]
    assignments = await _thread_assignments(db, selected_ids)
    thread_id = (assignments.get(current_id) or [None])[0]
    if not thread_id:
        for _, item, _, _ in filtered:
            thread_id = (assignments.get(str(item.get("id"))) or [None])[0]
            if thread_id:
                break
    if not thread_id:
        row = await db.fetchrow(
            """INSERT INTO conversation_threads(group_id, title, confidence, first_message_at, last_message_at)
               VALUES ($1,$2,$3,$4,$4) RETURNING id::text""",
            group_id, _thread_title(current, analysis), max(score for score, _, _, _ in filtered), current.get("receivedAt"),
        )
        thread_id = str(row["id"])

    for score, item, evidence, user_link in filtered:
        item_id = str(item["id"])
        left, right = _pair(current_id, item_id)
        await db.execute(
            """INSERT INTO message_relations(source_message_id, target_message_id, group_id, relation_type, confidence, source, evidence)
               VALUES ($1::uuid,$2::uuid,$3,'same_thread',$4,$5,$6::jsonb)
               ON CONFLICT (source_message_id,target_message_id,relation_type) DO UPDATE SET
                 confidence=CASE WHEN message_relations.source='user' THEN message_relations.confidence ELSE GREATEST(message_relations.confidence, EXCLUDED.confidence) END,
                 source=CASE WHEN message_relations.source='user' THEN 'user' ELSE EXCLUDED.source END,
                 evidence=CASE WHEN message_relations.source='user' THEN message_relations.evidence ELSE EXCLUDED.evidence END,
                 updated_at=NOW()""",
            left, right, group_id, score, "user" if user_link else "heuristic", json.dumps(evidence),
        )
        await db.execute(
            """INSERT INTO conversation_thread_messages(thread_id, message_id, role, confidence, source, evidence)
               VALUES ($1::uuid,$2::uuid,'context',$3,$4,$5::jsonb)
               ON CONFLICT (thread_id,message_id) DO UPDATE SET
                 confidence=GREATEST(conversation_thread_messages.confidence, EXCLUDED.confidence),
                 source=CASE WHEN conversation_thread_messages.source='user' THEN 'user' ELSE EXCLUDED.source END,
                 evidence=CASE WHEN conversation_thread_messages.source='user' THEN conversation_thread_messages.evidence ELSE EXCLUDED.evidence END,
                 updated_at=NOW()""",
            thread_id, item_id, score, "user" if user_link else "heuristic", json.dumps(evidence),
        )

    current_score = max(score for score, _, _, _ in filtered)
    await db.execute(
        """INSERT INTO conversation_thread_messages(thread_id, message_id, role, confidence, source, evidence)
           VALUES ($1::uuid,$2::uuid,'root',$3,'heuristic','{}'::jsonb)
           ON CONFLICT (thread_id,message_id) DO UPDATE SET
             confidence=GREATEST(conversation_thread_messages.confidence, EXCLUDED.confidence),
             source=CASE WHEN conversation_thread_messages.source='user' THEN 'user' ELSE EXCLUDED.source END,
             evidence=CASE WHEN conversation_thread_messages.source='user' THEN conversation_thread_messages.evidence ELSE EXCLUDED.evidence END,
             updated_at=NOW()""",
        thread_id, current_id, current_score,
    )

    current_time = _as_datetime(current.get("receivedAt"))
    await db.execute(
        """UPDATE conversation_threads SET title=CASE WHEN btrim(title)='' THEN $2 ELSE title END,
             confidence=GREATEST(confidence,$3),
             first_message_at=LEAST(COALESCE(first_message_at,$4),$4),
             last_message_at=GREATEST(COALESCE(last_message_at,$4),$4), updated_at=NOW()
           WHERE id=$1::uuid""",
        thread_id, _thread_title(current, analysis), current_score, current_time,
    )
    return thread_id


async def apply_thread_feedback(db, group_id: str, message_id: str, related_message_id: str, decision: str) -> None:
    """Apply a user's link/unlink decision without deleting the feedback history."""
    if not group_id or not message_id or not related_message_id or message_id == related_message_id:
        return
    left, right = _pair(message_id, related_message_id)
    if decision == "unlink":
        await db.execute(
            """DELETE FROM message_relations
               WHERE group_id=$1 AND relation_type='same_thread'
                 AND source_message_id=$2::uuid AND target_message_id=$3::uuid""",
            group_id, left, right,
        )
        # Remove only the directly rejected member when it has no remaining
        # active relation to another member of that thread.
        await db.execute(
            """DELETE FROM conversation_thread_messages member
               WHERE member.message_id=$2::uuid
                 AND EXISTS (SELECT 1 FROM conversation_thread_messages anchor
                             WHERE anchor.thread_id=member.thread_id AND anchor.message_id=$3::uuid)
                 AND NOT EXISTS (
                   SELECT 1 FROM message_relations relation
                   JOIN conversation_thread_messages other ON other.thread_id=member.thread_id
                   WHERE relation.group_id=$1 AND relation.relation_type='same_thread'
                     AND other.message_id <> $3::uuid
                     AND ((relation.source_message_id=$2::uuid AND relation.target_message_id=other.message_id)
                       OR (relation.target_message_id=$2::uuid AND relation.source_message_id=other.message_id)))""",
            group_id, related_message_id, message_id,
        )
        return

    rows = await db.fetch(
        """SELECT id::text, group_id, text, received_at, sender_jid, wa_message_id
           FROM messages WHERE id=ANY($1::uuid[]) AND group_id=$2""",
        [message_id, related_message_id], group_id,
    )
    by_id = {str(row["id"]): dict(row) for row in rows}
    if message_id not in by_id or related_message_id not in by_id:
        return
    message = by_id[message_id]
    related = by_id[related_message_id]
    assignments = await _thread_assignments(db, [message_id, related_message_id])
    thread_id = (assignments.get(message_id) or assignments.get(related_message_id) or [None])[0]
    if not thread_id:
        row = await db.fetchrow(
            """INSERT INTO conversation_threads(group_id,title,confidence,first_message_at,last_message_at)
               VALUES ($1,$2,1,$3,$3) RETURNING id::text""",
            group_id, _thread_title(message), message.get("received_at"),
        )
        thread_id = str(row["id"])
    await db.execute(
        """INSERT INTO message_relations(source_message_id,target_message_id,group_id,relation_type,confidence,source,evidence)
           VALUES ($1::uuid,$2::uuid,$3,'same_thread',1,'user','{"userFeedback":"link"}'::jsonb)
           ON CONFLICT (source_message_id,target_message_id,relation_type) DO UPDATE SET confidence=1,source='user',evidence='{"userFeedback":"link"}'::jsonb,updated_at=NOW()""",
        *_pair(message_id, related_message_id), group_id,
    )
    for item_id in (message_id, related_message_id):
        await db.execute(
            """INSERT INTO conversation_thread_messages(thread_id,message_id,role,confidence,source,evidence)
               VALUES ($1::uuid,$2::uuid,'context',1,'user','{"userFeedback":"link"}'::jsonb)
               ON CONFLICT (thread_id,message_id) DO UPDATE SET confidence=1,source='user',evidence='{"userFeedback":"link"}'::jsonb,updated_at=NOW()""",
            thread_id, item_id,
        )
    await db.execute(
        """UPDATE conversation_threads SET confidence=1, first_message_at=LEAST(COALESCE(first_message_at,$2),$2),
             last_message_at=GREATEST(COALESCE(last_message_at,$3),$3), updated_at=NOW() WHERE id=$1::uuid""",
        thread_id, message.get("received_at"), related.get("received_at"),
    )
