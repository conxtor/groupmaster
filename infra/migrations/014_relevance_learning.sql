-- Three-level relevance and explainable, language-/group-scoped learning.
-- Global rows (group_id IS NULL) are the editable defaults. Group rows add
-- local weight and therefore influence only the matching group more strongly.

ALTER TABLE message_analyses ADD COLUMN IF NOT EXISTS relevance_level TEXT;
UPDATE message_analyses
   SET relevance_level = CASE
     WHEN COALESCE(relevance_score, 0) >= 0.75 THEN 'high'
     WHEN COALESCE(relevance_score, 0) >= 0.45 THEN 'medium'
     ELSE 'low'
   END
 WHERE relevance_level IS NULL;
ALTER TABLE message_analyses ALTER COLUMN relevance_level SET DEFAULT 'low';
ALTER TABLE message_analyses ALTER COLUMN relevance_level SET NOT NULL;
ALTER TABLE message_analyses DROP CONSTRAINT IF EXISTS message_analyses_relevance_level_check;
ALTER TABLE message_analyses ADD CONSTRAINT message_analyses_relevance_level_check
  CHECK (relevance_level IN ('high', 'medium', 'low'));
CREATE INDEX IF NOT EXISTS idx_analyses_relevance_level
  ON message_analyses(relevance_level, relevance_score DESC);

ALTER TABLE ai_feedback DROP CONSTRAINT IF EXISTS ai_feedback_target_type_check;
ALTER TABLE ai_feedback ADD CONSTRAINT ai_feedback_target_type_check
  CHECK (target_type IN ('relevance', 'event', 'place', 'knowledge'));

CREATE TABLE IF NOT EXISTS ai_learning_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT REFERENCES wa_groups(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  category TEXT NOT NULL CHECK (category IN ('relevance', 'event', 'place', 'keyword', 'exclusion')),
  topic_key TEXT,
  term TEXT NOT NULL,
  weight NUMERIC(8,4) NOT NULL DEFAULT 0,
  relevance_level TEXT CHECK (relevance_level IS NULL OR relevance_level IN ('high', 'medium', 'low')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('system', 'admin', 'feedback', 'inferred')),
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(btrim(term)) BETWEEN 1 AND 160)
);

