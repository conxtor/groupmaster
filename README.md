# WAGI · WhatsApp Group Intelligence

Ein MVP-Monorepo für die Auswertung klassischer WhatsApp-Gruppen normaler Consumer-Nutzer. Ein verknüpftes WhatsApp-Gerät liefert Gruppen und Nachrichten über einen austauschbaren Connector; die Anwendung persistiert sie, verarbeitet Audio asynchron und erzeugt strukturierte KI-Ergebnisse für ein Dashboard.

Die priorisierte Produktplanung mit Beta-Ziel, Produktionsreife, Risiken und Definition of Done steht in [ROADMAP.md](ROADMAP.md).

## Schnellstart

Voraussetzungen: Docker Desktop mit Compose sowie Node.js 20 und npm für lokale Frontend-/Connector-Entwicklung.

```bash
cp .env.example .env
docker-compose -f infra/docker/docker-compose.yml up --build
```

Danach:

- Dashboard: http://localhost:3000
- Go API: http://localhost:8080/readyz
- Connector-Pairing: http://localhost:3001/pairing
- Telegram-Bot-Status und Einrichtung: http://localhost:3002/bot
- NATS Monitoring: http://localhost:8222
- MinIO Console: http://localhost:9001

## Konfiguration

Alle Einstellungen werden über `.env` gesetzt. Die Ausgangswerte stehen in
[`.env.example`](.env.example). Nach Änderungen an Umgebungsvariablen die
betroffenen Services neu erstellen:

```bash
docker-compose -f infra/docker/docker-compose.yml up -d --build wa-connector tg-connector ai-worker media-worker
```

`.env` enthält Zugangsdaten und darf nicht committed werden. Innerhalb der
Compose-Container werden Datenbank, NATS und MinIO über die internen
Servicenamen erreicht; die Werte in `.env.example` sind für lokale Prozesse
außerhalb von Compose gedacht.

### Dashboard-Sprache

Das Dashboard unterstützt derzeit Deutsch (`de`), Spanisch (`es`),
Katalanisch (`ca`), Englisch (`en`) und Französisch (`fr`). Beim ersten Besuch
wird die Browsersprache verwendet und auf eine dieser fünf Sprachen abgebildet;
wenn keine passende Sprache erkannt wird, startet die Oberfläche auf Deutsch.
Die aktuelle Auswahl kann jederzeit über das Sprachfeld im Kopfbereich geändert
werden. Sie wird als Cookie `wagi_locale` für ein Jahr im Browser des jeweiligen
Nutzers gespeichert und hat bei späteren Besuchen Vorrang vor der
Browsersprache.

### WhatsApp-Konnektor

Der WhatsApp-Konnektor verwendet für Consumer-Accounts ein Linked Device über
Baileys. Für die Demo ist er zunächst im Mock-Modus aktiv:

```dotenv
WA_MOCK_MODE=true
WA_GROUP_ALLOWLIST=
WA_AUTH_DIR=./data/wa-auth
```

Für ein echtes Konto:

1. `WA_MOCK_MODE=false` in `.env` setzen.
2. Den Konnektor starten: `docker-compose -f infra/docker/docker-compose.yml up -d --build wa-connector`.
3. Den QR-Code mit `docker-compose -f infra/docker/docker-compose.yml logs -f wa-connector` anzeigen und in WhatsApp unter **Verknüpfte Geräte** scannen.
4. Den persistenten Compose-Speicher `wa_auth` beibehalten. Dadurch muss das Gerät nach Neustarts nicht erneut gekoppelt werden.
5. Gruppen im Dashboard auswählen oder bereits beim Einlesen mit `WA_GROUP_ALLOWLIST` begrenzen.

`WA_GROUP_ALLOWLIST` ist eine kommagetrennte Liste exakter WhatsApp-Gruppen-
JIDs, zum Beispiel `120363123456789@g.us`. Eine leere Liste lässt alle
entdeckten Gruppen zu; die eigentliche Verarbeitung eingehender Nachrichten
erfolgt nur für Gruppen, die in der Datenbank als ausgewählt markiert sind.

Status und Pairing-Informationen sind unter
`http://localhost:3001/healthz`, `http://localhost:3001/readyz` und
`http://localhost:3001/pairing` verfügbar. Der QR-Code wird zusätzlich in den
Connector-Logs ausgegeben.

