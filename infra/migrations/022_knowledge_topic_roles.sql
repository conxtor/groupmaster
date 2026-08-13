-- Data-driven signal roles for KB topics. This keeps location-specific
-- evidence in the database instead of embedding a standard topic key in the
-- AI worker.

ALTER TABLE knowledge_topic_definitions
  ADD COLUMN IF NOT EXISTS signal_type TEXT NOT NULL DEFAULT 'content';

ALTER TABLE knowledge_topic_definitions
  DROP CONSTRAINT IF EXISTS knowledge_topic_definitions_signal_type_check;
ALTER TABLE knowledge_topic_definitions
  ADD CONSTRAINT knowledge_topic_definitions_signal_type_check
  CHECK (signal_type IN ('content', 'location', 'entity'));

UPDATE knowledge_topic_definitions
SET signal_type='location', updated_at=NOW()
WHERE topic_key='places' AND signal_type <> 'location';

UPDATE knowledge_topic_definitions
SET signal_type='entity', updated_at=NOW()
WHERE topic_key='entities' AND signal_type <> 'entity';

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_topic_definitions TO wagi_app;
