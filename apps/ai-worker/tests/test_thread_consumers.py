"""Exercise the actual event/action/KB selectors with worker dependencies."""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from test_thread_consolidation import message
from thread_consolidation import annotate_consolidation, consolidate_messages, is_thread_context

HAS_WORKER_DEPS = all(importlib.util.find_spec(name) for name in ("asyncpg", "nats", "pydantic", "httpx"))


@unittest.skipUnless(HAS_WORKER_DEPS, "run in the AI-worker image for extraction tests")
class ThreadConsumerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import worker
        cls.worker = worker

    def test_events_cannot_use_reply_to_another_conversation(self):
        items = [message("a", "Meeting tomorrow at 18:00"), message("b", "Meeting tomorrow at 20:00", 1, replyToWaMessageId="elsewhere")]
        events = self.worker.multi_message_events("a", items)
        self.assertTrue(events)
        self.assertTrue(all("b" not in event.sourceMessageIds for event in events))

    def test_action_items_cannot_use_reply_to_another_conversation(self):
        items = [message("a", "Please send the invoice"), message("b", "Please reserve the restaurant", 1, replyToWaMessageId="elsewhere")]
        actions = self.worker.multi_message_action_items("a", items)
        self.assertTrue(actions)
        self.assertTrue(all("b" not in action.sourceMessageIds for action in actions))

    def test_kb_source_selection_obeys_thread_rejection(self):
        text = "The garage door motor replacement instructions and detailed repair documentation are available here."
        items = [message("a", text), message("b", text, 1, replyToWaMessageId="elsewhere", threadScore=0.9, threadBlocked=True)]
        self.assertEqual(self.worker.related_knowledge_source_ids("a", text, items, set()), ["a"])

    def test_conflicts_only_consider_consolidated_members(self):
        items = [message("a", "Meeting tomorrow at 18:00"), message("b", "Meeting tomorrow at 20:00", 1)]
        result = consolidate_messages(items, feedback=[{"message_id": "a", "related_message_id": "b", "decision": "unlink"}])
        annotate_consolidation("a", items, result)
        scoped = [row for row in items if is_thread_context("a", row, items)]
        self.assertEqual(self.worker.find_conflicts(scoped), [])
