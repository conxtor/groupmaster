-- Historical observability records for connector pool usage.
-- The current connector_leases row remains the source of truth for scheduling;
-- this table keeps a compact audit trail after a worker releases its slot.

CREATE TABLE IF NOT EXISTS connector_lease_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  lease_kind TEXT NOT NULL CHECK (lease_kind IN ('processing', 'onboarding')),
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_connector_lease_history_recent
  ON connector_lease_history (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_lease_history_account
  ON connector_lease_history (account_id, ended_at, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_lease_history TO wagi_app;

-- Preserve leases that are already active when this migration is introduced.
-- Their start time is approximated by the current lease row's last update.
INSERT INTO connector_lease_history (account_id, user_id, platform, lease_kind, worker_id, started_at, lease_until, last_seen_at)
SELECT l.account_id, ca.user_id, ca.platform, l.lease_kind, l.worker_id, l.updated_at, l.lease_until, l.updated_at
FROM connector_leases l
JOIN connector_accounts ca ON ca.id=l.account_id
WHERE NOT EXISTS (
  SELECT 1 FROM connector_lease_history h
  WHERE h.account_id=l.account_id AND h.worker_id=l.worker_id AND h.ended_at IS NULL
);
