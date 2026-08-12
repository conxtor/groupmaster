# WAGI · WhatsApp Group Intelligence

Ein MVP-Monorepo für die Auswertung klassischer WhatsApp-Gruppen normaler Consumer-Nutzer. Ein verknüpftes WhatsApp-Gerät liefert Gruppen und Nachrichten über einen austauschbaren Connector; die Anwendung persistiert sie, verarbeitet Audio asynchron und erzeugt strukturierte KI-Ergebnisse für ein Dashboard.

Die priorisierte Produktplanung mit Beta-Ziel, Produktionsreife, Risiken und Definition of Done steht in [ROADMAP.md](ROADMAP.md).

## Schnellstart

Voraussetzungen: Docker oder Colima mit `docker-compose` sowie Node.js 20 und npm für lokale Frontend-/Connector-Entwicklung.

```bash
cp .env.example .env
docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build
```

Danach stellt der NGINX-Gateway Web-App und API über denselben Host und Port
bereit. Standardmäßig ist das `http://localhost:3000`; der öffentliche Port kann
mit `WAGI_PUBLIC_PORT` geändert werden.

Danach:

- Dashboard: http://localhost:3000
- Gruppenauswahl: http://localhost:3000/groups
- Knowledge Base: http://localhost:3000/knowledge
- Go API über denselben Einstiegspunkt: http://localhost:3000/readyz
- Connector-Einrichtung: http://localhost:3000/connectors
- Connector-Status: in der Connector-Einrichtung unter `/connectors`
- NATS und MinIO: intern im Docker-Netz, standardmäßig ohne Host-Portfreigabe

Die API-Route ist unter `/api/` erreichbar, zum Beispiel
`http://localhost:3000/api/v1/auth/me`. Der Go-API-Port 8080 und der Next.js-
Port 3000 werden im Compose-Standard nicht direkt auf den Host veröffentlicht;
NGINX leitet intern `/api/` an die API und alle übrigen Anfragen an die
Web-App weiter.

## Konfiguration

Alle Einstellungen werden über `.env` gesetzt. Die Ausgangswerte stehen in
[`.env.example`](.env.example). Nach Änderungen an Umgebungsvariablen die
betroffenen Services neu erstellen:

```bash
docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build wa-connector tg-connector ai-worker media-worker
```

`.env` enthält Zugangsdaten und darf nicht committed werden. Innerhalb der
Compose-Container werden Datenbank, NATS und MinIO über die internen
Servicenamen erreicht; die Werte in `.env.example` sind für lokale Prozesse
außerhalb von Compose gedacht.

Für die interne Bereinigung verlassener Gruppen wird ein gemeinsames, zufällig
gewähltes Secret benötigt. In einer neuen lokalen Umgebung `MEDIA_CLEANUP_TOKEN`
in `.env` durch einen eigenen Wert ersetzen, zum Beispiel mit
`openssl rand -hex 32`. Der Token wird nur zwischen den Konnektoren und dem
Media-Worker verwendet und nicht im Dashboard angezeigt.

Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf
`supabase_admin` stehen. Dieser Wert ist im `.env.example` und in Compose der
Standard; ein vorhandener `.env`-Eintrag mit `POSTGRES_USER=postgres` sollte
entsprechend angepasst werden.

### Gemeinsamer Web-/API-Einstiegspunkt

Für das spätere öffentliche Deployment muss in der Regel nur der NGINX-Port
veröffentlicht und dort TLS vorgeschaltet werden. Die Web-App verwendet im
Standard relative API-URLs (`/api/...`), daher bleiben Cookies und Medien-URLs
im selben Origin. `NEXT_PUBLIC_API_URL` bleibt dafür leer. Nur wenn ein
separates Frontend oder ein Browser-Client direkt von einer anderen Origin auf
die API zugreifen soll, wird dort eine vollständige API-URL eingetragen und
zusätzlich `WAGI_CORS_ORIGIN` auf diese Origin gesetzt.

### Connector-Setup auf eigener Seite

Die erstmalige Einrichtung von WhatsApp und Telegram erfolgt auf der separaten
Seite `http://localhost:3000/connectors` über QR-Codes. Ein Setup-Token ist dafür nicht erforderlich. Der QR-Code wird immer
für das authentifizierte Nutzerkonto angefordert und über die API an genau
diesen Nutzer zurückgeroutet; globale Connector-Endpunkte liefern keinen QR
mehr aus. Der Telegram-Connector ist für die lokale Testumgebung an allen
Interfaces verfügbar.

