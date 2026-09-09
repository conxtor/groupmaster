# AI-Evaluationsdatensatz

`dataset.jsonl` enthält einen kleinen, versionierbaren Smoke-Datensatz für die
fünf unterstützten Gruppensprachen Deutsch, Spanisch, Katalanisch, Englisch
und Französisch. Jede Zeile enthält einen Eingangstext und erwartete
Eigenschaften für Relevanz, Event-, Orts- und Knowledge-Erkennung.

Der Datensatz ist bewusst kompakt und dient als Regressionstest für die
Heuristik. Neue Beispiele sollen die gleiche Struktur behalten und jeweils
eine positive sowie eine negative Variante pro Sprache enthalten. Bei einer
späteren AI-Adapter-Implementierung kann die Datei ohne Formatänderung als
goldener Evaluationssatz verwendet werden.

## Thread-Konsolidierung

Die ausführbaren Regressionstests unter `apps/ai-worker/tests` prüfen die fünf
Sprachen, verschachtelte Diskussionen, Mehrdeutigkeit, Brückeneffekte, aktuelle
Link-/Unlink-Entscheidungen, Telegram-Forum-Header und verschiedene Reply-Formate.
Vom Repository-Verzeichnis: `python3 -m unittest discover -s apps/ai-worker/tests -v`.

Mit installiertem `asyncpg` und `THREAD_TEST_DATABASE_URL` werden zusätzlich echte
PostgreSQL-Tests ausgeführt. Dafür eine separate Testdatenbank verwenden: die
Tests legen jeweils ein zufälliges Schema an, verwenden die Migration
`029_conversation_threads.sql` und löschen nur ihr Testschema wieder. Der Testuser
benötigt Schema-/Rollenerstellungsrechte. `THREAD_TEST_MIGRATIONS_DIR` kann den
Pfad der Migrationen überschreiben (z. B. im Container). Getestet werden
Parallelverarbeitung, Idempotenz, stabile IDs, Transkripte, Aufteilung nach
Feedback/Edits, Reply-Eltern außerhalb des Fensters und Transaktionsrollback.
