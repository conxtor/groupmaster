# WAGI Roadmap

## Ausgangslage

Der aktuelle Stand ist ein lauffähiger vertikaler MVP für WhatsApp- und Telegram-Gruppen:

- WhatsApp-Connector mit whatsmeow, QR-/Linked-Device-Skelett und PostgreSQL-Session-State
- Telegram-Direkt-Connector über Go/`gotd/td` mit QR-Login im Dashboard und PostgreSQL-persistenten Sessions
- PostgreSQL mit PostGIS und pgvector, NATS JetStream und MinIO-Grundgerüst
- Audio-Job-Pipeline mit lokalem whisper.cpp und Medium-Modell
- Heuristische Analyse für Relevanz, Facts, Entities, Events, Places und Zusammenfassungen
- Mehrnachrichten-Events mit verknüpften Quellen, Bildern und Leaflet/OpenStreetMap-Karten
- Go-API und Next.js-Dashboard

Der MVP ist damit gut für Demonstration und Architekturvalidierung geeignet, aber noch nicht produktionsfähig.

## Phase 1 – Beta-fähiger Kern

Ziel: Ein einzelner vertrauenswürdiger Nutzer kann reale Gruppen sicher verbinden und die Verarbeitung nachvollziehbar bedienen.

### Konnektoren

- [x] WhatsApp-Reconnect, Session-Recovery, History-Sync und kontrollierter Sieben-Tage-Erst-Backfill
- [x] Behandlung von Edits, Löschungen, Duplikaten und Nachrichten-Reihenfolge im Connector-Kern
- [x] Connector-Status für QR-Pairing, Session, Fehler und erneute Anmeldung über die Status-Endpunkte
- [x] Telegram-Dateien über gotd/MTProto herunterladen und an die MinIO-Medienpipeline übergeben
- [x] Gemeinsamer Connector-Lifecycle mit einheitlichem Event-/Fehlervertrag; der Telegram-Pool nutzt dafür Go/`gotd/td` und PostgreSQL-Leases
- [x] Benutzergebundene QR-Routen für WhatsApp und Telegram mit persistenten Kontositzungen und dediziertem Onboarding-Slot
- [x] Gruppenentdeckung und Gruppenauswahl pro Nutzerkonto; nicht mehr erreichbare Gruppen werden automatisch aus Auswahl und Datenbestand bereinigt

### Medien

- [x] Echte WhatsApp-Medien herunterladen und entschlüsseln
- [x] Telegram- und WhatsApp-Medien dauerhaft in MinIO speichern
- [x] Bild-Thumbnails und sichere Download-Pfade; Audio-/Videowiedergabe in der UI bleibt offen
- [x] OCR und erste Bildanalyse für Bilder, Screenshots und Karten sowie lokale Dokumentanalyse für PDF/DOCX/Textdateien
- [x] Audio-Worker so verdrahten, dass reale Quelldateien an whisper.cpp übergeben werden
- [x] Status, Retry und Fehleranzeige für Audiojobs; Audiojobs werden nach Worker-Neustarts und transienten Fehlern automatisch wieder eingeplant

### KI und Datenqualität

- [x] Lokalen, austauschbaren AI-Adaptervertrag mit präziser Kaskade aus Regeln, Embeddings und optionalem Hermes-Fallback ergänzen
- [x] Strukturierte JSON-/Pydantic-Schema-Verträge, Prompt-Versionierung und Modellkonfiguration
- [x] Evaluationsdatensatz für Deutsch, Spanisch, Katalanisch, Englisch und Französisch unter `apps/ai-worker/eval/dataset.jsonl`
- [x] Konfidenzen, Quellenbelege und nachvollziehbare Herleitung je Ergebnis
- [x] Zusammenführung von Events aus mehreren Nachrichten ohne Duplikate
- [x] Erledigt: Lokaler Thread-Konsolidierer mit Mehrdeutigkeits- und Kohäsionsprüfung, reversiblen automatischen Zuordnungen, transitiven Nutzer-Trennregeln und gemeinsamem Kontext für Events, Action Items und KB; bestehende Threads über die Admin-Neubewertung prüfbar
- [x] Widersprüchliche Zeit-, Orts- und Terminangaben erkennen, mit Quellen belegen und als Konflikt markieren
- [x] Kaskadenqualität `cascade-v4`: stabiles Event-/Knowledge-Deduping, begrenzte Zeit-/Antwortfenster, kanonische Alias-Zuordnung und belegte Knowledge-Graph-Beziehungen
- [x] Nutzerfeedback für Relevanz, Events und Knowledge-Base über `POST /api/v1/ai/feedback` speichern und betroffene Nachrichten idempotent neu analysieren
- [x] Dreistufige Relevanz (`high`/`medium`/`low`) mit sprach- und gruppengebundenem Lernmodell für Relevanz, Events und Orte; System-Schlüssel- und Ausschlusswörter sind in `ai_learning_terms` editierbar