Der technische Telegram-Status ist nur innerhalb des Compose-Netzes unter
`http://tg-connector:3002/status` erreichbar; der QR-Start erfolgt ausschließlich per authentifizierter API für ein konkretes
Connector-Konto (`POST /api/v1/connectors/accounts/{accountId}/qr`). Die
Connector-Endpunkte bleiben für Healthchecks erreichbar, geben aber keinen
globalen QR-Code mehr aus.

Die Auswahl der zu verarbeitenden Quellen erfolgt separat unter
`http://localhost:3000/groups`. Das Haupt-Dashboard zeigt ausschließlich
ausgewählte Gruppen. Telegram-Topics aus Foren-Supergroups werden dort als
Untergruppen unter ihrer jeweiligen Supergroup angezeigt und können unabhängig
ausgewählt oder entfernt werden. Nachrichten werden ebenfalls unter der
ausgewählten Untergruppe gespeichert.

Anschließend die Konnektoren und das Web-Dashboard neu erstellen:

```bash
docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build nginx wa-connector tg-connector
```

Die Connector-Seite ruft die lokalen Connectoren automatisch ab. Danach gilt:

1. Auf der Connector-Seite beim gewünschten Nutzerkonto **WhatsApp-QR starten** wählen.
   WhatsApp zeigt dann den aktuellen Linked-Device-QR-Code an. In der WhatsApp-App
   unter **Verknüpfte Geräte** → **Gerät hinzufügen** scannen.
2. Telegram zeigt im Direktmodus nach **Telegram-QR starten** einen QR-Code
   an. Diesen in der Telegram-App unter **Einstellungen** → **Geräte** →
   **Desktop-Gerät verknüpfen** scannen.
3. Status, Ablaufzeit des QR-Codes und erneute Anmeldung werden auf der Connector-Seite
   angezeigt.

Für Telegram müssen zusätzlich `TG_API_ID` und `TG_API_HASH` gesetzt sein.
Wenn Telegram eine Zwei-Faktor-Anmeldung verlangt, wird das Passwort nicht
über das Web-UI übertragen; die einmalige Anmeldung erfolgt sicher im lokalen
Terminal über `npm run auth --workspace=@wagi/tg-connector`. Danach kann die
gespeicherte Session vom Connector weiterverwendet werden.

