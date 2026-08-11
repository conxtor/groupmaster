-- Hybrid AI retrieval support: multilingual-e5-small produces 384-dimensional vectors.
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS embedding VECTOR(384);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_embedding
  ON knowledge_items USING hnsw (embedding vector_cosine_ops);
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_items TO wagi_app;
