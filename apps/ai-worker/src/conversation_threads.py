"""Transactional PostgreSQL storage for the local thread consolidator."""

from __future__ import annotations

import json
import logging
import re
from uuid import NAMESPACE_URL, uuid5

from thread_consolidation import (
    CONSOLIDATION_MAX_MESSAGES, THREAD_WINDOW_HOURS, VERSION, Consolidation,
    annotate_consolidation, as_datetime, consolidate_messages, identities,
    reply_target,
)

log = logging.getLogger("wagi-ai-worker.threads")

# Use existing transcripts, never request media processing for consolidation.
MESSAGE_SELECT = '''SELECT m.id::text AS id, m.group_id AS "groupId",
    m.wa_message_id AS "waMessageId", m.sender_jid AS "senderJid", m.kind,
    COALESCE(NULLIF(aj.transcript,''),m.text) AS text,
    m.received_at AS "receivedAt", m.deleted_at AS "deletedAt", m.raw
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT transcript FROM audio_jobs WHERE message_id=m.id
      AND status='completed' AND NULLIF(transcript,'') IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    ) aj ON TRUE'''


async def load_thread_context(db, current: dict, limit: int) -> list[dict]:
    """Select the nearest messages, not the first N in a wide time window."""
    rows = await db.fetch(
        MESSAGE_SELECT + ''' WHERE m.group_id=$1 AND m.deleted_at IS NULL
        AND m.received_at BETWEEN $2::timestamptz - ($3 * INTERVAL '1 hour')
                              AND $2::timestamptz + ($3 * INTERVAL '1 hour')
        ORDER BY ABS(EXTRACT(EPOCH FROM (m.received_at-$2::timestamptz))), m.id
        LIMIT $4''',
        current["groupId"], current["receivedAt"], THREAD_WINDOW_HOURS,
        min(limit, CONSOLIDATION_MAX_MESSAGES),
    )
    return [dict(row) for row in rows]


async def iter_thread_messages(db, cutoff, batch_size: int = 200):
    """Page the reassessment input without keeping every message/raw blob in RAM."""
    cursor = (None, None, None)
    while True:
        rows = await db.fetch(
            '''SELECT id::text AS id, group_id AS "groupId", received_at AS "receivedAt"
               FROM messages WHERE deleted_at IS NULL AND created_at <= $1
               AND ($2::text IS NULL OR (group_id,received_at,id) > ($2::text,$3::timestamptz,$4::uuid))
               ORDER BY group_id,received_at,id LIMIT $5''', cutoff, *cursor, batch_size,
        )
        if not rows:
            return
        for row in rows:
            yield dict(row)
        last = rows[-1]
        cursor = (last["groupId"], last["receivedAt"], last["id"])


async def _expand_context(conn, group_id: str, context: list[dict]) -> tuple[list[dict], bool]:
    """Load complete affected threads, feedback endpoints and reply parents.

    Defer persistence if the closure exceeds the limit instead of replacing
    half a manually linked thread. No user feedback is discarded.
    """
    items = {str(row["id"]): dict(row) for row in context if row.get("id") and row.get("groupId") == group_id}
    while items:
        related = await conn.fetch(
            '''SELECT DISTINCT member.message_id::text AS id
               FROM conversation_thread_messages seed
               JOIN conversation_thread_messages member ON member.thread_id=seed.thread_id
               JOIN conversation_threads t ON t.id=seed.thread_id AND t.group_id=$1
               WHERE seed.message_id=ANY($2::uuid[])
               UNION
               SELECT CASE WHEN f.message_id=ANY($2::uuid[]) THEN f.related_message_id::text ELSE f.message_id::text END
               FROM conversation_relation_feedback f
               JOIN messages a ON a.id=f.message_id AND a.deleted_at IS NULL
               JOIN messages b ON b.id=f.related_message_id AND b.deleted_at IS NULL
               WHERE f.group_id=$1 AND (f.message_id=ANY($2::uuid[]) OR f.related_message_id=ANY($2::uuid[]))
               LIMIT $3''', group_id, list(items), CONSOLIDATION_MAX_MESSAGES + 1,
        )
        wanted = {str(row["id"]) for row in related} - items.keys()
        refs = {target for row in items.values() if (target := reply_target(row))}
        known_refs = set().union(*(identities(row) for row in items.values()))
        missing_refs = refs - known_refs
        parents = await conn.fetch(
            '''SELECT id::text FROM messages WHERE group_id=$1 AND deleted_at IS NULL
               AND (wa_message_id=ANY($2::text[]) OR group_id || ':' || wa_message_id=ANY($2::text[])
                    OR id::text=ANY($2::text[])) LIMIT $3''',
            group_id, sorted(missing_refs), CONSOLIDATION_MAX_MESSAGES + 1,
        ) if missing_refs else []
        wanted.update(str(row["id"]) for row in parents if str(row["id"]) not in items)
        if len(items) + len(wanted) > CONSOLIDATION_MAX_MESSAGES:
            return list(items.values()), False
        if not wanted:
            return list(items.values()), True
        rows = await conn.fetch(MESSAGE_SELECT + ' WHERE m.group_id=$1 AND m.id=ANY($2::uuid[])', group_id, sorted(wanted))
        if not rows:
            return list(items.values()), True
        items.update((str(row["id"]), dict(row)) for row in rows)
    return [], True


