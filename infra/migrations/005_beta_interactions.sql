-- Phase 1 beta interaction support. These indexes keep the new dashboard
-- filters and audio status queries bounded without changing existing rows.
CREATE INDEX IF NOT EXISTS idx_audio_jobs_message_updated
  ON audio_jobs (message_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audio_jobs_failed_updated
  ON audio_jobs (status, updated_at DESC)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_messages_received_desc
  ON messages (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_analyses_events
  ON message_analyses USING gin (events);

CREATE INDEX IF NOT EXISTS idx_message_analyses_places
  ON message_analyses USING gin (places);

GRANT SELECT, INSERT, UPDATE, DELETE ON audio_jobs, message_analyses TO wagi_app;
