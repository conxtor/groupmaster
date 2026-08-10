-- The Supabase Postgres image used by Compose provides PostGIS and pgvector,
-- but both must be enabled before the schema or later location work uses them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

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
  platform TEXT NOT NULL DEFAULT 'whatsapp',
  chat_type TEXT NOT NULL DEFAULT 'group',
  external_chat_id TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS chat_type TEXT NOT NULL DEFAULT 'group';
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS external_chat_id TEXT;
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS parent_group_id TEXT;
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS topic_id BIGINT;
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS topic_root_message_id BIGINT;
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS language TEXT;
UPDATE wa_groups SET platform = 'telegram', external_chat_id = REPLACE(id, 'tg:', '') WHERE id LIKE 'tg:%' AND platform = 'whatsapp';
CREATE INDEX IF NOT EXISTS idx_wa_groups_selection ON wa_groups (platform, is_selected, subject);
CREATE INDEX IF NOT EXISTS idx_wa_groups_parent ON wa_groups (parent_group_id, is_selected, subject);
CREATE INDEX IF NOT EXISTS idx_wa_groups_language ON wa_groups (language);

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

CREATE TABLE IF NOT EXISTS knowledge_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, topic_key)
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (topic_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_messages_group_received ON messages(group_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_status ON audio_jobs(status);
CREATE INDEX IF NOT EXISTS idx_analyses_relevant ON message_analyses(relevant, relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_embedding ON message_analyses USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_group ON knowledge_topics(group_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_topic ON knowledge_items(topic_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wagi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wagi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wagi_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wagi_app;

-- Phase 1 beta schema. Kept in this initial migration so a fresh database
-- receives the complete MVP schema in one pass.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_chat_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence_no BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS object_path TEXT;

ALTER TABLE message_analyses ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0';
ALTER TABLE message_analyses ADD COLUMN IF NOT EXISTS prompt_version TEXT NOT NULL DEFAULT 'heuristic-v1';
ALTER TABLE message_analyses ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE message_analyses ADD COLUMN IF NOT EXISTS conflicts JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS message_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
  text TEXT,
  raw JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, revision_no)
);

CREATE TABLE IF NOT EXISTS media_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  object_key TEXT,
  thumbnail_key TEXT,
  object_path TEXT,
  thumbnail_path TEXT,
  mime TEXT,
  bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'deleted')),
  error TEXT,
  ocr_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, media_key)
);

CREATE TABLE IF NOT EXISTS connector_states (
  connector TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  last_error TEXT,
  qr TEXT,
  connected_at TIMESTAMPTZ,
  first_activated_at TIMESTAMPTZ,
  initial_backfill_started_at TIMESTAMPTZ,
  initial_backfill_completed_at TIMESTAMPTZ,
  initial_backfill_days INTEGER NOT NULL DEFAULT 7,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE connector_states ADD COLUMN IF NOT EXISTS first_activated_at TIMESTAMPTZ;
ALTER TABLE connector_states ADD COLUMN IF NOT EXISTS initial_backfill_started_at TIMESTAMPTZ;
ALTER TABLE connector_states ADD COLUMN IF NOT EXISTS initial_backfill_completed_at TIMESTAMPTZ;
ALTER TABLE connector_states ADD COLUMN IF NOT EXISTS initial_backfill_days INTEGER NOT NULL DEFAULT 7;

CREATE INDEX IF NOT EXISTS idx_messages_platform_chat ON messages(platform, external_chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_content_hash ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(group_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_audio_jobs_status_retry ON audio_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_message_revisions_message ON message_revisions(message_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_media_objects_message ON media_objects(message_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_revisions, media_objects, connector_states TO wagi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_topics, knowledge_items TO wagi_app;
