-- Administrator-managed knowledge topic definitions, generated subtopics and
-- isolated rebuild jobs. Existing generated knowledge topics remain valid:
-- root rows use an empty subtopic_key, generated rows reference their root.

CREATE TABLE IF NOT EXISTS knowledge_topic_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  topic_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (language, topic_key)
);

ALTER TABLE knowledge_topics
  ADD COLUMN IF NOT EXISTS subtopic_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS parent_topic_id UUID REFERENCES knowledge_topics(id) ON DELETE CASCADE;

ALTER TABLE knowledge_topics
  DROP CONSTRAINT IF EXISTS knowledge_topics_group_id_topic_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_topics_group_topic_subtopic
  ON knowledge_topics (group_id, topic_key, subtopic_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_parent
  ON knowledge_topics (parent_topic_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_rebuild_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_rebuild_jobs_status
  ON knowledge_rebuild_jobs (status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_topic_definitions, knowledge_rebuild_jobs TO wagi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_topics, knowledge_items TO wagi_app;

INSERT INTO knowledge_topic_definitions (language, topic_key, title, description, sort_order)
VALUES
  ('de', 'travel', 'Reisen und Ausflüge', 'Reiseplanung, Routen, Unterkünfte und Ausflugstipps', 10),
  ('de', 'technology', 'Technik und Software', 'Software, Server, Konfiguration, Fehler und APIs', 20),
  ('de', 'radio', 'Funk und Elektronik', 'Funktechnik, Antennen, Frequenzen und Netzwerke', 30),
  ('de', 'shopping', 'Käufe und Empfehlungen', 'Produkte, Preise, Verfügbarkeit und Empfehlungen', 40),
  ('de', 'people', 'Personen und Organisationen', 'Kontakte, Rollen und Organisationen', 50),
  ('de', 'places', 'Orte und Treffpunkte', 'Benannte Orte, Adressen und Treffpunkte', 60),
  ('de', 'entities', 'Erwähnte Personen und Begriffe', 'Erkannte Entitäten und zentrale Begriffe', 70),
  ('de', 'general', 'Allgemeine Erkenntnisse', 'Sonstige belastbare Erkenntnisse', 80),
  ('es', 'travel', 'Viajes y excursiones', 'Planificación de viajes, rutas, alojamientos y excursiones', 10),
  ('es', 'technology', 'Tecnología y software', 'Software, servidores, configuración, errores y API', 20),
  ('es', 'radio', 'Radio y electrónica', 'Radiotécnica, antenas, frecuencias y redes', 30),
  ('es', 'shopping', 'Compras y recomendaciones', 'Productos, precios, disponibilidad y recomendaciones', 40),
  ('es', 'people', 'Personas y organizaciones', 'Contactos, funciones y organizaciones', 50),
  ('es', 'places', 'Lugares y puntos de encuentro', 'Lugares, direcciones y puntos de encuentro', 60),
  ('es', 'entities', 'Personas y términos mencionados', 'Entidades y términos centrales detectados', 70),
  ('es', 'general', 'Conocimientos generales', 'Otros conocimientos fiables', 80),
  ('ca', 'travel', 'Viatges i excursions', 'Planificació de viatges, rutes, allotjaments i excursions', 10),
  ('ca', 'technology', 'Tecnologia i programari', 'Programari, servidors, configuració, errors i API', 20),
  ('ca', 'radio', 'Ràdio i electrònica', 'Radiotècnica, antenes, freqüències i xarxes', 30),
  ('ca', 'shopping', 'Compres i recomanacions', 'Productes, preus, disponibilitat i recomanacions', 40),
  ('ca', 'people', 'Persones i organitzacions', 'Contactes, funcions i organitzacions', 50),
  ('ca', 'places', 'Llocs i punts de trobada', 'Llocs, adreces i punts de trobada', 60),
  ('ca', 'entities', 'Persones i termes esmentats', 'Entitats i termes centrals detectats', 70),
  ('ca', 'general', 'Coneixements generals', 'Altres coneixements fiables', 80),
  ('en', 'travel', 'Travel and outings', 'Trip planning, routes, accommodation and outings', 10),
  ('en', 'technology', 'Technology and software', 'Software, servers, configuration, errors and APIs', 20),
  ('en', 'radio', 'Radio and electronics', 'Radio equipment, antennas, frequencies and networks', 30),
  ('en', 'shopping', 'Purchases and recommendations', 'Products, prices, availability and recommendations', 40),
  ('en', 'people', 'People and organizations', 'Contacts, roles and organizations', 50),
  ('en', 'places', 'Places and meeting points', 'Named places, addresses and meeting points', 60),
  ('en', 'entities', 'Mentioned people and terms', 'Detected entities and central terms', 70),
  ('en', 'general', 'General insights', 'Other reliable insights', 80),
  ('fr', 'travel', 'Voyages et excursions', 'Planification de voyages, itinéraires, hébergements et sorties', 10),
  ('fr', 'technology', 'Technologie et logiciels', 'Logiciels, serveurs, configuration, erreurs et API', 20),
  ('fr', 'radio', 'Radio et électronique', 'Radio, antennes, fréquences et réseaux', 30),
  ('fr', 'shopping', 'Achats et recommandations', 'Produits, prix, disponibilité et recommandations', 40),
  ('fr', 'people', 'Personnes et organisations', 'Contacts, fonctions et organisations', 50),
  ('fr', 'places', 'Lieux et points de rendez-vous', 'Lieux, adresses et points de rendez-vous', 60),
  ('fr', 'entities', 'Personnes et termes mentionnés', 'Entités et termes centraux détectés', 70),
  ('fr', 'general', 'Connaissances générales', 'Autres connaissances fiables', 80)
ON CONFLICT (language, topic_key) DO NOTHING;