Ein QR-Code kann ein Konto autorisieren und darf deshalb nicht geteilt oder in
Logs veröffentlicht werden.

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
WA_SYNC_HISTORY=false
WA_BACKFILL_DAYS=7
WA_BACKFILL_THROTTLE_MS=250
WA_BACKFILL_GROUP_DELAY_MS=1500
WA_HISTORY_PAGE_SIZE=50
WA_HISTORY_MAX_PAGES=20
WA_HISTORY_WAIT_MS=20000
```

Für ein echtes Konto:

1. `WA_MOCK_MODE=false` in `.env` setzen.
2. Den Konnektor starten: `docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build wa-connector`.
3. Die Connector-Seite öffnen und den angezeigten QR-Code in WhatsApp unter **Verknüpfte Geräte** → **Gerät hinzufügen** scannen. QR-Payloads werden aus Sicherheitsgründen nicht in Docker-Logs ausgegeben.
4. Den persistenten Compose-Speicher `wa_auth` beibehalten. Dadurch muss das Gerät nach Neustarts nicht erneut gekoppelt werden.
5. Gruppen im Dashboard auswählen oder bereits beim Einlesen mit `WA_GROUP_ALLOWLIST` begrenzen.

`WA_GROUP_ALLOWLIST` ist eine kommagetrennte Liste exakter WhatsApp-Gruppen-
JIDs, zum Beispiel `120363123456789@g.us`. Eine leere Liste entdeckt Gruppen
für die Auswahl im Dashboard, aktiviert aber keine Gruppe automatisch. Die
eigentliche Verarbeitung eingehender Nachrichten erfolgt nur für Gruppen, die
in der Datenbank als ausgewählt markiert sind. Die Auswahl kann jederzeit im
Dashboard geändert werden.

Bei der ersten Aktivierung und bei jedem Systemneustart eines WhatsApp-
Konnektors werden nur Nachrichten innerhalb des Zeitfensters
`WA_BACKFILL_DAYS` (Standard: sieben Tage) persistiert und an die Medien-/KI-
Pipeline weitergegeben. Pro Gruppe werden History-Seiten mit maximal
`WA_HISTORY_PAGE_SIZE` Nachrichten angefordert und vollständig abgewartet,
bevor der Worker seinen Pool-Slot freigibt. `WA_HISTORY_MAX_PAGES` begrenzt die
Anzahl der Seiten pro Gruppe; `WA_HISTORY_WAIT_MS` ist die maximale Wartezeit
auf eine History-Antwort. `WA_BACKFILL_THROTTLE_MS` pausiert zwischen einzelnen
Nachrichten, `WA_BACKFILL_GROUP_DELAY_MS` zwischen Gruppen.

Die WhatsApp-Gruppenliste wird nach jeder erfolgreichen Verbindung und danach
regelmäßig aktualisiert. Das Intervall wird über
`GROUP_REFRESH_INTERVAL_MS` gesteuert und beträgt standardmäßig 60 Sekunden
(mindestens 30 Sekunden). Gruppen, die in einem erfolgreichen Snapshot nicht
mehr vorhanden sind, werden aus der Auswahl und dem Dashboard entfernt. Die
zugehörigen Nachrichten, Analysen, Events, Knowledge-Base-Daten, Audiojobs und
Medienreferenzen werden per Datenbank-Cascade gelöscht; die referenzierten
Objekte in MinIO und lokale Mediendateien werden vorher ebenfalls entfernt.
Bei einem fehlgeschlagenen Snapshot findet keine automatische Löschung statt.

Status und Pairing-Informationen sind auf der Connector-Seite verfügbar. Die
technischen Connector-Endpunkte bleiben für interne Docker-Healthchecks unter
`wa-connector:3001` und `tg-connector:3002` erreichbar, werden aber nicht auf
Host-Ports veröffentlicht. QR-Payloads
werden ausschließlich über die authentifizierte API an das jeweilige Nutzerkonto
ausgeliefert und nicht in Connector-Logs geschrieben.

Wichtig: Baileys ist keine offizielle WhatsApp-Business-API. Der Abschnitt
setzt daher ein privates Testkonto, die Zustimmung der Gruppenmitglieder und
die Akzeptanz möglicher Protokolländerungen oder Account-Sperren voraus. Siehe
auch [Bekannte Risiken und Sicherheitsgrenzen](#bekannte-risiken-und-sicherheitsgrenzen).

### Telegram-Konnektor

Der Telegram-Konnektor verwendet bevorzugt eine direkte persönliche Telegram-
Verbindung über MTProto. Dadurch kann der verbundene Nutzer seine eigenen
Gruppen und Channels lesen und die Historie der letzten drei Tage zum ersten
Aktivierungszeitpunkt nachladen. Die direkte Verbindung wird aktiviert, sobald
`TG_API_ID` und `TG_API_HASH` gesetzt sind:

```dotenv
TG_API_ID=123456
TG_API_HASH=replace-with-api-hash
TG_PHONE=+491701234567
TG_SESSION=
TG_GROUP_ALLOWLIST=
TG_STATE_DIR=./data/tg-state
TG_BACKFILL_DAYS=7
TG_BACKFILL_THROTTLE_MS=500
TG_BACKFILL_GROUP_DELAY_MS=2000
TG_CONNECTION_RETRIES=12
TG_REQUEST_RETRIES=8
TG_DOWNLOAD_RETRIES=8
TG_RETRY_DELAY_MS=2000
TG_MEDIA_RETRY_ATTEMPTS=4
```

API-ID und API-Hash werden unter [my.telegram.org/apps](https://my.telegram.org/apps)
erstellt. Die persönliche Session wird einmalig interaktiv erzeugt:

```bash
npm run auth --workspace=@wagi/tg-connector
```

Der Befehl fragt den Telegram-Bestätigungscode und bei aktivierter 2FA das
Passwort ausschließlich im lokalen Terminal ab. Die Session wird als
`direct-session.txt` im persistenten `TG_STATE_DIR` gespeichert und danach vom
Docker-Konnektor automatisch wiederverwendet. Nach der Verbindung werden alle
erreichbaren Telegram-Gruppen, Supergroups und Channels als auswählbare Liste
entdeckt; keine Gruppe wird automatisch aktiviert. Die Liste wird nach dem
Verbindungsaufbau und anschließend regelmäßig mit
`GROUP_REFRESH_INTERVAL_MS` (Standard: 60 Sekunden, mindestens 30 Sekunden)
aktualisiert. Supergroup-Topics werden bei der Synchronisierung als
Untergruppen geführt. Beim Aktivieren eines Eintrags und bei jedem Neustart
lädt der Connector höchstens die letzten `TG_BACKFILL_DAYS` (Standard:
sieben) Tage nach und empfängt anschließend neue Nachrichten über MTProto-
Events. Der Neustart-Backfill pausiert standardmäßig 500 ms zwischen
Nachrichten und 2 Sekunden zwischen Gruppen; die Werte lassen sich über
`TG_BACKFILL_THROTTLE_MS` und `TG_BACKFILL_GROUP_DELAY_MS` anpassen. Das gilt
auch für später neu entdeckte Gruppen und Channels.

Wenn ein Nutzer eine Gruppe, einen Channel oder ein Topic verlässt, wird der
Eintrag nach einem erfolgreichen Telegram-Snapshot aus der Auswahl und dem
Dashboard entfernt. Die Löschkette entfernt die gruppenbezogenen Daten aus
PostgreSQL und löscht die dazugehörigen Medienobjekte in MinIO. Ein nicht
vollständig gelungener Snapshot löst aus Sicherheitsgründen keine Bereinigung
aus. Im optionalen Bot-Modus wird die Entfernung über Telegrams
`my_chat_member`-Ereignis erkannt; die Bot API kann keine vollständige Liste
aller Dialoge des Bots liefern.

Im Direktmodus kann die Anmeldung bevorzugt direkt im Dashboard erfolgen: Im
Telegram-Connector-Panel **Telegram-QR starten** auswählen und den QR-Code in
der Telegram-App unter **Einstellungen** → **Geräte** scannen. Der QR-Login ist
für die normale Anmeldung ohne zusätzliches Passwort gedacht. Bei aktivierter
Telegram-2FA ist der lokale `npm run auth --workspace=@wagi/tg-connector`-Weg
erforderlich; ein 2FA-Passwort wird aus Sicherheitsgründen nicht über das Web-
UI angenommen.

Wenn keine direkten Zugangsdaten gesetzt sind, bleibt die bisherige Bot-API-
Integration als optionaler Fallback verfügbar. Dafür wird ein Bot-Token
benötigt:

```dotenv
TG_BOT_TOKEN=123456789:replace-with-token-from-botfather
TG_GROUP_ALLOWLIST=
TG_STATE_DIR=./data/tg-state
TG_POLL_TIMEOUT=25
TG_BACKFILL_DAYS=7
TG_CONNECTION_RETRIES=12
TG_REQUEST_RETRIES=8
TG_DOWNLOAD_RETRIES=8
TG_RETRY_DELAY_MS=2000
TG_MEDIA_RETRY_ATTEMPTS=4
```

Einrichtung des optionalen Bot-Fallbacks:

1. Mit [@BotFather](https://core.telegram.org/bots#how-do-i-create-a-bot) einen Bot anlegen und den Token in `TG_BOT_TOKEN` eintragen.
2. Den Bot zu den gewünschten Gruppen, Supergroups oder Channels hinzufügen.
3. In Gruppen den Bot als Administrator setzen oder beim BotFather mit `/setprivacy` den Privacy Mode deaktivieren, damit normale Gruppennachrichten zugestellt werden.
4. In Channels den Bot als Mitglied hinzufügen; für administrative Bot-Aktionen sind passende Rechte erforderlich.
5. Den Konnektor starten: `docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build tg-connector`.
6. Unter `http://localhost:3000/connectors` den Telegram-Status prüfen. Die
technischen Connector-Endpunkte bleiben intern im Compose-Netz verfügbar.