### Nutzeroberfläche

- [x] Event-Detailansicht mit allen Quellnachrichten
- [x] Suche und Filter nach Gruppe, Zeitraum, Relevanz, Ort, Event und Medientyp
- [x] Transkript prüfen und korrigieren; vollständige Transkripte werden im Dashboard und in den Knowledge-Base-Quellnachrichten als Nachrichtentext angezeigt
- [x] Gruppen- und Connector-Setup als verständlicher lokaler QR-Onboarding-Prozess im Dashboard; Telegram-2FA wird als `reauth_required` transparent angezeigt
- [x] Fehler-, Job- und Verbindungsstatus sichtbar machen

## Phase 2 – Produktionsreife

Ziel: Sicherer und betrieblich belastbarer Einsatz mit mehreren Nutzern und Gruppen.

### Sicherheit und Datenschutz

- [x] User-Login und sichere Session-Verwaltung über E-Mail/Passwort, bcrypt, HttpOnly-Sitzungscookie und Ablauf-/Logout-Handling
- [x] Rollen und Rechte für Nutzer, Medien und Administration; Gruppen und Auswahllisten werden ausschließlich im jeweiligen Nutzerkonto über `user_group_access` verwaltet

### Mehrbenutzer-Connector-Betrieb

- [x] Nutzerkonten, persistente Connector-Sessions und Gruppen-Cursor in PostgreSQL
- [x] Konfigurierbare WhatsApp-/Telegram-Processing-Pools mit exklusiven Leases
- [x] Turnusverarbeitung: Lease-Freigabe nach dem Aufholen auf den aktuellen Nachrichtenstand
- [x] Reservierter Onboarding-Konnektor pro Plattform, der nur Gruppen einliest und keine Nachrichten verarbeitet
- [ ] Tenant-Isolation für mehrere Organisationen oder private Arbeitsbereiche
- [ ] Verschlüsselung bei Transport und Speicherung
- [ ] Secret-Management statt ungeschützter `.env`-Werte
- [ ] Löschfristen, selektive Löschung und vollständiger Datenexport
- [ ] Einwilligungs-/Hinweiskonzept, Audit-Log und Datenschutzdokumentation
- [ ] Rechtliche Prüfung der WhatsApp-, Telegram-, Medien- und Kartendienste

### Verarbeitung und Zuverlässigkeit

- [x] Explizite JetStream-Streams und Consumer provisionieren
- [x] Retry-Strategien, Dead-Letter-Queues und Backoff
- [x] Idempotente Verarbeitung mit Inbox-Muster
- [x] Wiederanlauf und Recovery für unterbrochene Audio-/KI-Jobs
- [x] Dokumentanalyse für PDF, DOCX, Text- und strukturierte Dateien mit lokaler Extraktion/OCR
- [x] Replay und Backfill für ausgewählte Zeiträume über `POST /api/v1/replays`
- [x] Datenbankmigrationen versioniert und für bestehende Installationen ausführbar machen
- [ ] Backups, Restore-Tests und Aufbewahrungsregeln

### Betrieb und Observability

