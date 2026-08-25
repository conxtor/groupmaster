-- Per-account/per-group synchronization state.
--
-- A seven-day history load is an onboarding operation for a newly selected
-- group. Normal connector leases use the persisted provider cursor and must
-- not repeatedly perform that initial backfill.

ALTER TABLE connector_cursors
  ADD COLUMN IF NOT EXISTS initial_backfill_required BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS initial_backfill_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS initial_backfill_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_mode TEXT NOT NULL DEFAULT 'initial_backfill',
  ADD COLUMN IF NOT EXISTS last_provider_fetched INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_persisted_new INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_duplicates INTEGER NOT NULL DEFAULT 0;

-- Existing cursors already represent a completed receive position. They must
-- not trigger a new seven-day scan after this migration is deployed.
UPDATE connector_cursors
SET initial_backfill_required = FALSE,
    initial_backfill_completed_at = COALESCE(initial_backfill_completed_at, updated_at),
    last_sync_mode = CASE WHEN last_sync_mode = 'initial_backfill' THEN 'incremental' ELSE last_sync_mode END
WHERE initial_backfill_required = TRUE
  AND (
    NULLIF(last_external_message_id, '') IS NOT NULL
    OR last_received_at IS NOT NULL
    OR COALESCE(last_sequence_no, 0) > 0
  );

CREATE INDEX IF NOT EXISTS idx_connector_cursors_initial_backfill
  ON connector_cursors (account_id, initial_backfill_required, updated_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_cursors TO wagi_app;
