-- Persistent tombstones for learning terms removed by an administrator.
-- A deleted term must not be inferred again or sent to Hermes merely because
-- it appears in a later message. A later explicit admin creation may clear
-- the tombstone and intentionally restore the term.
CREATE TABLE IF NOT EXISTS ai_learning_term_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT REFERENCES wa_groups(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  category TEXT NOT NULL CHECK (category IN ('relevance', 'event', 'place', 'keyword', 'exclusion')),
  topic_key TEXT,
  term TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(btrim(term)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_learning_term_exclusions_scope
  ON ai_learning_term_exclusions (
    COALESCE(group_id, ''), language, category, COALESCE(topic_key, ''), lower(term)
  );

CREATE INDEX IF NOT EXISTS idx_ai_learning_term_exclusions_lookup
  ON ai_learning_term_exclusions (language, category, group_id, lower(term));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_learning_term_exclusions TO wagi_app;
