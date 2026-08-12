-- Persist WhatsApp LID/phone/contact-name mappings so group messages remain
-- readable after a connector worker rotates or restarts.
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  account_id UUID NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  identity_jid TEXT NOT NULL,
  phone_jid TEXT,
  display_name TEXT,
  notify_name TEXT,
  verified_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, identity_jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_phone
  ON whatsapp_contacts (account_id, phone_jid);

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_contacts TO wagi_app;
