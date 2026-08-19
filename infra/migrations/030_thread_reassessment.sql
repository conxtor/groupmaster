-- Administrator-triggered rebuild of the explainable conversation-thread graph.
-- Automatic relations can be recalculated without touching message analysis,
-- media jobs, connector queues or user-provided link/unlink decisions.

CREATE TABLE IF NOT EXISTS thread_reassessment_jobs (
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

CREATE INDEX IF NOT EXISTS idx_thread_reassessment_jobs_status
  ON thread_reassessment_jobs (status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON thread_reassessment_jobs TO wagi_app;
