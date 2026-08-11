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