- [ ] Strukturierte Logs mit Correlation-/Trace-IDs
- [ ] Metriken für Connectoren, Queue-Lag, Medienjobs, KI-Latenz und Fehlerquoten
- [ ] Dashboards und Alerts für Prometheus/Grafana
- [ ] Healthchecks um externe Abhängigkeiten und fachliche Readiness ergänzen
- [ ] Produktionsdeployment mit TLS, Netzwerksegmentierung und Secret-Rotation
- [ ] Worker-Pools und CPU-/RAM-Limits für whisper.cpp und KI-Verarbeitung
- [ ] Kosten- und Speicherlimits für Medien, Modelle und Analysehistorie

### Qualitätssicherung

- [ ] Unit-Tests für Connector-Normalisierung und Event-Aggregation
- [ ] Fixture- und Contract-Tests für WhatsApp und Telegram
- [ ] API-Integrationstests mit Datenbank und NATS
- [ ] UI-E2E-Tests für Onboarding, Auswahl, Suche und Event-Details
- [ ] Tests für Datenschutz, Löschung, Rechte und Mandantentrennung
- [ ] Last- und Stabilitätstests mit großen Gruppenverläufen
- [ ] Sicherheitsprüfung und Dependency-Scanning

## Phase 3 – Produkt-Ausbau

Ziel: Aus der Analyseoberfläche wird ein persönlicher Gruppenassistent.

- [ ] Benachrichtigungen und tägliche/wöchentliche Zusammenfassungen
- [ ] Kalenderintegration für erkannte Termine
- [ ] Export nach JSON, CSV, PDF und Kalenderformaten
- [ ] Semantische Suche über Nachrichten, Events und Orte
- [x] Feedbackschleife für Nutzerkorrekturen und kanonische Alias-/Beziehungsaktualisierung
- [ ] Modellverbesserung aus dem Feedback-Datensatz und automatisierte Schwellenwert-Evaluation (über die lokale Wortgewichtung hinaus)
- [ ] Benutzerspezifische Relevanzregeln und thematische Profile
- [ ] Erweiterte Kartenansicht mit Event-Zeitachse und Routen
- [ ] Weitere Connectoren über das gemeinsame Connector-SDK
- [ ] Optionaler lokaler oder selbst betriebener Tile-Provider für größere Installationen

## Wichtigste Risiken

1. Die whatsmeow-Integration nutzt ein inoffizielles WhatsApp-Web-/Multi-Device-Protokoll. Protokolländerungen, Rate-Limits oder Kontosperren können die Verfügbarkeit beeinträchtigen.
2. Gruppeninhalte können private Nachrichten, Personenbezug, Audio und Standortdaten enthalten. Datenschutz und Zugriffsschutz sind daher produktkritisch.
3. Öffentliche OpenStreetMap-Tiles sind für die Demo geeignet, aber nicht automatisch für hohe Produktionslast.
4. KI-Ergebnisse dürfen ohne Qualitätssicherung, Quellenanzeige und Nutzerkontrolle nicht als verlässliche Fakten behandelt werden.
5. Medien- und Modellvolumen können schnell wachsen und benötigen Limits, Aufbewahrung und Backups.

## Definition of Done für eine erste Beta

Die Beta ist erreicht, wenn:

- ein Nutzer sich anmelden und seine Connectoren sicher konfigurieren kann,
- reale WhatsApp- und Telegram-Nachrichten inklusive Medien persistent verarbeitet werden,
- Audio lokal transkribiert sowie Bilder per OCR/Analyse verarbeitet werden,
- jedes KI-Ergebnis auf Quellnachrichten zurückgeführt werden kann,
- Nutzer Daten suchen, korrigieren, exportieren und löschen können,
- Jobs nach Fehlern automatisch wiederaufgenommen werden,
- Backups, Monitoring und Restore erfolgreich getestet sind,
- automatisierte Connector-, API- und UI-Tests die Kernpfade abdecken.

## Empfohlene Reihenfolge

1. Medienpipeline und reale Transkription abschließen
2. Authentifizierung, Rechte und Datenschutzgrundlagen einführen
3. Queue-Sicherheit, Idempotenz, Retry und Monitoring ergänzen
4. KI-Adapter und Evaluationsdatensatz aufbauen
5. Event-Detailansicht, Suche, Korrektur und Export liefern
6. Produktionsdeployment, Backups und Lasttests durchführen