Mit `TG_GROUP_ALLOWLIST` kann die Verarbeitung begrenzt werden. Unterstützt
werden die numerische Chat-ID, die Form `tg:<chat-id>` oder ein öffentlicher
Username:

```dotenv
TG_GROUP_ALLOWLIST=-1001234567890,tg:-1009876543210,@meine_gruppe
```

Eine leere Allowlist aktiviert keine Gruppe automatisch; sie dient nur dazu,
Einträge per Konfiguration vorzuselektieren. Private Chats werden nicht
importiert. Der Offset des Bot-Fallbacks wird in `TG_STATE_DIR` gespeichert; der
Compose-Speicher `tg_state` sollte für stabile Fortsetzung nach Neustarts
erhalten bleiben. Die Bot API stellt keine rückwirkende Gruppenhistorie bereit
und ist deshalb für den Drei-Tage-Backfill nur eingeschränkt geeignet.

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

Die Knowledge-Base verwendet im MVP ein Hybridmodell `hierarchy-v3`: strenge
Evidenzregeln, mehrsprachige Embeddings mit pgvector und optional eine Prüfung
über einen entfernten Hermes-Agent.
Ein einzelnes kurzes Posting, eine reine Terminzeile, ein einzelner Karten-Pin
oder ein zufällig großgeschriebenes Wort erzeugt keinen Knowledge-Base-Eintrag.
Ein Thema benötigt konkrete Detailbegriffe, technische/inhaltliche Evidenz oder
wiederholte Ortsinformationen. Beim ersten Start dieser Heuristik wird die
bisherige Knowledge-Base einmalig aus den ausgewählten Nachrichten neu erzeugt;
die Version wird über `AI_KNOWLEDGE_VERSION` markiert.

