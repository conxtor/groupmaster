-- The Supabase Postgres image used by Compose provides PostGIS and pgvector.
-- Keeping extension activation in the image avoids ownership mismatches in its bootstrap catalog.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wagi_app') THEN
    CREATE ROLE wagi_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE app TO wagi_app;
GRANT USAGE ON SCHEMA public TO wagi_app;

CREATE TABLE IF NOT EXISTS wa_groups (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  owner_jid TEXT,
  participant_count INTEGER NOT NULL DEFAULT 0,
  is_selected BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  wa_message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  sender_name TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  has_media BOOLEAN NOT NULL DEFAULT FALSE,
  media_key TEXT,
  media_mime TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, wa_message_id)
);

CREATE TABLE IF NOT EXISTS audio_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  media_mime TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  transcript TEXT,
  language TEXT,
  confidence NUMERIC(5,4),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_analyses (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  relevant BOOLEAN NOT NULL,
  relevance_score NUMERIC(5,4) NOT NULL,
  summary TEXT NOT NULL,
  facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  places JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding VECTOR(1536),
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_group_received ON messages(group_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_status ON audio_jobs(status);
CREATE INDEX IF NOT EXISTS idx_analyses_relevant ON message_analyses(relevant, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_embedding ON message_analyses USING hnsw (embedding vector_cosine_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wagi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wagi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wagi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wagi_app;
