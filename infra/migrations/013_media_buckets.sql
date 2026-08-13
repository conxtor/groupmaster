-- Media bucket routing.
-- The API start-up migration fills this column while moving legacy objects.
-- Keeping the routing metadata in PostgreSQL makes the migration idempotent
-- and allows the start-up migration to be removed independently later.
ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS bucket TEXT;

CREATE INDEX IF NOT EXISTS idx_media_objects_bucket ON media_objects(bucket);

GRANT SELECT, INSERT, UPDATE, DELETE ON media_objects TO wagi_app;
