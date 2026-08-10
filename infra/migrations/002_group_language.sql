-- Persist the automatically detected dominant language of each selected source.
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS language TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_groups_language ON wa_groups (language);