Beiträge desselben erkannten Themas werden hierarchisch gespeichert: Ein
übergeordneter Zusammenfassungs-Knoten bündelt die Quellen, darunter liegen
die einzelnen Detailbeiträge. API und Web-Oberfläche sortieren Themen und
Beiträge jeweils mit den neuesten Aktualisierungen zuerst; Unterbeiträge
können im Dashboard ein- und ausgeblendet werden. Die dafür benötigte
Migration liegt in `infra/migrations/004_knowledge_hierarchy.sql`.

Die aktuelle Qualitätskaskade (`cascade-v4`) arbeitet in drei lokalen Stufen:

1. evidenzbasierte Regeln für Relevanz, Event-Kandidaten und Themen;
2. ein begrenztes mehrsprachiges Embedding-Fenster für semantische
   Zusammenführung, stabile Event-/Knowledge-Schlüssel und eine vorsichtige
   hierarchische Speicherung;
3. eine erklärbare Wissensschicht mit kanonischen Aliasen, belegten
   Beziehungen und Nutzerfeedback.

Events benötigen eine konkrete Handlung und einen Zeit- oder Ortsbezug. Ein
reiner Gruß, eine allgemeine Terminzeile oder ein einzelner Karten-Pin wird
nicht mehr als Event ausgegeben. Quellen werden nur in einem zeitlich
begrenzten Nachrichtenfenster und bei Antwortbeziehungen zusammengeführt.
Feedback kann über `POST /api/v1/ai/feedback` mit `targetType` `relevance`,
`event` oder `knowledge` gespeichert werden. Eine Rückmeldung löst die
erneute Analyse der betroffenen Nachricht aus. Bei Knowledge-Korrekturen mit
`alias`, `canonicalKey` und optional `topicKey` wird zusätzlich ein
gruppengebundener kanonischer Begriff gelernt.

Die Persistenz dafür liegt in `infra/migrations/011_ai_quality_feedback.sql`.
Sie enthält Feedback, kanonische Alias-Zuordnungen und ausschließlich aus
Quellnachrichten abgeleitete Knowledge-Graph-Beziehungen. Der Worker schreibt
keine unbelegten Beziehungen und löscht bei einer expliziten Knowledge-
Ablehnung den betroffenen Eintrag.

Jeder Knowledge-Knoten liefert zusätzlich die vollständigen Quellnachrichten
mit Originaltext und – sofern vorhanden – Bild beziehungsweise Thumbnail. Die
Nachrichten werden nicht mehr auf eine feste Zeichenanzahl gekürzt; eine
geänderte Knowledge-Version löst die einmalige Neubewertung bestehender
Nachrichten aus.

Die semantische Stufe verwendet standardmäßig
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384 Dimensionen)
lokal und speichert die Vektoren in pgvector. Das Modell wird
beim ersten Start geladen und im Compose-Volume `ai_models` zwischengespeichert.
Die Schwellenwerte lassen sich über `AI_SEMANTIC_DISCOVERY_THRESHOLD` und
`AI_SEMANTIC_MERGE_THRESHOLD` anpassen.

Für die Kaskade können Kontextfenster und Event-Schwelle angepasst werden:

```dotenv
AI_PROMPT_VERSION=cascade-v4
AI_KNOWLEDGE_VERSION=cascade-v4
AI_CONTEXT_MAX_MESSAGES=80
AI_EVENT_WINDOW_HOURS=36
AI_EVENT_MIN_CONFIDENCE=0.70
```

