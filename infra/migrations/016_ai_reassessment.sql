-- Isolated, administrator-triggered AI reassessment jobs.
-- The job references persisted message/media metadata only. It never asks a
-- connector or media worker to download or transcribe anything again.

CREATE TABLE IF NOT EXISTS ai_reassessment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_reassessment_jobs_status
  ON ai_reassessment_jobs (status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_reassessment_jobs TO wagi_app;
