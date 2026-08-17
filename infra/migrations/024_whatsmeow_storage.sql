-- whatsmeow stores encrypted device keys and signal state in PostgreSQL.
-- A separate schema keeps this library-owned state isolated and makes a
-- future connector replacement/removal straightforward.
CREATE SCHEMA IF NOT EXISTS wa_whatsmeow;
GRANT USAGE, CREATE ON SCHEMA wa_whatsmeow TO wagi_app;
