-- Precision-first place extraction.
-- Geocoder results are cached so repeated group messages do not repeatedly
-- call an external service. Negative cache entries are intentional: an
-- unresolved candidate must not be retried on every AI pass.

CREATE TABLE IF NOT EXISTS ai_place_resolution_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  normalized_name TEXT NOT NULL,
  display_name TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((resolved = FALSE AND latitude IS NULL AND longitude IS NULL) OR (resolved = TRUE AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_place_resolution_cache_name
  ON ai_place_resolution_cache (language, normalized_name);
CREATE INDEX IF NOT EXISTS idx_ai_place_resolution_cache_updated
  ON ai_place_resolution_cache (updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_place_resolution_cache TO wagi_app;

-- Remove the old place-category fallbacks that were never place names. The
-- editable topic-keyword rows remain available as contextual cues; only the
-- system-seeded place category is cleaned up here. Admin and user-learned
-- terms are intentionally preserved.
DELETE FROM ai_learning_terms
WHERE category = 'place'
  AND source = 'system'
  AND lower(term) = ANY(ARRAY[
    'morgen', 'heute', 'mañana', 'hoy', 'demà', 'avui', 'tomorrow', 'today', 'demain', 'aujourd',
    'ort', 'standort', 'location', 'place', 'lugar', 'ubicación', 'ubicacio', 'lloc', 'lieu',
    'adresse', 'address', 'dirección', 'adreça', 'city', 'stadt', 'ville', 'ciudad', 'ciutat'
  ]);