Für den Download des Embedding-Modells kann ein Hugging-Face-Token in `.env`
hinterlegt werden. Der Compose-Stack reicht ihn ausschließlich an den
AI-Worker weiter:

```dotenv
HF_TOKEN=hf_...
AI_EMBEDDING_CACHE_DIR=/root/.cache/fastembed
AI_HF_MODEL_LOAD_INTERVAL_SECONDS=86400
```

Das Modell wird in einem persistenten Compose-Volume gecacht, pro Worker nur
einmal geladen und die Embedding-Berechnung läuft danach lokal. Der Standard
von 24 Stunden verhindert unnötige erneute Hub-Abfragen und ist bewusst
konservativ für einen kostenlosen Hugging-Face-Account gewählt. Die genaue
Rate-Limit-Grenze kann Hugging Face ändern; falls `HF_TOKEN` leer bleibt, ist
der Download weiterhin möglich, aber die Anfrage bleibt unauthentifiziert.

Optional kann der Hermes-Agent als strenger Verifier zugeschaltet werden. Der
Hermes-Agent stellt eine OpenAI-kompatible `/v1/chat/completions`-Schnittstelle
bereit; `AI_HERMES_URL` kann entweder auf die Basis-URL, `/v1` oder direkt auf
`/chat/completions` zeigen. Der Worker ruft Hermes nur für unsichere Kandidaten
auf und verwirft sie bei einer expliziten Ablehnung:

```dotenv
AI_HERMES_ENABLED=true
AI_HERMES_URL=https://hermes.example.invalid/v1
AI_HERMES_API_KEY=replace-with-hermes-api-key
AI_HERMES_MODEL=hermes-agent
AI_HERMES_REVIEW_ALL=false
AI_HERMES_MIN_CONFIDENCE=0.78
```

Bei nicht gesetzter Hermes-URL oder einem temporären Hermes-Fehler bleibt die
lokale, nachvollziehbare Verarbeitung aktiv. Die Nachrichten werden für den
Verifier an den konfigurierten Remote-Dienst übertragen; die URL und der API-
Key müssen daher bewusst gesetzt werden.

Hermes ist optional und bleibt ein Fallback: Der Dienst wird nur aktiviert,
wenn `AI_HERMES_ENABLED=true` und eine URL gesetzt sind. Die lokale Kaskade
bleibt die Primärquelle; Hermes prüft nur unsichere Knowledge-Kandidaten.
Bei Fehlern oder Timeout wird das lokale Ergebnis beibehalten.

Audiotranskriptionen laufen lokal mit `whisper.cpp` und dem multilingualen
`medium`-Modell. Die relevanten Einstellungen sind:

```dotenv
WHISPER_ENABLED=true
WHISPER_MODEL=medium
WHISPER_LANGUAGE=auto
WHISPER_LANGUAGES=es,ca,de,en,fr
WHISPER_THREADS=4
MEDIA_MAX_RETRIES=3
MEDIA_STALE_PROCESSING_SECONDS=900
```

`WHISPER_LANGUAGE=auto` aktiviert die automatische Spracherkennung. Für eine
feste Sprache beispielsweise `WHISPER_LANGUAGE=de` setzen. Eine Sprache muss
zusätzlich in `WHISPER_LANGUAGES` stehen; weitere Sprachen lassen sich so
freischalten, zum Beispiel `WHISPER_LANGUAGES=es,ca,de,en,fr,it,pt`.
`WHISPER_THREADS` steuert die CPU-Parallelität. Das Modell wird im persistenten
Compose-Speicher `whisper_models` abgelegt und beim ersten Start geladen.
Fehlgeschlagene Audiojobs werden bis zu `MEDIA_MAX_RETRIES`-mal erneut
eingeplant. Jobs, die länger als `MEDIA_STALE_PROCESSING_SECONDS` (Standard:
15 Minuten) im Status `processing` hängen, werden nach einem Worker-Neustart
automatisch wieder eingeplant oder als fehlgeschlagen markiert.

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
| Telegram | Node.js/TypeScript, direkte MTProto-Session mit historischem Backfill; optionaler Bot-API-Fallback |
| Eventing | NATS mit JetStream-fähigem Server, Subjects `wa.*`, `media.*`, `ai.*` |
| Persistenz | PostgreSQL mit PostGIS und pgvector, vollständige Initialmigration `infra/migrations/001_init.sql` |
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

