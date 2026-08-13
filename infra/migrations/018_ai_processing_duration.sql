-- Track active AI worker time separately from queue and retry time.
-- processing_duration_ms accumulates only intervals between a job claim and
-- completion/failure. processing_started_at is cleared when an attempt ends.
ALTER TABLE ai_jobs
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_duration_ms BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_jobs_processing_started
  ON ai_jobs (status, processing_started_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_jobs TO wagi_app;
