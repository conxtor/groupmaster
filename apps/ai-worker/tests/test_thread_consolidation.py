import itertools
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thread_consolidation import (
    annotate_consolidation, consolidate_messages, is_thread_context, pair,
    relation_score, reply_target,
)


def message(key, text, minutes=0, **kwargs):
    return {
        "id": key, "waMessageId": key, "groupId": "group-a", "text": text,
        "senderJid": key,
        "receivedAt": datetime(2026, 9, 9, 10, tzinfo=timezone.utc) + timedelta(minutes=minutes),
        **kwargs,
    }


def vote(a, b, decision):
    return {"message_id": a, "related_message_id": b, "decision": decision}


class ConsolidationTests(unittest.TestCase):
    def test_multilingual_followups_and_interleaved_topics(self):
        for first, second, unrelated in [
            ("Garagentor Motor defekt", "Garagentor Motor repariert", "Schwimmbad Öffnungszeiten geändert"),
            ("Puerta garaje averiada", "Puerta garaje reparada", "Piscina horario cambiado"),
            ("Porta garatge avariada", "Porta garatge reparada", "Piscina horari canviat"),
            ("Garage door broken", "Garage door repaired", "Swimming pool hours changed"),
            ("Porte garage cassée", "Porte garage réparée", "Piscine horaires modifiés"),
        ]:
            with self.subTest(first=first):
                items = [message("a", first), message("b", unrelated, 1), message("c", second, 2)]
                self.assertEqual(consolidate_messages(items).clusters, [["a", "c"]])
                # Irrelevant background messages must not erase a good match
                # when window-frequency weighting becomes active.
                background = [message(str(i), f"unrelated{chr(97 + i)} notice{chr(97 + i)}", i) for i in range(5)]
                self.assertIn(["a", "c"], consolidate_messages(items + background).clusters)

    def test_one_common_word_and_time_are_not_enough(self):
        items = [message("a", "Saturday mountain hike"), message("b", "Saturday works", 1), message("c", "Saturday garage repairs", 2)]
        self.assertEqual(consolidate_messages(items).clusters, [])

    def test_ambiguous_bridge_cannot_merge_two_discussions(self):
        items = [message("a", "Garage door motor repairs"), message("b", "Swimming pool water repairs", 1), message("c", "Garage door motor swimming pool water repairs", 2)]
        result = consolidate_messages(items)
        self.assertIn("c", result.ambiguous)
        self.assertEqual(result.clusters, [])

    def test_cohesion_prevents_transitive_topic_drift(self):
        items = [message("a", "alpha bravo charlie"), message("b", "alpha bravo charlie delta echo", 1), message("c", "charlie delta echo foxtrot", 2)]
        # A is similar to B; C has some overlap with B but none with A.
        result = consolidate_messages(items)
        self.assertFalse(any(len(cluster) == 3 for cluster in result.clusters))

    def test_explicit_short_reply_stays_with_parent(self):
        items = [message("a", "Mountain hiking route"), message("b", "OK", 1, replyToWaMessageId="a"), message("c", "Garage door motor", 2)]
        self.assertEqual(consolidate_messages(items).clusters, [["a", "b"]])

    def test_newest_feedback_wins_even_if_delivered_out_of_order(self):
        items = [message("a", "Garage door broken"), message("b", "Garage door repaired", 1)]
        self.assertEqual(consolidate_messages(items, feedback=[vote("b", "a", "unlink"), vote("a", "b", "link")]).clusters, [])
        self.assertEqual(consolidate_messages(items, feedback=[vote("b", "a", "link"), vote("a", "b", "unlink")]).clusters, [["a", "b"]])

    def test_unlink_is_a_transitive_constraint(self):
        items = [message("a", "first"), message("b", "second", 1), message("c", "third", 2)]
        result = consolidate_messages(items, feedback=[vote("a", "c", "unlink"), vote("a", "b", "link"), vote("b", "c", "link")])
        self.assertFalse(any("a" in members and "c" in members for members in result.clusters))
        self.assertIn(pair("a", "c"), result.blocked)

    def test_feedback_can_split_explicit_replies(self):
        items = [message("a", "first"), message("b", "second", 1, replyToWaMessageId="a")]
        self.assertEqual(consolidate_messages(items, feedback=[vote("a", "b", "unlink")]).clusters, [])

    def test_language_stopwords_and_phrases_come_from_database(self):
        items = [message("a", "Buenos dias muchas gracias"), message("b", "Buenos dias muchas gracias", 1)]
        self.assertEqual(consolidate_messages(items, {"buenos dias", "muchas", "gracias"}).clusters, [])

    def test_groups_and_deleted_messages_never_mix(self):
        items = [message("a", "Garage door broken"), message("b", "Garage door broken", 1, groupId="other", replyToWaMessageId="a"), message("c", "Garage door broken", 2, deletedAt="2026-09-09")]
        self.assertEqual(consolidate_messages(items, feedback=[vote("a", "b", "link")]).clusters, [])

    def test_late_and_missing_timestamps_do_not_create_automatic_links(self):
        a = message("a", "Garage door motor")
        for b in [message("b", a["text"], 60 * 24), message("b", a["text"], receivedAt=None)]:
            self.assertEqual(relation_score(a, b)[0], 0)
        self.assertEqual(consolidate_messages([a, message("b", "OK", 60 * 24, replyToWaMessageId="a")]).clusters, [["a", "b"]])

    def test_exact_url_is_supporting_evidence(self):
        items = [message("a", "https://example.org/garage/manual.pdf"), message("b", "https://example.org/garage/manual.pdf", 1)]
        self.assertEqual(consolidate_messages(items).clusters, [["a", "b"]])

    def test_order_independent_grouping(self):
        items = [message("a", "Garage door broken"), message("b", "Garage door repaired", 1), message("c", "Swimming pool closed", 2)]
        for permutation in itertools.permutations(items):
            self.assertEqual(consolidate_messages(list(permutation)).clusters, [["a", "b"]])

    def test_unrelated_reply_and_rejected_edge_cannot_enter_ai_context(self):
        items = [message("a", "Mountain hike tomorrow"), message("b", "Garage door motor", 1), message("c", "At 18:00", 2, replyToWaMessageId="b")]
        annotated = annotate_consolidation("a", items, consolidate_messages(items))
        self.assertEqual([row["id"] for row in annotated if is_thread_context("a", row, annotated)], ["a"])
        # Even the fallback handles only actual replies to the current message.
        self.assertFalse(is_thread_context("a", message("c", "At 18:00", replyToWaMessageId="b"), items))

    def test_reply_formats_whatsmeow_baileys_gotd_and_documents(self):
        for raw in [
            {"extendedTextMessage": {"contextInfo": {"stanzaId": "parent"}}},
            {"message": {"documentMessage": {"contextInfo": {"stanzaId": "parent"}}}},
            {"ephemeralMessage": {"message": {"audioMessage": {"contextInfo": {"stanzaId": "parent"}}}}},
        ]:
            self.assertEqual(reply_target(message("a", "", raw=raw)), "parent")
        for raw in [{"ReplyTo": {"ReplyToMsgID": 21}}, {"reply_to_message": {"message_id": 21}}]:
            self.assertEqual(reply_target(message("a", "", raw=raw)), "group-a:21")

    def test_telegram_forum_topic_membership_is_not_a_conversation_reply(self):
        root = message("a", "Topic announcement", groupId="tg:123:topic:21", waMessageId="tg:123:topic:21:21")
        child = message("b", "Unrelated discussion", groupId=root["groupId"], raw={"ReplyTo": {"ForumTopic": True, "ReplyToMsgID": 21}})
        self.assertIsNone(reply_target(child))
        self.assertEqual(consolidate_messages([root, child]).clusters, [])
        child["raw"]["ReplyTo"]["ReplyToMsgID"] = 45
        self.assertEqual(reply_target(child), "tg:123:topic:21:45")


if __name__ == "__main__":
    unittest.main()
