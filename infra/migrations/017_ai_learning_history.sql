-- Append-only audit trail for AI learning activity. This keeps the current
-- term table compact while making time-based learning metrics possible.
CREATE TABLE IF NOT EXISTS ai_learning_term_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id UUID REFERENCES ai_learning_terms(id) ON DELETE SET NULL,
  group_id TEXT REFERENCES wa_groups(id) ON DELETE SET NULL,
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  category TEXT NOT NULL CHECK (category IN ('relevance', 'event', 'place', 'keyword', 'exclusion')),
  term TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'feedback', 'inferred', 'admin_update', 'deleted')),
  weight_delta NUMERIC(8,4) NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'system',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_history_category_time
  ON ai_learning_term_history (category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_learning_history_term_time
  ON ai_learning_term_history (term_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_learning_term_history TO wagi_app;

-- Preserve a baseline for terms that already existed before this audit trail
-- was introduced. Their original term creation timestamp is retained.
INSERT INTO ai_learning_term_history
  (term_id, group_id, language, category, term, event_type, weight_delta, source, occurred_at)
SELECT t.id, t.group_id, t.language, t.category, t.term, 'created', t.weight, t.source, t.created_at
FROM ai_learning_terms t
WHERE NOT EXISTS (
  SELECT 1 FROM ai_learning_term_history h WHERE h.term_id=t.id AND h.event_type='created'
);