Die Datenbankmigrationen werden bei `docker-compose up` vom einmalig
ausgeführten `migrate`-Dienst eingespielt. Jede Datei unter
`infra/migrations` wird in `schema_migrations` mit Version und SHA-256-Prüfsumme
protokolliert; dadurch funktionieren neue Migrationen auch mit bereits
vorhandenen PostgreSQL-Volumes. Für eine explizite Ausführung ohne Neustart:

```bash
docker-compose run --rm migrate
```

Die PostgreSQL-Init-Skripte bleiben für ein frisches Volume idempotent. Der
Bootstrap-Administrator wird beim ersten erfolgreichen API-Start angelegt.

## API-Endpunkte

- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`
- `POST /api/v1/auth/register` für normale Nutzerkonten
- `GET/POST /api/v1/connectors/accounts` für eigene persistente Connector-Konten
- `GET /api/v1/admin/users` und `PATCH /api/v1/admin/users/{id}` für Administratoren
- `GET /healthz` und `GET /readyz`
- `GET /api/v1/groups`
- `PUT /api/v1/groups/{groupId}/select` mit `{ "selected": true|false }`
- Die Gruppenverwaltung erfolgt ausschließlich nutzerbezogen unter `/groups`; Administratoren verwalten dort keine Gruppenrechte mehr.
- `GET /api/v1/messages?limit=100` (alle Nachrichten) oder mit
  `&relevant=true` (nur relevante Nachrichten)
- `GET /api/v1/knowledge` oder `GET /api/v1/knowledge?groupId=<selected-group>`
- `POST /api/v1/audio/jobs` mit `messageId`, `mediaKey`, optional `mediaMime`
- `GET /api/v1/replays` zeigt die eigenen Replay-Jobs
- `POST /api/v1/replays` startet einen Replay/Backfill für ausgewählte Gruppen:
  `{ "groupIds": ["..."], "from": "2026-08-01T00:00:00Z", "to": "2026-08-08T00:00:00Z", "includeMedia": true }`
- `GET /metrics`

Replay verarbeitet nur Gruppen, auf die der angemeldete Nutzer Zugriff hat und
die er ausgewählt hat. Der Zeitraum ist auf 366 Tage begrenzt. Nachrichten und
bereits gespeicherte Medien werden erneut in die Analyse-/Medienpipeline
eingereiht; `to` ist der exklusive Endzeitpunkt. Der Fortschritt ist über
`GET /api/v1/replays` und die Seite „Replay / Backfill“ sichtbar.

### Verarbeitung, Wiederanlauf und Dokumente

Der NATS-Provisioner legt den persistenten JetStream-Stream `WAGI_EVENTS`, den
separaten `WAGI_DLQ`-Stream sowie die expliziten Durable Consumer für Nachrichten,
Audio, Bilder, Dokumente und Replay an. Die Consumer verwenden explizite ACKs,
konfigurierbare maximale Zustellungen und exponentielles Backoff. Nach dem
letzten Versuch wird das Ereignis in `event_failures` protokolliert, in `dlq.*`
veröffentlicht und quittiert, damit eine einzelne fehlerhafte Nachricht die
Pipeline nicht blockiert.

Die Worker schreiben vor der Verarbeitung einen Inbox-Eintrag in
`event_inbox`. Dadurch werden doppelte JetStream-Zustellungen sicher erkannt.
Audio- und KI-Jobs werden in `audio_jobs` bzw. `ai_jobs` mit Status, Versuchen,
Fehler und nächstem Versuch gespeichert. Nach einem Neustart werden verwaiste
`processing`-Jobs zurückgesetzt und automatisch erneut eingereiht.

PDF-, DOCX-, TXT-, Markdown-, CSV-, JSON-, XML- und HTML-Dateien werden lokal
analysiert. PDF-Text wird mit `pdftotext` extrahiert; wenn kein Text vorhanden
ist, folgt eine lokale OCR der ersten Seiten. Die extrahierten Inhalte werden
als `media.document.analyzed` an den KI-Worker übergeben und bleiben auf dem
lokalen System.

## Anmeldung, Rollen und Connector-Pool

Die Anwendung legt den in der Compose-Umgebung konfigurierten Bootstrap-
Administrator beim ersten API-Start automatisch an. Die Zugangsdaten werden
nicht in dieser Dokumentation veröffentlicht; setze sie über
`WAGI_BOOTSTRAP_ADMIN_EMAIL`, `WAGI_BOOTSTRAP_ADMIN_NAME` und
`WAGI_BOOTSTRAP_ADMIN_PASSWORD`. Normale Nutzer können sich unter `/register`
selbst registrieren. Sie sehen zunächst keine Gruppen; ein Administrator gibt
in `/admin` Lese- und Verwaltungsrechte pro Gruppe frei. Sitzungen werden als
zufällige, gehashte Token in PostgreSQL gespeichert und als HttpOnly-Cookie
`wagi_session` geführt. Für HTTPS ist `WAGI_COOKIE_SECURE=true` zu setzen.
Im Standardbetrieb über den gemeinsamen NGINX-Einstiegspunkt ist CORS nicht
nötig, weil Browser-Anfragen an `/api/...` same-origin sind. Bei leerem
`WAGI_CORS_ORIGIN` sendet die API deshalb keine CORS-Header. Für einen
separaten Frontend-Host oder einen direkten Browserzugriff auf die API kann
`WAGI_CORS_ORIGIN` weiterhin auf genau diese Origin gesetzt werden.

Die Connectoren unterstützen bei `CONNECTOR_POOL_ENABLED=true` den gemeinsamen
PostgreSQL-Control-Plane. Ein Worker übernimmt ein verfügbares Nutzerkonto über
eine exklusive Lease, erneuert diese regelmäßig und speichert Sitzungsdaten
sowie den letzten Cursor je Gruppe in PostgreSQL. Dadurch darf dieselbe
WhatsApp- oder Telegram-Session nie gleichzeitig von zwei Workern verwendet
werden. Nach dem kontrollierten Backfill und dem Erreichen des aktuellen
Nachrichtenstands wird die Lease automatisch freigegeben;
`CONNECTOR_SYNC_INTERVAL_SECONDS` bestimmt den nächsten Turnus.
Mehrere Worker lassen sich mit Compose starten, zum Beispiel:

```bash
docker-compose up -d --scale wa-connector-worker=4 --scale tg-connector-worker=4
```

`WA_CONNECTOR_POOL_SIZE` und `TG_CONNECTOR_POOL_SIZE` begrenzen die logische
Zahl paralleler Verarbeitungsslots. `WA_ONBOARDING_SLOTS` und
`TG_ONBOARDING_SLOTS` reservieren standardmäßig je einen dedizierten
Onboarding-Konnektor. Diese Dienste lesen keine Nachrichten: Sie nehmen eine
QR-Anfrage für genau ein Nutzerkonto an, lesen nur dessen Gruppen/Topics ein
und geben die Lease danach frei. Die eigentliche Nachrichten- und
Backlog-Verarbeitung erfolgt turnusmäßig durch die Processing-Worker.
Die Zahl der Konten kann kleiner oder größer als die Workerzahl sein. Freie
Worker warten dann auf eine Lease. Nutzerkonten werden nach der Registrierung
über `POST /api/v1/connectors/accounts` angelegt. Für einen
bestimmten Worker kann `WA_CONNECTOR_ACCOUNT_ID` bzw. `TG_CONNECTOR_ACCOUNT_ID`
gesetzt werden. Die Baileys-Auth-Dateien werden zusätzlich als Binärdaten in
`connector_accounts.session_data` gespiegelt; der aktuelle MVP verwendet dafür
noch keine KMS-Schlüssel und benötigt deshalb zusätzlichen Datenbank-/Volume-
Schutz.

Die Worker speichern pro Connector-Konto und Gruppe `connector_cursors`. Beim
Neustart wird weiterhin der Sieben-Tage-Zeitraum gedrosselt geprüft, bereits
verarbeitete Telegram-Nachrichten werden aber ab dem gespeicherten Telegram-
Message-ID-Cursor fortgesetzt. Bei WhatsApp dient der persistierte Cursor der
Nachvollziehbarkeit und die Baileys-History-Abfrage zusätzlich der
Duplikatvermeidung. Gruppen werden automatisch dem Nutzerkonto zugeordnet;
die Auswahl in `/groups` ist pro Nutzer getrennt gespeichert. Entfernte
Gruppen werden aus dessen Auswahl und – falls kein anderer Nutzer mehr Zugriff
hat – mitsamt Nachrichten und Medienbereinigung entfernt.

Events werden weiterhin aus `message_analyses.events` im Dashboard separat
dargestellt. Thematische Fakten und Erkenntnisse werden zusätzlich durch den
AI-Worker erkannt, in `knowledge_topics`/`knowledge_items` gruppiert und unter
`/knowledge` getrennt von Events und relevanten Nachrichten angezeigt.

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
