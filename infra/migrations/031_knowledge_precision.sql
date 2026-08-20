-- Precision controls for automatically learned Knowledge Base terms.
--
-- Admin- and system-managed terms remain active immediately. Automatically
-- inferred keyword terms are initially provisional and are activated only
-- after repeated evidence in the same group/topic.

ALTER TABLE ai_learning_terms
  ADD COLUMN IF NOT EXISTS signal_role TEXT NOT NULL DEFAULT 'supporting';

ALTER TABLE ai_learning_terms
  DROP CONSTRAINT IF EXISTS ai_learning_terms_signal_role_check;
ALTER TABLE ai_learning_terms
  ADD CONSTRAINT ai_learning_terms_signal_role_check
  CHECK (signal_role IN ('strong', 'supporting', 'generic', 'provisional'));

-- Existing system terms are useful topic anchors. Detail terms support an
-- anchor, while broad words must never create a KB candidate by themselves.
UPDATE ai_learning_terms
SET signal_role = CASE
  WHEN category <> 'keyword' THEN 'supporting'
  WHEN source = 'inferred' THEN 'provisional'
  WHEN topic_key LIKE '%:detail' THEN 'supporting'
  ELSE 'strong'
END
WHERE signal_role = 'supporting';

-- Generic terms are deliberately retained for explainability and admin
-- editing, but are excluded as stand-alone KB evidence by the worker.
UPDATE ai_learning_terms
SET signal_role = 'generic'
WHERE category = 'keyword'
  AND lower(term) IN (
    'api','server','servidor','serveur','software','programari','logiciel',
    'error','fehler','erreur','problema','problem','problème',
    'lösung','solución','solució','solution','connect','conect','connexion',
    'telegram','whatsapp','network','netzwerk','red','réseau',
    'name','nombre','nom','adresse','address','dirección','adreça',
    'produkt','producto','producte','produit','modell','modelo','model',
    'preis','precio','preu','prix','link','enlace','enllaç','lien',
    'route','ruta','rutes','itinéraire','recommend','recomend','recoman',
    'empfehl','empfehlung','recommandation'
  );

CREATE INDEX IF NOT EXISTS idx_ai_learning_terms_signal_role
  ON ai_learning_terms (category, signal_role, language, group_id, topic_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_learning_terms TO wagi_app;

ALTER TABLE knowledge_rebuild_jobs
  ADD COLUMN IF NOT EXISTS replace_existing BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_rebuild_jobs TO wagi_app;