ALTER TABLE ai_learning_terms DROP CONSTRAINT IF EXISTS ai_learning_terms_source_check;
ALTER TABLE ai_learning_terms ADD CONSTRAINT ai_learning_terms_source_check
  CHECK (source IN ('system', 'admin', 'feedback', 'inferred'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_learning_terms_scope
  ON ai_learning_terms (COALESCE(group_id, ''), language, category, COALESCE(topic_key, ''), lower(term));
CREATE INDEX IF NOT EXISTS idx_ai_learning_terms_lookup
  ON ai_learning_terms (language, category, group_id, enabled, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_learning_terms TO wagi_app;

-- The former code constants are seeded as editable global defaults. The
-- worker still has a safe fallback for rolling deployments before this file
-- has run, but normal operation reads these values from this table.
INSERT INTO ai_learning_terms (language, category, term, weight, relevance_level, source)
SELECT language, 'relevance', term, 0.1200, 'medium', 'system'
FROM (VALUES
  ('de','morgen'),('de','heute'),('de','treffen'),('de','termin'),('de','event'),('de','wichtig'),('de','ort'),('de','straße'),('de','bahnhof'),('de','meeting'),('de','samstag'),('de','sonntag'),('de','costa'),('de','montserrat'),
  ('es','mañana'),('es','hoy'),('es','reunión'),('es','estación'),('es','lugar'),('es','sábado'),('es','domingo'),('es','costa'),('es','montserrat'),
  ('ca','demà'),('ca','avui'),('ca','trobem'),('ca','estació'),('ca','lloc'),('ca','dissabte'),('ca','diumenge'),('ca','costa'),('ca','montserrat'),
  ('en','tomorrow'),('en','today'),('en','meeting'),('en','event'),('en','important'),('en','station'),('en','place'),('en','saturday'),('en','sunday'),('en','costa'),('en','montserrat'),
  ('fr','rendez-vous'),('fr','demain'),('fr','aujourd'),('fr','gare'),('fr','lieu'),('fr','samedi'),('fr','dimanche'),('fr','costa'),('fr','montserrat')
) AS seeded(language, term) ON CONFLICT DO NOTHING;

INSERT INTO ai_learning_terms (language, category, term, weight, source)
SELECT language, 'event', term, 1.0000, 'system'
FROM (VALUES
  ('de','treffen'),('de','wanderung'),('de','meeting'),('de','termin'),('de','event'),('de','fahren'),('de','fahrt'),('de','ausflug'),('de','reserv'),('de','morgen'),('de','heute'),('de','samstag'),('de','sonntag'),('de','um'),('de','uhr'),('de','gegen'),
  ('es','reunión'),('es','reunion'),('es','quedada'),('es','viaje'),('es','excursión'),('es','reserv'),('es','mañana'),('es','hoy'),('es','sábado'),('es','domingo'),('es','a las'),('es','a la'),
  ('ca','trobem'),('ca','trobada'),('ca','viatge'),('ca','excursió'),('ca','demà'),('ca','avui'),('ca','dissabte'),('ca','diumenge'),('ca','a les'),
  ('en','meet'),('en','meeting'),('en','gather'),('en','go to'),('en','let''s go'),('en','tomorrow'),('en','today'),('en','saturday'),('en','sunday'),('en','at'),('en','around'),
  ('fr','rendez-vous'),('fr','sortie'),('fr','demain'),('fr','aujourd'),('fr','samedi'),('fr','dimanche'),('fr','à'),('fr','vers')
) AS seeded(language, term) ON CONFLICT DO NOTHING;

INSERT INTO ai_learning_terms (language, category, term, weight, source)
SELECT language, 'place', term, 1.0000, 'system'
FROM (VALUES
  ('de','ort'),('de','bahnhof'),('de','straße'),('de','restaurant'),('de','office'),('de','morgen'),
  ('es','lugar'),('es','estación'),('es','restaurante'),('es','oficina'),
  ('ca','lloc'),('ca','estació'),('ca','restaurant'),('ca','oficina'),
  ('en','place'),('en','station'),('en','restaurant'),('en','office'),('en','location'),
  ('fr','lieu'),('fr','gare'),('fr','restaurant'),('fr','bureau'),('fr','location')
) AS seeded(language, term) ON CONFLICT DO NOTHING;

INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT language, 'keyword', topic_key, term, 1.0000, 'system'
FROM (VALUES
  ('de','travel','reise'),('de','travel','reisen'),('de','travel','urlaub'),('de','travel','ausflug'),('de','travel','wanderung'),('de','travel','hotel'),('de','travel','flug'),('de','travel','route'),('de','travel','strecke'),('de','travel','entfernung'),('de','travel','kosten'),('de','travel','preis'),('de','travel','öffnungs'),('de','travel','unterkunft'),('de','travel','fahrplan'),('de','travel','buchung'),('de','travel','reserv'),('de','travel','empfehl'),
  ('de','technology','server'),('de','technology','api'),('de','technology','docker'),('de','technology','software'),('de','technology','cloud'),('de','technology','python'),('de','technology','javascript'),('de','technology','netzwerk'),('de','technology','version'),('de','technology','fehler'),('de','technology','install'),('de','technology','problem'),('de','technology','lösung'),('de','technology','deploy'),('de','technology','container'),('de','technology','port'),('de','technology','update'),('de','technology','funktioniert'),('de','technology','log'),('de','technology','code'),
  ('de','radio','amateurfunk'),('de','radio','funk'),('de','radio','radio'),('de','radio','aprs'),('de','radio','dmr'),('de','radio','antenne'),('de','radio','repeater'),('de','radio','lora'),('de','radio','hamnet'),('de','radio','frequenz'),('de','radio','qrg'),('de','radio','kanal'),('de','radio','leistung'),('de','radio','reichweite'),('de','radio','signal'),('de','radio','mhz'),('de','radio','gateway'),('de','radio','digipeater'),
  ('de','shopping','kauf'),('de','shopping','kaufen'),('de','shopping','verkauf'),('de','shopping','preis'),('de','shopping','angebot'),('de','shopping','bestell'),('de','shopping','produkt'),('de','shopping','modell'),('de','shopping','link'),('de','shopping','empfehl'),('de','shopping','liefer'),('de','shopping','versand'),('de','shopping','verfügbar'),('de','shopping','rabatt'),('de','shopping','vergleich'),
  ('de','people','kontakt'),('de','people','verein'),('de','people','firma'),('de','people','organisation'),('de','people','leiter'),('de','people','vorstand'),('de','people','name'),('de','people','adresse'),('de','people','email'),('de','people','telefon'),('de','people','rolle'),('de','people','zuständig')
) AS seeded(language, topic_key, term) ON CONFLICT DO NOTHING;

-- Multilingual topic terms not present in the original German defaults.
INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT language, 'keyword', topic_key, term, 1.0000, 'system'
FROM (VALUES
  ('es','travel','viaje'),('es','travel','vacaciones'),('es','travel','excursión'),('es','travel','ruta'),('es','travel','alojamiento'),('es','travel','horario'),('es','travel','reserv'),('es','travel','recomend'),
  ('es','technology','servidor'),('es','technology','software'),('es','technology','red'),('es','technology','error'),('es','technology','instal'),('es','technology','problema'),('es','technology','solución'),('es','technology','conect'),
  ('es','shopping','compra'),('es','shopping','comprar'),('es','shopping','venta'),('es','shopping','precio'),('es','shopping','producto'),('es','shopping','modelo'),('es','shopping','disponible'),('es','shopping','recomend'),
  ('es','people','contacto'),('es','people','empresa'),('es','people','nombre'),('es','people','dirección'),('es','people','teléfono'),
  ('ca','travel','viatge'),('ca','travel','platja'),('ca','travel','ruta'),('ca','travel','horari'),('ca','travel','reserva'),('ca','travel','recoman'),
  ('ca','technology','servidor'),('ca','technology','programari'),('ca','technology','xarxa'),('ca','technology','error'),('ca','technology','problema'),('ca','technology','solució'),('ca','technology','connect'),
  ('ca','shopping','compra'),('ca','shopping','preu'),('ca','shopping','producte'),('ca','shopping','model'),('ca','shopping','disponible'),('ca','shopping','recoman'),
  ('ca','people','contacte'),('ca','people','empresa'),('ca','people','nom'),('ca','people','adreça'),('ca','people','telèfon'),
  ('en','travel','travel'),('en','travel','trip'),('en','travel','holiday'),('en','travel','route'),('en','travel','accommodation'),('en','travel','opening'),('en','travel','booking'),('en','travel','recommend'),
  ('en','technology','server'),('en','technology','software'),('en','technology','network'),('en','technology','error'),('en','technology','install'),('en','technology','problem'),('en','technology','solution'),('en','technology','connect'),
  ('en','shopping','buy'),('en','shopping','sale'),('en','shopping','price'),('en','shopping','product'),('en','shopping','model'),('en','shopping','available'),('en','shopping','recommend'),
  ('en','people','contact'),('en','people','company'),('en','people','name'),('en','people','address'),('en','people','phone'),
  ('fr','travel','voyage'),('fr','travel','vacances'),('fr','travel','excursion'),('fr','travel','itinéraire'),('fr','travel','hébergement'),('fr','travel','réservation'),('fr','travel','recommand'),
  ('fr','technology','serveur'),('fr','technology','logiciel'),('fr','technology','réseau'),('fr','technology','erreur'),('fr','technology','installation'),('fr','technology','problème'),('fr','technology','solution'),
  ('fr','shopping','achat'),('fr','shopping','acheter'),('fr','shopping','prix'),('fr','shopping','produit'),('fr','shopping','modèle'),('fr','shopping','disponible'),('fr','shopping','recommand'),
  ('fr','people','contact'),('fr','people','entreprise'),('fr','people','nom'),('fr','people','adresse'),('fr','people','téléphone')
) AS seeded(language, topic_key, term) ON CONFLICT DO NOTHING;

-- Detail terms are stored with a role suffix so administrators can maintain
-- the same keyword/detail distinction that the former code rules used.
INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT language, 'keyword', topic_key || ':detail', term, 1.0000, 'system'
FROM (VALUES
  ('de','travel','route'),('de','travel','ruta'),('de','travel','itiner'),('de','travel','strecke'),('de','travel','entfernung'),('de','travel','distanz'),('de','travel','kilometer'),('de','travel','km'),('de','travel','kosten'),('de','travel','preis'),('de','travel','öffnungs'),('de','travel','horario'),('de','travel','horaris'),('de','travel','unterkunft'),('de','travel','alojamiento'),('de','travel','hébergement'),('de','travel','fahrplan'),('de','travel','buchen'),('de','travel','buchung'),('de','travel','reserv'),('de','travel','empfehl'),('de','travel','recomend'),('de','travel','recoman'),('de','travel','recommend'),('de','travel','besuchen'),
  ('de','technology','problem'),('de','technology','lösung'),('de','technology','loesung'),('de','technology','deploy'),('de','technology','container'),('de','technology','port'),('de','technology','einstell'),('de','technology','update'),('de','technology','läuft'),('de','technology','funktioniert'),('de','technology','fehl'),('de','technology','log'),('de','technology','script'),('de','technology','code'),('de','technology','config'),('de','technology','repar'),('de','technology','verbund'),('de','technology','conect'),('de','technology','connect'),('de','technology','réseau'),
  ('de','radio','qrg'),('de','radio','kanal'),('de','radio','channel'),('de','radio','leistung'),('de','radio','reichweite'),('de','radio','signal'),('de','radio','db'),('de','radio','mhz'),('de','radio','khz'),('de','radio','watt'),('de','radio','konfig'),('de','radio','konfiguration'),('de','radio','standort'),('de','radio','modulation'),('de','radio','gateway'),('de','radio','digipeater'),('de','radio','netz'),
  ('de','shopping','produkt'),('de','shopping','modell'),('de','shopping','link'),('de','shopping','empfehl'),('de','shopping','kosten'),('de','shopping','liefer'),('de','shopping','versand'),('de','shopping','verfügbar'),('de','shopping','disponible'),('de','shopping','talla'),('de','shopping','größe'),('de','shopping','rabatt'),('de','shopping','vergleich'),('de','shopping','compar'),('de','shopping','avis'),('de','shopping','recomend'),
  ('de','people','name'),('de','people','nombre'),('de','people','nom'),('de','people','adresse'),('de','people','email'),('de','people','mail'),('de','people','telefon'),('de','people','tel'),('de','people','rolle'),('de','people','zuständig'),('de','people','responsab'),('de','people','bei'),('de','people','von'),('de','people','mit')
) AS seeded(language, topic_key, term) ON CONFLICT DO NOTHING;

INSERT INTO ai_learning_terms (language, category, term, weight, source)
SELECT language, 'exclusion', term, 1.0000, 'system'
FROM (VALUES
  ('de','der'),('de','die'),('de','das'),('de','und'),('de','für'),('de','nicht'),('de','mit'),('de','ist'),('de','sind'),('de','auf'),('de','von'),('de','eine'),('de','einer'),('de','ich'),('de','du'),('de','wir'),('de','ihr'),('de','sie'),('de','ein'),('de','einem'),('de','den'),('de','dem'),('de','aber'),('de','also'),('de','auch'),('de','als'),('de','an'),('de','aus'),('de','bei'),('de','bis'),('de','dass'),('de','dann'),('de','denn'),('de','doch'),('de','durch'),('de','gegen'),('de','im'),('de','in'),('de','ja'),('de','jede'),('de','jeder'),('de','jedes'),('de','kein'),('de','keine'),('de','noch'),('de','nur'),('de','oder'),('de','über'),('de','um'),('de','unter'),('de','vom'),('de','zum'),('de','zur'),('de','so'),('de','schon'),('de','sehr'),('de','wie'),('de','was'),('de','wer'),('de','wo'),('de','wenn'),('de','weil'),('de','wieder'),('de','mal'),('de','man'),('de','hier'),('de','dort'),('de','hallo'),('de','bitte'),('de','danke'),('de','okay'),
  ('es','el'),('es','la'),('es','los'),('es','las'),('es','que'),('es','para'),('es','con'),('es','una'),('es','uno'),('es','está'),('es','están'),('es','y'),('es','o'),('es','pero'),('es','como'),('es','del'),('es','al'),('es','un'),('es','unos'),('es','unas'),('es','se'),('es','su'),('es','sus'),('es','por'),('es','sin'),('es','sobre'),('es','entre'),('es','desde'),('es','hasta'),('es','ya'),('es','más'),('es','muy'),('es','solo'),('es','sólo'),('es','también'),('es','porque'),('es','cuando'),('es','donde'),('es','cómo'),('es','qué'),('es','quién'),('es','este'),('es','esta'),('es','estos'),('es','estas'),('es','eso'),('es','esto'),('es','yo'),('es','tú'),('es','nosotros'),('es','ellos'),('es','me'),('es','te'),('es','lo'),('es','le'),('es','les'),('es','no'),('es','sí'),('es','hola'),('es','gracias'),('es','vale'),('es','bueno'),
  ('ca','els'),('ca','les'),('ca','que'),('ca','per'),('ca','amb'),('ca','una'),('ca','està'),('ca','estan'),('ca','i'),('ca','o'),('ca','però'),('ca','com'),('ca','del'),('ca','al'),('ca','un'),('ca','uns'),('ca','unes'),('ca','es'),('ca','seva'),('ca','seves'),('ca','sense'),('ca','sobre'),('ca','entre'),('ca','des'),('ca','fins'),('ca','ja'),('ca','més'),('ca','molt'),('ca','només'),('ca','també'),('ca','perquè'),('ca','quan'),('ca','on'),('ca','què'),('ca','qui'),('ca','aquest'),('ca','aquesta'),('ca','això'),('ca','jo'),('ca','tu'),('ca','nosaltres'),('ca','vosaltres'),('ca','ells'),('ca','em'),('ca','et'),('ca','ho'),('ca','li'),('ca','no'),('ca','sí'),('ca','hola'),('ca','gràcies'),('ca','bé'),
  ('en','the'),('en','and'),('en','for'),('en','with'),('en','this'),('en','that'),('en','are'),('en','is'),('en','a'),('en','an'),('en','or'),('en','but'),('en','as'),('en','of'),('en','to'),('en','in'),('en','on'),('en','at'),('en','by'),('en','from'),('en','into'),('en','over'),('en','under'),('en','about'),('en','before'),('en','after'),('en','between'),('en','through'),('en','during'),('en','without'),('en','not'),('en','no'),('en','yes'),('en','be'),('en','been'),('en','was'),('en','were'),('en','it'),('en','its'),('en','these'),('en','those'),('en','i'),('en','you'),('en','we'),('en','they'),('en','he'),('en','she'),('en','me'),('en','him'),('en','her'),('en','them'),('en','my'),('en','your'),('en','our'),('en','their'),('en','can'),('en','could'),('en','should'),('en','would'),('en','will'),('en','just'),('en','only'),('en','also'),('en','very'),('en','really'),('en','so'),('en','if'),('en','then'),('en','than'),('en','because'),('en','when'),('en','where'),('en','what'),('en','who'),('en','how'),('en','here'),('en','there'),('en','hello'),('en','thanks'),('en','please'),('en','okay'),
  ('fr','le'),('fr','la'),('fr','les'),('fr','des'),('fr','que'),('fr','pour'),('fr','avec'),('fr','une'),('fr','est'),('fr','sont'),('fr','un'),('fr','et'),('fr','ou'),('fr','mais'),('fr','comme'),('fr','de'),('fr','du'),('fr','au'),('fr','aux'),('fr','à'),('fr','en'),('fr','dans'),('fr','sur'),('fr','par'),('fr','sans'),('fr','entre'),('fr','depuis'),('fr','jusqu'),('fr','avant'),('fr','après'),('fr','chez'),('fr','ne'),('fr','pas'),('fr','plus'),('fr','très'),('fr','seulement'),('fr','aussi'),('fr','parce'),('fr','quand'),('fr','où'),('fr','qui'),('fr','quoi'),('fr','comment'),('fr','ce'),('fr','cette'),('fr','ces'),('fr','ça'),('fr','je'),('fr','tu'),('fr','nous'),('fr','vous'),('fr','ils'),('fr','elles'),('fr','me'),('fr','te'),('fr','se'),('fr','mon'),('fr','ton'),('fr','son'),('fr','notre'),('fr','votre'),('fr','leur'),('fr','oui'),('fr','non'),('fr','bon'),('fr','bonjour'),('fr','merci')
) AS seeded(language, term) ON CONFLICT DO NOTHING;
