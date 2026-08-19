-- Structured action items and their group-scoped learning terms.
-- Action items are stored separately from events so the UI can present them
-- immediately below the event board without mixing the two result types.

ALTER TABLE message_analyses
  ADD COLUMN IF NOT EXISTS action_items JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_analyses_action_items
  ON message_analyses USING gin (action_items);

ALTER TABLE ai_learning_terms
  DROP CONSTRAINT IF EXISTS ai_learning_terms_category_check;
ALTER TABLE ai_learning_terms
  ADD CONSTRAINT ai_learning_terms_category_check
  CHECK (category IN ('relevance', 'event', 'action', 'place', 'keyword', 'exclusion'));

ALTER TABLE ai_learning_term_history
  DROP CONSTRAINT IF EXISTS ai_learning_term_history_category_check;
ALTER TABLE ai_learning_term_history
  ADD CONSTRAINT ai_learning_term_history_category_check
  CHECK (category IN ('relevance', 'event', 'action', 'place', 'keyword', 'exclusion'));

ALTER TABLE ai_learning_term_exclusions
  DROP CONSTRAINT IF EXISTS ai_learning_term_exclusions_category_check;
ALTER TABLE ai_learning_term_exclusions
  ADD CONSTRAINT ai_learning_term_exclusions_category_check
  CHECK (category IN ('relevance', 'event', 'action', 'place', 'keyword', 'exclusion'));

GRANT SELECT, INSERT, UPDATE, DELETE ON message_analyses TO wagi_app;

-- Action cues are editable system defaults. They are deliberately broad enough
-- to cover requests and responsibilities in all supported group languages;
-- the worker still requires an action/request signal before creating an item.
INSERT INTO ai_learning_terms (language, category, term, weight, source)
SELECT language, 'action', term, 1.0000, 'system'
FROM (VALUES
  ('de','bitte'),('de','kannst'),('de','könntest'),('de','soll'),('de','sollst'),('de','muss'),('de','müssen'),('de','aufgabe'),('de','todo'),('de','erledigen'),('de','prüfen'),('de','schicken'),('de','senden'),('de','anrufen'),('de','reservieren'),('de','buchen'),('de','kaufen'),('de','mitbringen'),('de','klären'),('de','bestätigen'),('de','informieren'),('de','organisieren'),
  ('es','por favor'),('es','puedes'),('es','podrías'),('es','debes'),('es','hay que'),('es','tarea'),('es','pendiente'),('es','hacer'),('es','revisar'),('es','enviar'),('es','llamar'),('es','reservar'),('es','comprar'),('es','traer'),('es','confirmar'),('es','informar'),('es','organizar'),('es','acordar'),
  ('ca','si us plau'),('ca','pots'),('ca','podries'),('ca','has de'),('ca','cal'),('ca','tasca'),('ca','pendent'),('ca','fer'),('ca','revisar'),('ca','enviar'),('ca','trucar'),('ca','reservar'),('ca','comprar'),('ca','portar'),('ca','confirmar'),('ca','informar'),('ca','organitzar'),('ca','acordar'),
  ('en','please'),('en','can you'),('en','could you'),('en','should'),('en','must'),('en','task'),('en','todo'),('en','to do'),('en','do'),('en','check'),('en','review'),('en','send'),('en','call'),('en','book'),('en','reserve'),('en','buy'),('en','bring'),('en','confirm'),('en','inform'),('en','organize'),('en','arrange'),
  ('fr','s’il te plaît'),('fr','peux-tu'),('fr','pourrais-tu'),('fr','dois'),('fr','il faut'),('fr','tâche'),('fr','à faire'),('fr','faire'),('fr','vérifier'),('fr','envoyer'),('fr','appeler'),('fr','réserver'),('fr','acheter'),('fr','apporter'),('fr','confirmer'),('fr','informer'),('fr','organiser'),('fr','prévoir')
) AS seeded(language, term) ON CONFLICT DO NOTHING;