async def consolidate_thread_context(db, group_id: str, current_id: str, context: list[dict], stopwords: set[str]) -> list[dict]:
    """Reconcile a window atomically, then annotate the accepted AI context.

    A group advisory lock serializes live, feedback and reassessment writers.
    Retries replace inferred state instead of monotonically raising scores.
    """
    async with db.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "thread-consolidation:" + group_id)
            # A queued reassessment may have read these rows before a live edit
            # or transcript update. Refresh after taking the writer lock.
            overrides = {str(row["id"]): row["_threadTextOverride"] for row in context if "_threadTextOverride" in row}
            rows = await conn.fetch(
                MESSAGE_SELECT + " WHERE m.group_id=$1 AND m.id=ANY($2::uuid[])",
                group_id, [str(row["id"]) for row in context if row.get("id")],
            )
            context = [dict(row) for row in rows]
            for row in context:
                if str(row["id"]) in overrides:
                    row["text"] = overrides[str(row["id"])]
            context, complete = await _expand_context(conn, group_id, context)
            ids = [str(row["id"]) for row in context]
            if not ids:
                return context
            feedback = await conn.fetch(
                '''SELECT message_id::text, related_message_id::text, decision
                   FROM conversation_relation_feedback
                   WHERE group_id=$1 AND message_id=ANY($2::uuid[]) AND related_message_id=ANY($2::uuid[])
                   ORDER BY created_at DESC, id DESC''', group_id, ids,
            )
            result = consolidate_messages(context, stopwords, [dict(row) for row in feedback])
            if complete:
                await _persist(conn, group_id, context, result)
            else:
                log.warning("thread consolidation deferred group=%s reason=context-limit messages=%d limit=%d", group_id, len(ids), CONSOLIDATION_MAX_MESSAGES)
                # Full constraints were not loaded. Do not infer a relationship
                # from a partial view or claim the old memberships were repaired.
                result = Consolidation([], {})
                for row in context:
                    row["threadDeferred"] = True
            return annotate_consolidation(current_id, context, result)


async def _persist(conn, group_id, context, result):
    ids = [str(row["id"]) for row in context]
    by_id = {str(row["id"]): row for row in context}
    old = await conn.fetch(
        '''SELECT t.id::text, array_agg(member.message_id::text ORDER BY member.message_id) AS members
           FROM conversation_threads t JOIN conversation_thread_messages member ON member.thread_id=t.id
           WHERE t.group_id=$1 AND t.id IN
             (SELECT thread_id FROM conversation_thread_messages WHERE message_id=ANY($2::uuid[]))
           GROUP BY t.id ORDER BY t.id''', group_id, ids,
    )
    # Reuse IDs by overlap so retries and reprocessing do not create new threads.
    available = {str(row["id"]): set(row["members"]) for row in old}
    assignments = []
    used = set()
    for members in result.clusters:
        choices = sorted(available, key=lambda key: (-len(available[key] & set(members)), key))
        thread_id = choices[0] if choices and available[choices[0]] & set(members) else str(uuid5(NAMESPACE_URL, f"conxtor:thread:{group_id}:{members[0]}"))
        if thread_id in used:
            thread_id = str(uuid5(NAMESPACE_URL, f"conxtor:thread:{group_id}:{':'.join(members)}"))
        used.add(thread_id)
        available.pop(thread_id, None)
        assignments.append((thread_id, members))
    await conn.execute(
        '''DELETE FROM message_relations WHERE group_id=$1 AND relation_type='same_thread'
           AND source_message_id=ANY($2::uuid[]) AND target_message_id=ANY($2::uuid[])''', group_id, ids,
    )
    await conn.execute(
        '''DELETE FROM conversation_thread_messages member USING conversation_threads t
           WHERE member.thread_id=t.id AND t.group_id=$1 AND member.message_id=ANY($2::uuid[])''', group_id, ids,
    )
    for (left, right), (score, evidence, source) in result.edges.items():
        await conn.execute(
            '''INSERT INTO message_relations(source_message_id,target_message_id,group_id,relation_type,confidence,source,evidence)
               VALUES ($1::uuid,$2::uuid,$3,'same_thread',$4,$5,$6::jsonb)''',
            left, right, group_id, score, source, json.dumps(evidence),
        )
    for thread_id, members in assignments:
        incident = {key: [value for edge, value in result.edges.items() if key in edge] for key in members}
        confidence = min(max(value[0] for value in incident[key]) for key in members)
        title = re.sub(r"\s+", " ", str(by_id[members[0]].get("text") or "")).strip()[:120] or "Conversation thread"
        dates = [date for key in members if (date := as_datetime(by_id[key].get("receivedAt")))]
        await conn.execute(
            '''INSERT INTO conversation_threads(id,group_id,title,confidence,first_message_at,last_message_at)
               VALUES ($1::uuid,$2,$3,$4,$5,$6)
               ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, confidence=EXCLUDED.confidence,
                 first_message_at=EXCLUDED.first_message_at,last_message_at=EXCLUDED.last_message_at,updated_at=NOW()''',
            thread_id, group_id, title, confidence, min(dates) if dates else None, max(dates) if dates else None,
        )
        for index, key in enumerate(members):
            strongest = max(incident[key], key=lambda value: value[0])
            source = "user" if any(value[2] == "user" for value in incident[key]) else "heuristic"
            evidence = {**strongest[1], "version": VERSION, "memberCount": len(members)}
            role = "root" if index == 0 else "reply" if reply_target(by_id[key]) else "context"
            await conn.execute(
                '''INSERT INTO conversation_thread_messages(thread_id,message_id,role,confidence,source,evidence)
                   VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)''',
                thread_id, key, role, strongest[0], source, json.dumps(evidence),
            )
    await conn.execute(
        '''DELETE FROM conversation_threads t WHERE t.group_id=$1
           AND NOT EXISTS (SELECT 1 FROM conversation_thread_messages member WHERE member.thread_id=t.id)''', group_id,
    )
    log.debug("threads consolidated group=%s messages=%d threads=%d edges=%d ambiguous=%d version=%s", group_id, len(ids), len(result.clusters), len(result.edges), len(result.ambiguous), VERSION)
