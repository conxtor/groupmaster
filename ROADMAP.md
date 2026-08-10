# WAGI Roadmap

## Ausgangslage

Der aktuelle Stand ist ein lauffähiger vertikaler MVP für WhatsApp- und Telegram-Gruppen:

- WhatsApp-Connector mit Baileys, QR-/Linked-Device-Skelett und Mock-Daten
- Telegram-Bot-Connector für Gruppen und Channels mit Long Polling
- PostgreSQL mit PostGIS und pgvector, NATS JetStream und MinIO-Grundgerüst
- Audio-Job-Pipeline mit lokalem whisper.cpp und Medium-Modell
- Heuristische Analyse für Relevanz, Facts, Entities, Events, Places und Zusammenfassungen
- Mehrnachrichten-Events mit verknüpften Quellen, Bildern und Leaflet/OpenStreetMap-Karten
- Go-API und Next.js-Dashboard

Der MVP ist damit gut für Demonstration und Architekturvalidierung geeignet, aber noch nicht produktionsfähig.

## Phase 1 – Beta-fähiger Kern

Ziel: Ein einzelner vertrauenswürdiger Nutzer kann reale Gruppen sicher verbinden und die Verarbeitung nachvollziehbar bedienen.

### Konnektoren

- [ ] WhatsApp-Reconnect, Session-Recovery, History-Sync und kontrollierter Backfill
- [ ] Behandlung von Edits, Löschungen, Duplikaten und Nachrichten-Reihenfolge
- [ ] Klare Statusanzeige für QR-Pairing, Session, Fehler und erneute Anmeldung
- [ ] Telegram-Dateien über `getFile` abrufen und in MinIO ablegen
- [ ] Gemeinsames Connector-SDK mit einheitlichem Lebenszyklus und Fehlervertrag

### Medien

- [ ] Echte WhatsApp-Medien herunterladen und entschlüsseln
- [ ] Telegram- und WhatsApp-Medien dauerhaft in MinIO speichern
- [ ] Bild-Thumbnails, Audio-/Videowiedergabe und sichere Download-URLs
- [ ] OCR und erste Bildanalyse für Screenshots, Karten und Dokumente
- [ ] Audio-Worker so verdrahten, dass reale Quelldateien an whisper.cpp übergeben werden
- [ ] Status, Retry und Fehleranzeige für Audiojobs

### KI und Datenqualität

- [ ] Heuristik durch einen austauschbaren LLM-/AI-Adapter ergänzen
- [ ] JSON-Schema-Validierung, Prompt-Versionierung und Modellkonfiguration
- [ ] Evaluationsdatensatz für Deutsch, Spanisch, Katalanisch, Englisch und Französisch
- [ ] Konfidenzen, Quellenbelege und nachvollziehbare Herleitung je Ergebnis
- [ ] Zusammenführung von Events aus mehreren Nachrichten ohne Duplikate
- [ ] Behandlung widersprüchlicher Zeit-, Orts- und Terminangaben

### Nutzeroberfläche

- [ ] Event-Detailansicht mit allen Quellnachrichten
- [ ] Suche und Filter nach Gruppe, Zeitraum, Relevanz, Ort, Event und Medientyp
- [ ] Transkript prüfen und korrigieren
- [ ] Gruppen- und Connector-Setup als verständlicher Onboarding-Prozess
- [ ] Fehler-, Job- und Verbindungsstatus sichtbar machen

## Phase 2 – Produktionsreife

Ziel: Sicherer und betrieblich belastbarer Einsatz mit mehreren Nutzern und Gruppen.

### Sicherheit und Datenschutz

- [ ] OIDC-Login und sichere Session-Verwaltung
- [ ] Rollen und Rechte für Nutzer, Gruppen, Medien und Administration
- [ ] Tenant-Isolation für mehrere Organisationen oder private Arbeitsbereiche
- [ ] Verschlüsselung bei Transport und Speicherung
- [ ] Secret-Management statt ungeschützter `.env`-Werte
- [ ] Löschfristen, selektive Löschung und vollständiger Datenexport
- [ ] Einwilligungs-/Hinweiskonzept, Audit-Log und Datenschutzdokumentation
- [ ] Rechtliche Prüfung der WhatsApp-, Telegram-, Medien- und Kartendienste

### Verarbeitung und Zuverlässigkeit

- [ ] Explizite JetStream-Streams und Consumer provisionieren
- [ ] Retry-Strategien, Dead-Letter-Queues und Backoff
- [ ] Idempotente Verarbeitung mit Outbox- oder Inbox-Muster
- [ ] Wiederanlauf und Recovery für unterbrochene Audio-/KI-Jobs
- [ ] Replay und Backfill für ausgewählte Zeiträume
- [ ] Datenbankmigrationen versioniert und für bestehende Installationen ausführbar machen
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
- [ ] Feedbackschleife für Nutzerkorrekturen und Modellverbesserung
- [ ] Benutzerspezifische Relevanzregeln und thematische Profile
- [ ] Erweiterte Kartenansicht mit Event-Zeitachse und Routen
- [ ] Weitere Connectoren über das gemeinsame Connector-SDK
- [ ] Optionaler lokaler oder selbst betriebener Tile-Provider für größere Installationen

## Wichtigste Risiken

1. Die Baileys-Integration nutzt ein inoffizielles WhatsApp-Web-/Multi-Device-Protokoll. Protokolländerungen, Rate-Limits oder Kontosperren können die Verfügbarkeit beeinträchtigen.
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
