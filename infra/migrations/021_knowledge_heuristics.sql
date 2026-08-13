-- Database-backed KB taxonomy and conservative subtopic learning.
--
-- The AI worker must not carry a second, hard-coded list of knowledge areas.
-- Topic definitions (migration 019) and the editable keyword terms below are
-- the source of truth for deterministic and semantic topic detection.

CREATE TABLE IF NOT EXISTS knowledge_subtopic_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('de', 'es', 'ca', 'en', 'fr')),
  topic_key TEXT NOT NULL,
  subtopic_key TEXT NOT NULL,
  term TEXT NOT NULL,
  weight NUMERIC(8,4) NOT NULL DEFAULT 0.2,
  source TEXT NOT NULL DEFAULT 'inferred'
    CHECK (source IN ('system', 'admin', 'inferred')),
  positive_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length(btrim(term)) BETWEEN 1 AND 160),
  CHECK (length(btrim(subtopic_key)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_subtopic_terms_scope
  ON knowledge_subtopic_terms (group_id, language, topic_key, subtopic_key, lower(term));
CREATE INDEX IF NOT EXISTS idx_knowledge_subtopic_terms_lookup
  ON knowledge_subtopic_terms (group_id, topic_key, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_subtopic_terms TO wagi_app;

-- Deterministic topic keywords. The suffix :detail is interpreted by the
-- worker as supporting evidence, not as a separate topic.
INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT seed.language, 'keyword', seed.topic_key, term, 1.0000, 'system'
FROM (VALUES
  ('de','travel',ARRAY['reise','reisen','urlaub','ausflug','wanderung','hotel','flug','strand','playa','viaje']),
  ('de','technology',ARRAY['server','api','docker','software','cloud','python','javascript','netzwerk','network','konfig','version','fehler','error','install','technolog','telegram','whatsapp']),
  ('de','radio',ARRAY['amateurfunk','funk','radio','aprs','dmr','antenne','antenna','repeater','meshcore','lora','hamnet','c4fm','frequenz']),
  ('de','shopping',ARRAY['kauf','kaufen','verkauf','verkaufen','preis','angebot','bestell','produkt','modell','compra','comprar','venta','precio']),
  ('de','people',ARRAY['kontakt','verein','firma','organisation','unternehmen','kontaktperson','leiter','vorstand','team','responsable']),
  ('es','travel',ARRAY['viaje','viajes','vacaciones','excursión','excursion','playa','hotel','vuelo','viaje']),
  ('es','technology',ARRAY['servidor','api','docker','software','nube','python','javascript','red','configuración','versión','error','instalación','telegram','whatsapp']),
  ('es','radio',ARRAY['radioafición','radio','aprs','antena','repetidor','frecuencia','lora','hamnet','señal']),
  ('es','shopping',ARRAY['compra','comprar','venta','precio','oferta','pedido','producto','modelo','tienda']),
  ('es','people',ARRAY['contacto','empresa','organización','persona','equipo','responsable','nombre']),
  ('ca','travel',ARRAY['viatge','viatges','vacances','excursió','platja','hotel','vol','ruta']),
  ('ca','technology',ARRAY['servidor','api','docker','programari','núvol','python','javascript','xarxa','configuració','versió','error','instal·lació','telegram','whatsapp']),
  ('ca','radio',ARRAY['radioafició','ràdio','aprs','antena','repetidor','freqüència','lora','hamnet','senyal']),
  ('ca','shopping',ARRAY['compra','comprar','venda','preu','oferta','comanda','producte','model','botiga']),
  ('ca','people',ARRAY['contacte','empresa','organització','persona','equip','responsable','nom']),
  ('en','travel',ARRAY['travel','trip','holiday','vacation','outing','hike','beach','hotel','flight','journey']),
  ('en','technology',ARRAY['server','api','docker','software','cloud','python','javascript','network','configuration','version','error','install','telegram','whatsapp']),
  ('en','radio',ARRAY['ham','amateur','radio','aprs','antenna','repeater','frequency','lora','hamnet','signal']),
  ('en','shopping',ARRAY['buy','purchase','sale','price','offer','order','product','model','store']),
  ('en','people',ARRAY['contact','company','organization','person','team','manager','responsible','name']),
  ('fr','travel',ARRAY['voyage','voyages','vacances','excursion','plage','hôtel','vol','itinéraire']),
  ('fr','technology',ARRAY['serveur','api','docker','logiciel','cloud','python','javascript','réseau','configuration','version','erreur','installation','telegram','whatsapp']),
  ('fr','radio',ARRAY['radioamateur','radio','aprs','antenne','répéteur','fréquence','lora','hamnet','signal']),
  ('fr','shopping',ARRAY['achat','acheter','vente','prix','offre','commande','produit','modèle','magasin']),
  ('fr','people',ARRAY['contact','entreprise','organisation','personne','équipe','responsable','nom'])
) AS seed(language, topic_key, terms)
CROSS JOIN LATERAL unnest(seed.terms) AS term
ON CONFLICT DO NOTHING;

INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT seed.language, 'keyword', seed.topic_key || ':detail', term, 1.0000, 'system'
FROM (VALUES
  ('de','travel',ARRAY['route','ruta','strecke','entfernung','distanz','kilometer','kosten','preis','öffnungs','unterkunft','fahrplan','buchen','buchung','reserv','empfehl','besuchen']),
  ('de','technology',ARRAY['problem','lösung','loesung','deploy','container','port','einstell','update','läuft','funktioniert','fehl','log','script','code','config','repar','verbund','connect']),
  ('de','radio',ARRAY['qrg','kanal','channel','leistung','reichweite','signal','db','mhz','khz','watt','konfig','standort','modulation','gateway','digipeater','netz']),
  ('de','shopping',ARRAY['produkt','modell','link','empfehl','kosten','liefer','versand','verfügbar','rabatt','vergleich']),
  ('de','people',ARRAY['name','nombre','nom','adresse','email','mail','telefon','tel','rolle','zuständig','responsab']),
  ('es','travel',ARRAY['ruta','itinerario','distancia','kilómetros','coste','precio','horario','alojamiento','reserva','recomendación','visitar']),
  ('es','technology',ARRAY['problema','solución','despliegue','contenedor','puerto','ajuste','actualización','funciona','registro','código','configuración','conexión']),
  ('es','radio',ARRAY['canal','potencia','alcance','señal','frecuencia','mhz','khz','vatios','configuración','puerta','red']),
  ('es','shopping',ARRAY['producto','modelo','enlace','recomendación','coste','entrega','envío','disponible','descuento','comparación']),
  ('es','people',ARRAY['nombre','dirección','correo','teléfono','papel','responsable']),
  ('ca','travel',ARRAY['ruta','itinerari','distància','quilòmetres','cost','preu','horari','allotjament','reserva','recomanació','visitar']),
  ('ca','technology',ARRAY['problema','solució','desplegament','contenidor','port','actualització','funciona','registre','codi','configuració','connexió']),
  ('ca','radio',ARRAY['canal','potència','abast','senyal','freqüència','mhz','khz','watts','configuració','passarel·la','xarxa']),
  ('ca','shopping',ARRAY['producte','model','enllaç','recomanació','cost','lliurament','enviament','disponible','descompte','comparació']),
  ('ca','people',ARRAY['nom','adreça','correu','telèfon','rol','responsable']),
  ('en','travel',ARRAY['route','itinerary','distance','kilometres','cost','price','opening','accommodation','timetable','booking','recommendation','visit']),
  ('en','technology',ARRAY['problem','solution','deploy','container','port','setting','update','works','log','script','code','config','repair','connection']),
  ('en','radio',ARRAY['qrg','channel','power','range','signal','frequency','mhz','khz','watts','configuration','gateway','digipeater','network']),
  ('en','shopping',ARRAY['product','model','link','recommendation','cost','delivery','shipping','available','discount','comparison']),
  ('en','people',ARRAY['name','address','email','phone','role','responsible']),
  ('fr','travel',ARRAY['itinéraire','distance','kilomètres','coût','prix','horaires','hébergement','réservation','recommandation','visiter']),
  ('fr','technology',ARRAY['problème','solution','déploiement','conteneur','port','réglage','mise à jour','fonctionne','journal','code','configuration','réparation','connexion']),
  ('fr','radio',ARRAY['canal','puissance','portée','signal','fréquence','mhz','khz','watts','configuration','passerelle','répéteur','réseau']),
  ('fr','shopping',ARRAY['produit','modèle','lien','recommandation','coût','livraison','expédition','disponible','réduction','comparaison']),
  ('fr','people',ARRAY['nom','adresse','email','téléphone','rôle','responsable'])
) AS seed(language, topic_key, terms)
CROSS JOIN LATERAL unnest(seed.terms) AS term
ON CONFLICT DO NOTHING;

-- Location messages are a separate topic signal and are also used by the
-- place/event heuristic. Keeping the cues editable makes this behavior
-- consistent with the other topic areas.
INSERT INTO ai_learning_terms (language, category, topic_key, term, weight, source)
SELECT seed.language, 'keyword', 'places', term, 1.0000, 'system'
FROM (VALUES
  ('de',ARRAY['adresse','treff','treffpunkt','restaurant','hotel','öffnungs','empfehl','route','parkplatz','ort','standort','location']),
  ('es',ARRAY['dirección','encuentro','punto de encuentro','restaurante','hotel','horario','recomendación','ruta','aparcamiento','lugar','ubicación']),
  ('ca',ARRAY['adreça','trobada','punt de trobada','restaurant','hotel','horari','recomanació','ruta','aparcament','lloc','ubicació']),
  ('en',ARRAY['address','meeting','meeting point','restaurant','hotel','opening','recommendation','route','parking','place','location']),
  ('fr',ARRAY['adresse','rendez-vous','point de rendez-vous','restaurant','hôtel','horaires','recommandation','itinéraire','parking','lieu','emplacement'])
) AS seed(language, terms)
CROSS JOIN LATERAL unnest(seed.terms) AS term
ON CONFLICT DO NOTHING;

-- Existing generated subtopics used a taxonomy label as their title. Convert
-- those rows once to content-derived titles; future writes use the same
-- heuristic and preserve the complete summary in the database.
UPDATE knowledge_topics
SET title=LEFT(regexp_replace(BTRIM(COALESCE(summary, '')), '[[:space:]]+', ' ', 'g'), 96)
WHERE subtopic_key <> '' AND BTRIM(COALESCE(summary, '')) <> '';
