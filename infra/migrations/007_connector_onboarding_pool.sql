-- Multi-user connector scheduling, per-user group selection and QR control.
-- This migration is safe to run after 006 on an existing installation.

ALTER TABLE user_group_access
  ADD COLUMN IF NOT EXISTS is_selected BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE wa_groups
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wa_groups_owner ON wa_groups (owner_user_id, platform, subject);

ALTER TABLE connector_leases
  ADD COLUMN IF NOT EXISTS lease_kind TEXT NOT NULL DEFAULT 'processing';

ALTER TABLE connector_leases
  DROP CONSTRAINT IF EXISTS connector_leases_lease_kind_check;
ALTER TABLE connector_leases
  ADD CONSTRAINT connector_leases_lease_kind_check
  CHECK (lease_kind IN ('processing', 'onboarding'));

CREATE INDEX IF NOT EXISTS idx_connector_leases_kind_active
  ON connector_leases (lease_kind, lease_until);

CREATE TABLE IF NOT EXISTS connector_qr_sessions (
  account_id UUID PRIMARY KEY REFERENCES connector_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'qr', 'connected', 'completed', 'expired', 'failed', 'cancelled')),
  qr_payload TEXT,
  expires_at TIMESTAMPTZ,
  worker_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_qr_sessions_expiry
  ON connector_qr_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS connector_onboarding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'connected', 'completed', 'failed', 'cancelled')),
  worker_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_onboarding_pending
  ON connector_onboarding_requests (account_id)
  WHERE status IN ('pending', 'claimed', 'connected');
CREATE INDEX IF NOT EXISTS idx_connector_onboarding_queue
  ON connector_onboarding_requests (platform, status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_qr_sessions, connector_onboarding_requests TO wagi_app;

-- Existing administrators keep the original global selection behaviour. New
-- users receive a user_group_access row when their connector discovers a group.
UPDATE user_group_access uga
SET is_selected = g.is_selected
FROM wa_groups g
WHERE g.id = uga.group_id AND uga.is_selected = FALSE AND g.is_selected = TRUE;
