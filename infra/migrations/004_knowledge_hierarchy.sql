-- Hierarchical knowledge entries: each topic can contain summary entries with
-- source contributions nested below them. Existing rows remain valid and are
-- rebuilt by the versioned AI worker on its next start.

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS parent_item_id UUID REFERENCES knowledge_items(id) ON DELETE CASCADE;

ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS item_role TEXT NOT NULL DEFAULT 'summary';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_items_item_role_check'
  ) THEN
    ALTER TABLE knowledge_items
      ADD CONSTRAINT knowledge_items_item_role_check
      CHECK (item_role IN ('summary', 'detail'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_knowledge_items_parent
  ON knowledge_items (topic_id, parent_item_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_items TO wagi_app;
