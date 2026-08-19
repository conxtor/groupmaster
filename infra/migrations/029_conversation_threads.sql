-- Conversation threads for messages that are related without an explicit
-- reply. The data is deliberately group-scoped and explainable so a user can
-- correct an automatic relation without affecting another group.

CREATE TABLE IF NOT EXISTS conversation_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_thread_messages (
  thread_id UUID NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'context' CHECK (role IN ('root', 'context', 'reply')),
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'heuristic' CHECK (source IN ('heuristic', 'user', 'llm')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_relations (
  source_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('same_thread', 'continues', 'updates', 'supports', 'contradicts')),
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'heuristic' CHECK (source IN ('heuristic', 'user', 'llm')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_message_id, target_message_id, relation_type),
  CHECK (source_message_id <> target_message_id)
);

CREATE TABLE IF NOT EXISTS conversation_relation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  related_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('link', 'unlink')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (message_id <> related_message_id)
);

ALTER TABLE ai_feedback DROP CONSTRAINT IF EXISTS ai_feedback_target_type_check;
ALTER TABLE ai_feedback ADD CONSTRAINT ai_feedback_target_type_check
  CHECK (target_type IN ('relevance', 'event', 'place', 'knowledge', 'thread'));

CREATE INDEX IF NOT EXISTS idx_conversation_threads_group_updated
  ON conversation_threads(group_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_thread_messages_message
  ON conversation_thread_messages(message_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_thread_messages_thread
  ON conversation_thread_messages(thread_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_message_relations_group
  ON message_relations(group_id, relation_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_relations_source
  ON message_relations(source_message_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_message_relations_target
  ON message_relations(target_message_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_conversation_relation_feedback_pair
  ON conversation_relation_feedback(group_id, message_id, related_message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_relation_feedback_group
  ON conversation_relation_feedback(group_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_threads, conversation_thread_messages, message_relations, conversation_relation_feedback TO wagi_app;