Wichtig: Baileys ist keine offizielle WhatsApp-Business-API. Der Abschnitt
setzt daher ein privates Testkonto, die Zustimmung der Gruppenmitglieder und
die Akzeptanz möglicher Protokolländerungen oder Account-Sperren voraus. Siehe
auch [Bekannte Risiken und Sicherheitsgrenzen](#bekannte-risiken-und-sicherheitsgrenzen).

### Telegram-Konnektor

Der Telegram-Konnektor nutzt die offizielle Telegram Bot API per Long Polling.
Er benötigt keinen Benutzer-Login, sondern einen Bot-Token:

```dotenv
TG_BOT_TOKEN=123456789:replace-with-token-from-botfather
TG_GROUP_ALLOWLIST=
TG_STATE_DIR=./data/tg-state
TG_POLL_TIMEOUT=25
```

Einrichtung:

1. Mit [@BotFather](https://core.telegram.org/bots#how-do-i-create-a-bot) einen Bot anlegen und den Token in `TG_BOT_TOKEN` eintragen.
2. Den Bot zu den gewünschten Gruppen, Supergroups oder Channels hinzufügen.
3. In Gruppen den Bot als Administrator setzen oder beim BotFather mit `/setprivacy` den Privacy Mode deaktivieren, damit normale Gruppennachrichten zugestellt werden.
4. In Channels den Bot als Mitglied hinzufügen; für administrative Bot-Aktionen sind passende Rechte erforderlich.
5. Den Konnektor starten: `docker-compose -f infra/docker/docker-compose.yml up -d --build tg-connector`.
6. Unter `http://localhost:3002/bot` den Bot-Status prüfen; `http://localhost:3002/readyz` zeigt bei fehlendem Token `waiting-for-bot-token`.

Mit `TG_GROUP_ALLOWLIST` kann die Verarbeitung begrenzt werden. Unterstützt
werden die numerische Chat-ID, die Form `tg:<chat-id>` oder ein öffentlicher
Username:

```dotenv
TG_GROUP_ALLOWLIST=-1001234567890,tg:-1009876543210,@meine_gruppe
```

Eine leere Allowlist verarbeitet alle Gruppen, Supergroups und Channels, die
der Bot entdeckt. Private Chats werden nicht importiert. Der Offset wird in
`TG_STATE_DIR` gespeichert; der Compose-Speicher `tg_state` sollte für stabile
Fortsetzung nach Neustarts erhalten bleiben. Der Bot erhält grundsätzlich nur
Updates, die Telegram während seiner Mitgliedschaft und gemäß seinen
Berechtigungen liefert; eine rückwirkende Vollsynchronisierung der alten
Gruppenhistorie ist im MVP nicht enthalten.

### KI- und Audio-Konnektoren

Der AI-Worker benötigt im MVP keinen externen LLM-API-Key. Er verwendet das
lokale, deterministische Analyseprofil `heuristic-mvp` und erzeugt validierte
strukturierte Ergebnisse für Relevanz, Facts, Entities, Events, Places und
Zusammenfassungen:

```dotenv
AI_MODEL=heuristic-mvp
```

`AI_MODEL` wird aktuell als Modellbezeichnung im Ergebnis geführt. Ein
externer LLM-Provider ist noch nicht angeschlossen; Provider, API-Key,
Prompt-Versionen und Modellwahl werden später hinter einem AI-Adapter ergänzt.
Der Worker verbindet sich in Compose automatisch mit PostgreSQL und NATS.

Audiotranskriptionen laufen lokal mit `whisper.cpp` und dem multilingualen
`medium`-Modell. Die relevanten Einstellungen sind:

```dotenv
WHISPER_ENABLED=true
WHISPER_MODEL=medium
WHISPER_LANGUAGE=auto
WHISPER_LANGUAGES=es,ca,de,en,fr
WHISPER_THREADS=4
```

`WHISPER_LANGUAGE=auto` aktiviert die automatische Spracherkennung. Für eine
feste Sprache beispielsweise `WHISPER_LANGUAGE=de` setzen. Eine Sprache muss
zusätzlich in `WHISPER_LANGUAGES` stehen; weitere Sprachen lassen sich so
freischalten, zum Beispiel `WHISPER_LANGUAGES=es,ca,de,en,fr,it,pt`.
`WHISPER_THREADS` steuert die CPU-Parallelität. Das Modell wird im persistenten
Compose-Speicher `whisper_models` abgelegt und beim ersten Start geladen.

Mit `WHISPER_ENABLED=false` bleibt die Audio-Pipeline aktiv, verwendet aber
nur das MVP-Platzhalterergebnis. Im aktuellen MVP wird das eigentliche
WhatsApp-Audio noch nicht aus WhatsApp/Telegram nach MinIO geladen; ohne lokal
vorhandene Audioquelle wird deshalb ebenfalls ein Platzhalter erzeugt. Die
vollständige Medienübernahme ist in [ROADMAP.md](ROADMAP.md) dokumentiert.

Die Compose-Umgebung startet standardmäßig im `WA_MOCK_MODE=true`, damit die vertikale Kette ohne WhatsApp-Konto demonstrierbar ist. Sie erzeugt drei ausgewählte Gruppen mit jeweils zehn Nachrichten: Text, Antworten, Sprachnachrichten, Bilder und Orte. Die Mock-Dialoge enthalten außerdem zusammengehörige Event-Bausteine, zum Beispiel einen Termintext in einer Nachricht und den Treffpunkt in einer späteren Ortsnachricht. Der AI-Worker verknüpft solche Quellen über `sourceMessageIds`. Für die Konfiguration eines echten Linked Devices und die Gruppenauswahl siehe [WhatsApp-Konnektor](#whatsapp-konnektor).

## Architektur

| Bereich | MVP-Implementierung |
| --- | --- |
| WhatsApp | Node.js/TypeScript, Baileys, persistenter Multi-File-Auth-State |
| Telegram | Node.js/TypeScript, offizieller Bot API Connector, Long Polling, Offset-State |
| Eventing | NATS mit JetStream-fähigem Server, Subjects `wa.*`, `media.*`, `ai.*` |
| Persistenz | PostgreSQL mit PostGIS und pgvector, Migration `infra/migrations/001_init.sql` |
| Medien | MinIO/S3-Konvention, Audio-Job-Pipeline |
| STT | lokales `whisper.cpp`, Modell `medium`, ffmpeg-Normalisierung, JSON-Ergebnis |
| Karten | Leaflet mit OpenStreetMap-Tiles und sichtbarer OSM-Attribution |
| KI | `ai-worker`, validiertes strukturiertes Schema für Relevanz, Facts, Entities, Events, Places und Summary |
| API | Go Standard Library + pgx, Health-/Readiness-/Metrics-Endpunkte |
| UI | Next.js/React, responsive Gruppen- und Nachrichtenübersicht |

PlantUML-Diagramme liegen in `docs/plantuml`: Gesamtarchitektur, Ingestion-Sequenz, KI-Pipeline, Deployment und Datenmodell. Die Mock-Bilder liegen unter `apps/web/public/mock`; Event-Karten werden im Dashboard interaktiv mit Leaflet gerendert und zeigen die Koordinaten aus den mehrteiligen Event-Quellen.

Die Demo verwendet den öffentlichen OpenStreetMap-Tile-Dienst mit vorgeschriebener Attribution. Für größere oder produktive Installationen muss die [OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) beachtet und gegebenenfalls ein eigener oder dedizierter Tile-Provider eingesetzt werden.

## Lokale Entwicklung

```bash
npm install
npm run build --workspace=@wagi/contracts
npm run build --workspace=@wagi/connector-sdk
npm run dev --workspace=@wagi/wa-connector
npm run dev --workspace=@wagi/web
```

Die API und Worker werden primär über Compose gestartet. Die Datenbankmigrationen laufen automatisch beim ersten Start eines frischen `postgres_data`-Volumes. Für einen erneuten lokalen Test kann das Volume gezielt über Compose entfernt werden.

## API-Endpunkte

- `GET /healthz` und `GET /readyz`
- `GET /api/v1/groups`
- `PUT /api/v1/groups/{groupId}/select` mit `{ "selected": true|false }`
- `GET /api/v1/messages?limit=100`
- `POST /api/v1/audio/jobs` mit `messageId`, `mediaKey`, optional `mediaMime`
- `GET /metrics`

## Bekannte Risiken und Sicherheitsgrenzen

Baileys kommuniziert über das inoffizielle WhatsApp-Web-/Multi-Device-Protokoll und ist keine offizielle WhatsApp Business API. Änderungen am Protokoll, Rate-Limits, Account-Sperren und eine mögliche Unvereinbarkeit mit WhatsApp-Nutzungsbedingungen sind reale Betriebsrisiken. Der Connector muss deshalb als austauschbarer Adapter behandelt werden.

Der MVP verarbeitet ausschließlich Gruppen, die der verknüpfte Account selbst sehen kann. Trotzdem können private Inhalte, personenbezogene Daten, Audio und Standortdaten verarbeitet werden. Vor einem produktiven Einsatz braucht es Einwilligungs-/Hinweisprozesse, Löschfristen, Verschlüsselung, Zugriffskontrollen, Auditierung, Tenant-Isolation, Secret-Management sowie eine rechtliche Prüfung für Datenschutz und Plattformbedingungen.

## Nächste Schritte

1. JetStream-Streams und Consumer explizit provisionieren und mit Retry/DLQ/idempotenter Verarbeitung absichern.
2. MinIO-Upload/Download sowie echte WhatsApp-Medienentschlüsselung ergänzen.
3. whisper.cpp als optionalen Worker-Pool mit CPU-/GPU-Profilen betreiben.
4. LLM-Provider hinter einem AI-Adapter mit JSON-Schema-Validierung, Prompt-Versionen und Evaluationsdatensatz anbinden.
5. OIDC-Login, Rollen, Audit-Log und Datenschutzfunktionen implementieren.
6. Connector-Tests mit Fixtures, API-Integrationstests und UI-E2E-Tests hinzufügen.
7. Telegram-Dateien über `getFile` laden und in MinIO ablegen; der MVP speichert zunächst Telegram-`file_id`-Referenzen und stößt Audio-Jobs an.
