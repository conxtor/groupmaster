-- Email verification, localized authentication and password reset tokens.
-- Existing accounts are treated as verified so a migration does not lock out
-- the bootstrap administrator or users created before email verification.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS preferred_locale TEXT NOT NULL DEFAULT 'de',
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

UPDATE app_users
SET email_verified_at = COALESCE(email_verified_at, created_at)
WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL DEFAULT 'de',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_lookup
  ON auth_email_tokens (token_hash, purpose, expires_at)
  WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_email_tokens_user
  ON auth_email_tokens (user_id, purpose, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_email_tokens TO wagi_app;
