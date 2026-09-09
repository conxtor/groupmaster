"""Optional real PostgreSQL tests, isolated in a disposable per-test schema."""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from conversation_threads import consolidate_thread_context, iter_thread_messages, load_thread_context
from thread_consolidation import is_thread_context
from test_thread_consolidation import message

DATABASE_URL = os.getenv("THREAD_TEST_DATABASE_URL")


@unittest.skipUnless(DATABASE_URL, "set THREAD_TEST_DATABASE_URL for PostgreSQL integration tests")
class ThreadStoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import asyncpg
        self.schema = "thread_test_" + uuid4().hex
        self.conn = await asyncpg.connect(DATABASE_URL)
        await self.conn.execute(f'CREATE SCHEMA "{self.schema}"')
        await self.conn.execute(f'SET search_path TO "{self.schema}", public')
        await self.conn.execute("""
            DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='wagi_app')
              THEN CREATE ROLE wagi_app; END IF; END $$;
            CREATE TABLE app_users (id uuid PRIMARY KEY);
            CREATE TABLE wa_groups (id text PRIMARY KEY);
            CREATE TABLE messages (
              id uuid PRIMARY KEY, group_id text REFERENCES wa_groups(id), wa_message_id text,
              sender_jid text, kind text DEFAULT 'text', text text, received_at timestamptz,
              deleted_at timestamptz, raw jsonb DEFAULT '{}', created_at timestamptz DEFAULT now()
            );
            CREATE TABLE audio_jobs(message_id uuid REFERENCES messages(id), transcript text,
              status text, updated_at timestamptz DEFAULT now());
            CREATE TABLE ai_feedback(target_type text);
            INSERT INTO wa_groups VALUES ('group-a'), ('group-b');
        """)
        migrations = Path(os.getenv("THREAD_TEST_MIGRATIONS_DIR") or str(Path(__file__).resolve().parents[3] / "infra" / "migrations"))
        await self.conn.execute((migrations / "029_conversation_threads.sql").read_text())
        self.user = uuid4()
        await self.conn.execute("INSERT INTO app_users VALUES($1)", self.user)
        self.pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=3, server_settings={"search_path": f'"{self.schema}",public'})

    async def asyncTearDown(self):
        await self.pool.close()
        await self.conn.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
        await self.conn.close()

    async def add(self, text, minutes=0, **kwargs):
        item = message(str(uuid4()), text, minutes, **kwargs)
        await self.conn.execute(
            """INSERT INTO messages(id,group_id,wa_message_id,sender_jid,text,received_at,raw)
               VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)""",
            item["id"], item["groupId"], item["waMessageId"], item["senderJid"], item["text"], item["receivedAt"], json.dumps(item.get("raw", {})),
        )
        return item

    async def reconcile(self, items):
        return await consolidate_thread_context(self.pool, items[0]["groupId"], items[0]["id"], items, set())

    async def snapshot(self):
        return await self.conn.fetch("SELECT thread_id::text,message_id::text,role,source,confidence FROM conversation_thread_messages ORDER BY thread_id,message_id")

    async def feedback(self, a, b, decision):
        await self.conn.execute(
            """INSERT INTO conversation_relation_feedback(user_id,group_id,message_id,related_message_id,decision)
               VALUES($1,$2,$3::uuid,$4::uuid,$5)""", self.user, a["groupId"], a["id"], b["id"], decision,
        )

    async def test_idempotency_concurrency_and_single_root(self):
        items = [await self.add("Garage door broken"), await self.add("Garage door repaired", 1)]
        await self.reconcile(items)
        before = await self.snapshot()
        self.assertEqual(len(before), 2)
        self.assertEqual(sum(row["role"] == "root" for row in before), 1)
        await asyncio.gather(*(self.reconcile(items) for _ in range(3)))
        self.assertEqual(await self.snapshot(), before)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM message_relations"), 1)

    async def test_negative_feedback_splits_existing_thread_without_cross_group_changes(self):
        a, b = await self.add("Garage door broken"), await self.add("Garage door repaired", 1)
        c = await self.add("Other discussion", 2)
        await self.feedback(a, c, "link")
        await self.reconcile([a, b, c])
        await self.feedback(a, b, "unlink")
        await self.feedback(b, c, "link")
        x = await self.add("Pool pump broken", groupId="group-b")
        y = await self.add("Pool pump repaired", 1, groupId="group-b")
        await self.reconcile([x, y])
        # Loading just A expands the old thread and its newest feedback.
        await self.reconcile([a])
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM conversation_relation_feedback"), 3)
        self.assertFalse(await self.conn.fetchval(
            """SELECT EXISTS(SELECT 1 FROM conversation_thread_messages a
               JOIN conversation_thread_messages b USING(thread_id)
               WHERE a.message_id=$1::uuid AND b.message_id=$2::uuid)""", a["id"], b["id"],
        ))
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM conversation_threads WHERE group_id='group-b'"), 1)

    async def test_live_edit_removes_obsolete_links_even_with_stale_reassessment_input(self):
        a, b = await self.add("Garage door broken"), await self.add("Garage door repaired", 1)
        await self.reconcile([a, b])
        await self.conn.execute("UPDATE messages SET text='Swimming pool hours' WHERE id=$1::uuid", b["id"])
        await self.reconcile([a, b])
        self.assertEqual(await self.snapshot(), [])
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM message_relations"), 0)

    async def test_transaction_failure_keeps_previous_thread(self):
        items = [await self.add("Garage door broken"), await self.add("Garage door repaired", 1)]
        await self.reconcile(items)
        before = await self.snapshot()
        await self.conn.execute("""
            CREATE FUNCTION fail_thread_insert() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'injected failure'; END $$;
            CREATE TRIGGER fail_insert BEFORE INSERT ON conversation_thread_messages
              FOR EACH ROW EXECUTE FUNCTION fail_thread_insert();
        """)
        with self.assertRaisesRegex(Exception, "injected failure"):
            await self.reconcile(items)
        self.assertEqual(await self.snapshot(), before)

    async def test_nearest_context_and_stored_audio_transcript(self):
        for index in range(24):
            await self.add(f"Old notice {index}", index)
        current = await self.add("Garage door broken", 600)
        audio = await self.add("[audio]", 601)
        await self.conn.execute("INSERT INTO audio_jobs VALUES($1::uuid,'Garage door repaired','completed',NOW())", audio["id"])
        context = await load_thread_context(self.pool, current, 2)
        self.assertEqual({row["id"] for row in context}, {current["id"], audio["id"]})
        resolved = await self.reconcile(context)
        self.assertEqual(sum(is_thread_context(current["id"], row, resolved) for row in resolved), 2)

    async def test_reply_parent_outside_window(self):
        parent = await self.add("Unusual meeting", -60 * 48)
        child = await self.add("OK", raw={"documentMessage": {"contextInfo": {"stanzaId": parent["waMessageId"]}}})
        await self.reconcile([child])
        self.assertEqual(len(await self.snapshot()), 2)

    async def test_deleted_message_does_not_remain_in_thread(self):
        a, b = await self.add("Garage door broken"), await self.add("Garage door repaired", 1)
        await self.reconcile([a, b])
        await self.conn.execute("UPDATE messages SET deleted_at=NOW() WHERE id=$1::uuid", b["id"])
        await self.reconcile([a])
        self.assertEqual(await self.snapshot(), [])

    async def test_context_limit_defers_instead_of_partially_overwriting_feedback(self):
        a, b = await self.add("Garage door broken"), await self.add("Garage door repaired", 1)
        await self.reconcile([a, b])
        before = await self.snapshot()
        c = await self.add("Manual followup", 2)
        await self.feedback(b, c, "link")
        with patch("conversation_threads.CONSOLIDATION_MAX_MESSAGES", 2):
            with self.assertLogs("wagi-ai-worker.threads", "WARNING") as captured:
                resolved = await self.reconcile([a])
        self.assertIn("context-limit", captured.output[0])
        self.assertEqual(await self.snapshot(), before)
        self.assertTrue(all(row["threadDeferred"] for row in resolved))
        self.assertEqual([row["id"] for row in resolved if is_thread_context(a["id"], row, resolved)], [a["id"]])

    async def test_reassessment_pages_tied_timestamps_and_excludes_new_arrivals(self):
        items = [await self.add(f"Notice {index}") for index in range(5)]
        cutoff = await self.conn.fetchval("SELECT NOW()")
        await self.add("New live arrival")
        result = [row async for row in iter_thread_messages(self.pool, cutoff, batch_size=2)]
        self.assertEqual({row["id"] for row in result}, {row["id"] for row in items})
        self.assertEqual(len(result), 5)


if __name__ == "__main__":
    unittest.main()
