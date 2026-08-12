-- Quality feedback and canonical terms for the local AI cascade.
-- Feedback is scoped to a message/group so regular users can only influence
-- results from groups they can read. The worker replays the affected message
-- after each feedback event.

CREATE TABLE IF NOT EXISTS ai_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('relevance', 'event', 'knowledge')),
  target_key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject', 'correct')),
  correction JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_message
  ON ai_feedback (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_group
  ON ai_feedback (group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_canonical_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  topic_key TEXT,
  kind TEXT NOT NULL DEFAULT 'knowledge' CHECK (kind IN ('entity', 'knowledge', 'event')),
  source_feedback_id UUID REFERENCES ai_feedback(id) ON DELETE SET NULL,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0.9 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_canonical_alias_group_alias_kind
  ON ai_canonical_aliases (group_id, LOWER(alias), kind);
CREATE INDEX IF NOT EXISTS idx_ai_canonical_aliases_group
  ON ai_canonical_aliases (group_id, updated_at DESC);

-- Small, explainable knowledge graph. It intentionally stores only
-- co-mention/association edges derived from the same source messages; it is
-- not a free-form inference graph.
CREATE TABLE IF NOT EXISTS ai_knowledge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('co-mentioned', 'associated-with', 'mentioned-in-event')),
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, source_key, target_key, relation)
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_edges_group
  ON ai_knowledge_edges (group_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_feedback, ai_canonical_aliases, ai_knowledge_edges TO wagi_app;
