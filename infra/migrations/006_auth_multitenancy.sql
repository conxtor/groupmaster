-- Multi-user authentication, authorization, connector sessions and receive cursors.
-- Existing MVP data remains globally visible to administrators; regular users
-- receive access only through user_group_access rows.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_lower ON app_users (LOWER(email));

CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permissions (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_name TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  permission_name TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  PRIMARY KEY (role_name, permission_name)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role_name TEXT NOT NULL REFERENCES roles(name) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_name)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  remote_addr TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions (token_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS user_group_access (
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  can_read BOOLEAN NOT NULL DEFAULT TRUE,
  can_manage BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_user_group_access_group ON user_group_access (group_id, user_id);

CREATE TABLE IF NOT EXISTS connector_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'pairing', 'connecting', 'syncing', 'ready', 'paused', 'degraded', 'error', 'reauth_required', 'stopped')),
  external_account_id TEXT,
  session_data BYTEA,
  session_version BIGINT NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  last_connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_connector_accounts_schedule ON connector_accounts (platform, status, next_sync_at);

CREATE TABLE IF NOT EXISTS connector_auth_state (
  account_id UUID NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  key_namespace TEXT NOT NULL,
  key_name TEXT NOT NULL,
  value BYTEA NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, key_namespace, key_name)
);

CREATE TABLE IF NOT EXISTS connector_leases (
  account_id UUID PRIMARY KEY REFERENCES connector_accounts(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_leases_expiry ON connector_leases (lease_until);

CREATE TABLE IF NOT EXISTS connector_cursors (
  account_id UUID NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  last_external_message_id TEXT,
  last_received_at TIMESTAMPTZ,
  last_sequence_no BIGINT,
  update_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, group_id)
);

INSERT INTO roles (name, description) VALUES
  ('admin', 'Vollzugriff auf Nutzer, Gruppen, Medien und Administration'),
  ('user', 'Zugriff auf freigegebene Gruppen und Medien')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (name, description) VALUES
  ('dashboard.read', 'Dashboard und relevante Nachrichten lesen'),
  ('groups.read', 'Freigegebene Gruppen lesen'),
  ('groups.manage', 'Gruppenauswahl und Gruppenrechte verwalten'),
  ('media.read', 'Medien und sichere Download-URLs lesen'),
  ('connectors.manage', 'Eigene Connectoren verbinden und steuern'),
  ('users.manage', 'Nutzer, Rollen und Zugriffsrechte verwalten'),
  ('administration.read', 'Administrationsbereich lesen')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_name, permission_name)
SELECT 'user', name FROM permissions
WHERE name IN ('dashboard.read', 'groups.read', 'media.read', 'connectors.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_name, permission_name)
SELECT 'admin', name FROM permissions
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON app_users, roles, permissions, role_permissions, user_roles, user_sessions, user_group_access, connector_accounts, connector_auth_state, connector_leases, connector_cursors TO wagi_app;
