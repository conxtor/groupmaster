-- Generation-based KB rebuilds. A rebuild is assembled separately and becomes
-- visible only after all source messages were processed successfully.

CREATE TABLE IF NOT EXISTS knowledge_generation_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  active_generation_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO knowledge_generation_state (id, active_generation_id)
VALUES (TRUE, gen_random_uuid())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE knowledge_topics
  ADD COLUMN IF NOT EXISTS generation_id UUID;

UPDATE knowledge_topics
SET generation_id=(SELECT active_generation_id FROM knowledge_generation_state WHERE id=TRUE)
WHERE generation_id IS NULL;

ALTER TABLE knowledge_topics
  ALTER COLUMN generation_id SET NOT NULL;

DROP INDEX IF EXISTS uq_knowledge_topics_group_topic_subtopic;
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_topics_generation_group_topic_subtopic
  ON knowledge_topics (generation_id, group_id, topic_key, subtopic_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_active_generation
  ON knowledge_topics (generation_id, group_id, updated_at DESC);

ALTER TABLE knowledge_rebuild_jobs
  ADD COLUMN IF NOT EXISTS generation_id UUID;

ALTER TABLE ai_knowledge_edges
  ADD COLUMN IF NOT EXISTS generation_id UUID;

UPDATE ai_knowledge_edges
SET generation_id=(SELECT active_generation_id FROM knowledge_generation_state WHERE id=TRUE)
WHERE generation_id IS NULL;

ALTER TABLE ai_knowledge_edges
  ALTER COLUMN generation_id SET NOT NULL;

ALTER TABLE ai_knowledge_edges
  DROP CONSTRAINT IF EXISTS ai_knowledge_edges_group_id_source_key_target_key_relation_key;
DROP INDEX IF EXISTS uq_ai_knowledge_edges_group_source_target_relation;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_knowledge_edges_generation_group_source_target_relation
  ON ai_knowledge_edges (generation_id, group_id, source_key, target_key, relation);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_generation_state, knowledge_topics, knowledge_rebuild_jobs, ai_knowledge_edges TO wagi_app;
