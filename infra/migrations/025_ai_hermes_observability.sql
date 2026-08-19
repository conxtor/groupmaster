-- Persisted, low-cardinality observability for optional Hermes usage.
-- One row represents one minute, trigger, operation and outcome. This keeps
-- long-running installations compact while retaining enough information for
-- the administrator view and rate-limit diagnosis.
CREATE TABLE IF NOT EXISTS ai_hermes_usage (
    bucket_start TIMESTAMPTZ NOT NULL,
    trigger TEXT NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    candidate_count BIGINT NOT NULL DEFAULT 0,
    logical_requests BIGINT NOT NULL DEFAULT 0,
    http_attempts BIGINT NOT NULL DEFAULT 0,
    error_count BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket_start, trigger, operation, outcome)
);

CREATE INDEX IF NOT EXISTS idx_ai_hermes_usage_bucket
    ON ai_hermes_usage (bucket_start DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_hermes_usage TO wagi_app;
