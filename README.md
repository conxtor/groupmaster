# CONXTOR - Messaging Group Intelligence

Ein MVP-Monorepo für die Auswertung klassischer WhatsApp-Gruppen normaler Consumer-Nutzer. Ein verknüpftes WhatsApp-Gerät liefert Gruppen und Nachrichten über einen austauschbaren Connector; die Anwendung persistiert sie, verarbeitet Audio asynchron und erzeugt strukturierte KI-Ergebnisse für ein Dashboard.

Die priorisierte Produktplanung mit Beta-Ziel, Produktionsreife, Risiken und Definition of Done steht in [ROADMAP.md](ROADMAP.md).

Die vollständige Referenz aller Umgebungsvariablen, SMTP-/Mailcow-Beispiele und Produktionshinweise steht in [CONFIGURATION.md](CONFIGURATION.md).

Das Projekt steht unter der [MIT-Lizenz](LICENSE). Copyright © 2026 Volker Kerkhoff.

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
docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build wa-connector wa-connector-worker tg-connector ai-worker media-worker
```

`.env` enthält Zugangsdaten und darf nicht committed werden. Innerhalb der
Compose-Container werden Datenbank, NATS und MinIO über die internen
Servicenamen erreicht; die Werte in `.env.example` sind für lokale Prozesse
außerhalb von Compose gedacht.

Der Medienbucket wird nicht durch einen separaten Init-Container angelegt.
Der `media-worker` stellt `MINIO_BUCKET` vor dem ersten Upload oder Cleanup
idempotent sicher; der persistente MinIO-Speicher bleibt bei Neustarts erhalten.

### Email-Verifizierung und Passwort-Reset

Neue Nutzerkonten werden erst nach Bestätigung der E-Mail-Adresse aktiviert.
Die Formulare für Anmeldung, Registrierung und Passwort-Reset unterstützen
Deutsch, Spanisch, Katalanisch, Englisch und Französisch. Die ausgewählte
Sprache wird als `wagi_locale`-Cookie gespeichert und für die jeweilige
Verifizierungs- bzw. Reset-Mail verwendet.

Administratoren verwalten Nutzer am Anfang der Admin-Seite und können dort
neue Nutzer direkt mit Rolle und Startpasswort anlegen. Jeder Nutzer kann sein
Profil unter `/profile` bearbeiten. Änderungen der E-Mail-Adresse erfordern
das aktuelle Passwort und eine erneute E-Mail-Verifizierung; eine
Passwortänderung beendet die bestehenden Sitzungen.

Für lokale Tests ist SMTP standardmäßig deaktiviert. Für Registrierung und
Passwort-Reset SMTP in `.env` aktivieren. Mailcow verwendet typischerweise
Port 587 mit STARTTLS:

```dotenv
WAGI_PUBLIC_URL=https://conxtor.com
SMTP_ENABLED=true
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USERNAME=noreply@conxtor.com
SMTP_PASSWORD=replace-with-mailbox-password
SMTP_USE_TLS=true
SMTP_USE_SSL=false
SMTP_FROM_EMAIL=noreply@conxtor.com
SMTP_FROM_NAME=WAGI
```

Gmail/Google Workspace, Microsoft 365, SendGrid, Mailgun, Amazon SES und
Postmark werden ebenfalls über dieselben SMTP-Variablen unterstützt. Konkrete
Hosts, Ports und Anforderungen an App-Passwörter bzw. SMTP AUTH sind in
[CONFIGURATION.md](CONFIGURATION.md) zusammengefasst.

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
docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build nginx wa-connector wa-connector-worker tg-connector
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
über das Web-UI übertragen. In diesem Fall meldet die Oberfläche den Account
als `reauth_required`; der QR-Flow ist für Accounts ohne zusätzliche
Passwortabfrage vorgesehen.

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

Der Consumer-WhatsApp-Konnektor verwendet ein Linked Device über den Go-
Connector [whatsmeow](https://github.com/tulir/whatsmeow). Sitzungs-, Geräte- und
Signal-Daten werden verschlüsselt in PostgreSQL im Schema `wa_whatsmeow`
gespeichert. Es gibt keine parallele Legacy-Implementierung und kein
Auth-Dateivolume.

```dotenv
WA_BACKFILL_DAYS=7
WA_BACKFILL_THROTTLE_MS=250
WA_BACKFILL_GROUP_DELAY_MS=1500
WA_HISTORY_PAGE_SIZE=50
WA_HISTORY_REQUEST_DELAY_MS=500
WA_SYNC_GRACE_SECONDS=60
WA_WHATSMEOW_SQL_SCHEMA=wa_whatsmeow
WA_DATABASE_SSLMODE=disable
WA_MEDIA_DOWNLOAD_ATTEMPTS=3
WA_MEDIA_RETRY_INTERVAL_MS=60000
```

Für ein echtes Konto:

1. Den Stack mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up -d --build wa-connector wa-connector-worker` starten.
2. Die Connector-Seite öffnen und den angezeigten QR-Code in WhatsApp unter **Verknüpfte Geräte** → **Gerät hinzufügen** scannen. QR-Payloads werden nicht in Docker-Logs ausgegeben.
3. Gruppen im Web-UI auswählen. Nach der Auswahl werden nur diese Gruppen synchronisiert; die Auswahl kann jederzeit geändert werden.

Die lokale PostgreSQL-Compose-Datenbank läuft ohne TLS; deshalb bleibt
`WA_DATABASE_SSLMODE=disable` lokal erforderlich. Für eine PostgreSQL-Instanz
mit aktivierter TLS-Verbindung den Wert auf `require` oder `verify-full` setzen.

Bei der ersten Aktivierung und bei jedem Systemneustart werden nur Nachrichten
innerhalb des Zeitfensters `WA_BACKFILL_DAYS` verarbeitet. Die History-Abfragen
werden mit `WA_HISTORY_PAGE_SIZE`, `WA_HISTORY_REQUEST_DELAY_MS`,
`WA_BACKFILL_THROTTLE_MS` und `WA_BACKFILL_GROUP_DELAY_MS` gedrosselt. Nach dem
Erreichen des aktuellen Nachrichtenstands gibt der Worker seine Lease an den
Pool zurück.

Die Gruppenliste wird nach jeder erfolgreichen Verbindung und regelmäßig über
`GROUP_REFRESH_INTERVAL_MS` aktualisiert. Gruppen, die der Account nicht mehr
besitzt, werden aus Auswahl und Dashboard entfernt; Nachrichten, Analysen,
Events, Knowledge-Base-Daten, Audiojobs und Medienreferenzen werden mit den
zugehörigen Objekten bereinigt. Bei einem fehlgeschlagenen Snapshot findet keine
automatische Löschung statt.

Status und Pairing-Informationen sind auf der Connector-Seite verfügbar. Der
interne Endpunkt bleibt unter `wa-connector:3001` erreichbar, wird aber nicht
auf einem Host-Port veröffentlicht. QR-Payloads werden ausschließlich über die
authentifizierte API an das jeweilige Nutzerkonto ausgeliefert.

Wichtig: whatsmeow nutzt ein inoffizielles Consumer-WhatsApp-Protokoll und ist
keine offizielle WhatsApp-Business-API. Protokolländerungen, Rate-Limits,
Account-Sperren und Plattformbedingungen sind reale Betriebsrisiken. Siehe auch
[Bekannte Risiken und Sicherheitsgrenzen](#bekannte-risiken-und-sicherheitsgrenzen).

### Telegram-Konnektor

Der produktive Telegram-Konnektor ist jetzt eine direkte Go-MTProto-Verbindung
mit [`gotd/td`](https://github.com/gotd/td). Dies ist der einzige Telegram-
Connector im Projekt; es gibt keinen Telegram-Bot- oder GramJS-Fallback.
Authentifizierung und Nachrichtenabruf erfolgen ausschließlich über die
persönliche MTProto-Session des Nutzers.

```dotenv
TG_API_ID=123456
TG_API_HASH=replace-with-api-hash
TG_BACKFILL_DAYS=7
TG_BACKFILL_THROTTLE_MS=500
TG_BACKFILL_GROUP_DELAY_MS=2000
TG_CONNECTOR_POOL_SIZE=5
TG_ONBOARDING_SLOTS=1
GROUP_REFRESH_INTERVAL_MS=60000
```

API-ID und API-Hash werden unter [my.telegram.org/apps](https://my.telegram.org/apps)
erstellt. Der Nutzer startet auf `/connectors` **Telegram-QR starten** und
scannt den angezeigten Code in Telegram unter **Einstellungen** → **Geräte**.
Die gotd-Session wird als verschlüsselungsfähiger Session-Snapshot in
`connector_accounts.session_data` gespeichert; der letzte Nachrichten-Cursor
liegt je Nutzer und Gruppe in `connector_cursors`. Kein QR-Payload wird in
Docker-Logs ausgegeben.

Nach der Verbindung entdeckt gotd die Dialoge des angemeldeten Kontos. Gruppen,
Supergroups, Channels und Forum-Topics werden hierarchisch in PostgreSQL
gespeichert; keine Quelle wird automatisch ausgewählt. Auswahl, Entfernen,
periodische Dialog-Snapshots, Medien-Downloads, Backfill und die NATS-Events
verwenden dieselben Verträge wie der bisherige Connector.
Gruppenauswahl-Events enthalten die Nutzerbindung; der zugehörige Telegram-
Account wird dadurch auch ohne aktive Lease für den nächsten Processing-Lauf
fällig gesetzt.

Bei jedem Processing-Lauf werden maximal die letzten `TG_BACKFILL_DAYS` Tage
gedrosselt gelesen. Die gespeicherten Cursor verhindern, dass der gesamte
Backlog bei jedem Poolwechsel erneut verarbeitet wird. Nach dem Erreichen des
aktuellen Nachrichtenstands gibt der Worker die Account-Lease automatisch
frei. Die Liste wird durch jeden vollständigen Dialog-Snapshot aktualisiert;
verlassene Gruppen und Topics werden aus der Auswahl entfernt und bei
vollständiger Verwaisung inklusive abhängiger Daten und Medien bereinigt.

Wenn ein Account bereits auf dem aktuellen Stand ist, wartet der Processing-Worker
bis zu `next_sync_at`. Dieser normale Leerlauf wird als Connector-Status
`waiting` angezeigt und nicht als Fehler (`degraded`) gewertet. Ein neuer Lauf
beginnt automatisch, sobald das nächste Sync-Fenster erreicht ist.

Bei aktivierter Telegram-2FA kann der QR-Login eine erneute Anmeldung verlangen.
Das 2FA-Passwort wird bewusst nicht über das Web-UI übertragen. Der Account
bleibt dann mit `reauth_required` sichtbar, bis ein dafür vorgesehener sicherer
Enrollment-Flow ergänzt wird.

### KI- und Audio-Konnektoren

Der AI-Worker benötigt im MVP keinen externen LLM-API-Key. Er verwendet das
lokale, deterministische Analyseprofil `heuristic-mvp` und erzeugt validierte
strukturierte Ergebnisse für Relevanz, Facts, Entities, Events, Places und
Zusammenfassungen:

```dotenv
AI_MODEL=heuristic-mvp
```

`AI_MODEL` wird als Modellbezeichnung im Ergebnis geführt. Der lokale Adapter
ist der Standard; ein optionaler externer Provider oder Hermes-Agent kann über
`AI_PROVIDER`, `AI_ENDPOINT`, `AI_API_KEY` bzw. `AI_HERMES_*` aktiviert werden.
Prompt-Versionen, Modellwahl, Retry und Cooldown sind konfigurierbar. Der
Worker verbindet sich in Compose automatisch mit PostgreSQL und NATS.

Die Knowledge-Base verwendet im MVP ein Hybridmodell `cascade-v5-places`: strenge
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
können im Dashboard ein- und ausgeblendet werden. Die Grundstruktur liegt in
`infra/migrations/004_knowledge_hierarchy.sql`;
sprachabhängige Themen und die aktuelle Generation in
`infra/migrations/019_knowledge_topics.sql` und
`infra/migrations/020_knowledge_generations.sql`.

Die aktuelle Qualitätskaskade (`cascade-v5-places`) arbeitet in drei lokalen Stufen:

1. evidenzbasierte Regeln für Relevanz, Events und präzise Ortskandidaten sowie
   datenbankbasierte, sprachabhängige Topic-/Detailbegriffe;
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
`event`, `place` oder `knowledge` gespeichert werden. Relevanz wird dabei in
den drei Stufen `high`, `medium` und `low` gespeichert; die Nachrichtenkarten
im Dashboard bieten dafür direkte Aktionen sowie Bestätigen-/Verwerfen-Aktionen
für erkannte Events und Orte. Eine Rückmeldung löst die
erneute Analyse der betroffenen Nachricht aus. Bei Knowledge-Korrekturen mit
`alias`, `canonicalKey` und optional `topicKey` wird zusätzlich ein
gruppengebundener kanonischer Begriff gelernt.

Die neue Lernschicht liegt in `ai_learning_terms` und ist nach Sprache und
optional nach Gruppe gebunden. Globale Systembegriffe bilden die Defaults;
Feedback aus einer Gruppe erzeugt zusätzliche positive oder negative
Wortgewichte für Relevanz, Events, Action Items und Orte. Die gruppenspezifischen Gewichte
werden zusammen mit den globalen Werten geladen und beeinflussen dadurch nur
die jeweilige Gruppe stärker. Administratoren verwalten diese Begriffe,
Ausschlusswörter und Knowledge-Schlüsselwörter unter `/admin/ai-learning`.
Die Seite bietet eine serverseitige Volltextsuche über Begriff, Thema, Gruppe,
Plattform, Quelle und Kategorie sowie eine kompakte Seitenteilung. Jede Zeile
zeigt zusätzlich Gruppenkontext, Plattform, Chat-Typ, Lernquelle, Feedbackzähler
und Änderungsdatum.
Die Übersichtsseite zeigt außerdem die Anzahl je Kategorie, Metriken für 24
Stunden, 7 Tage und 1 Monat sowie eine einfache Zeitgrafik. Relevanz, Events,
Action Items, Orte, Knowledge-Schlüsselwörter und Ausschlusswörter haben jeweils eigene
Unterseiten mit den für die Kategorie relevanten Eingabefeldern. Dort können
mehrere Begriffe markiert und gemeinsam aktiviert, deaktiviert oder gelöscht
werden. Die Gewichtsspalte kann per Klick absteigend oder aufsteigend sortiert
werden; die Sortierung wird serverseitig vor der Paginierung angewendet. Ein
manuelles Löschen erzeugt zusätzlich einen dauerhaften, nach Sprache,
Kategorie, Thema und Gruppe gebundenen Ausschluss in
`ai_learning_term_exclusions`. Dadurch wird der Begriff nicht erneut
automatisch gelernt und nicht an Hermes zur externen Prüfung übergeben. Eine
spätere explizite Neuanlage durch den Administrator hebt genau diesen
Ausschluss wieder auf.
Action Items werden als eigener Analysebereich neben Events erkannt. Sie
enthalten Titel, optionalen Fälligkeitshinweis, Status (`open` oder `done`),
Konfidenz und Quellnachrichten und erscheinen im Dashboard direkt unter dem
Event-Bereich. Ihre Begriffe werden konservativ pro Gruppe und Sprache gelernt.
`infra/migrations/027_action_items_learning.sql` ergänzt die JSONB-Persistenz,
die sechste Lernkategorie und mehrsprachige Standardbegriffe. Manuelle
Ausschlüsse werden auch für Action Items über `ai_learning_term_exclusions`
berücksichtigt.
Die Zeitgrafik ist als gestapeltes Balkendiagramm ausgeführt. Über die Auswahl
„Letzte 24 Stunden“, „Letzte 7 Tage“ oder „Letzter Monat“ kann der Zeitraum
gewechselt werden; die Farblegende ordnet die Segmente den sechs Kategorien zu.
Die Migration `infra/migrations/014_relevance_learning.sql` legt das Modell und
die initialen, aus der bisherigen Heuristik übernommenen Begriffe an.
`infra/migrations/015_more_exclusion_words.sql` ergänzt die globalen
Ausschlussbegriffe um zusätzliche Füllwörter, Gesprächspartikeln und typische
Floskeln in Deutsch, Spanisch, Katalanisch, Englisch und Französisch.
`infra/migrations/026_ai_learning_exclusions.sql` ergänzt dauerhafte Tombstones
für manuell entfernte Lernbegriffe.

Füll- und Ausschlusswörter werden im laufenden Betrieb ausschließlich aus
`ai_learning_terms` geladen. AI-Worker und API enthalten dafür keine statischen
mehrsprachigen Stopword-Listen mehr; Änderungen können dadurch pro Sprache und
optional pro Gruppe über die Administrationsseite gepflegt werden. Auch die
Knowledge-Themen und ihre Erkennungsbegriffe werden nicht mehr parallel im
Worker gepflegt: `knowledge_topic_definitions` enthält die aktivierten,
sprachabhängigen Oberthemen, Beschreibungen und Signalrollen, `ai_learning_terms`
die editierbaren Topic-/Detailbegriffe. Die Standardthemen werden durch die
Migrationen `019_knowledge_topics.sql`, `021_knowledge_heuristics.sql` und
`022_knowledge_topic_roles.sql` angelegt und können danach administrativ
angepasst, ergänzt oder deaktiviert werden.

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

Unterthemen werden heuristisch aus dem Inhalt des jeweiligen Threads erzeugt.
Ein bestehendes Unterthema wird nur bei ausreichender lexikalischer oder
semantischer Überschneidung wiederverwendet; dadurch bleiben verschiedene
Fragen innerhalb eines Oberthemas getrennt. Die daraus ermittelten Begriffe
werden in `knowledge_subtopic_terms` gruppen-, sprach- und themengebunden mit
kleinen Gewichten gespeichert. Neue Nachrichten können dadurch konservativ
ähnliche Threads wiederfinden, ohne die Begriffe anderer Gruppen zu
übertragen. Der Unterthementitel wird aus dem ersten aussagekräftigen Satz
des Threads abgeleitet und nicht mehr mit einem generischen Label wie
„Erkenntnis“ erzeugt. Ein KB-Neuaufbau lernt diese Profile in der neuen
Generation erneut.

Für die Kaskade können Kontextfenster und Event-Schwelle angepasst werden:

```dotenv
AI_PROMPT_VERSION=cascade-v5-places
AI_KNOWLEDGE_VERSION=cascade-v5-places
AI_CONTEXT_MAX_MESSAGES=80
AI_EVENT_WINDOW_HOURS=36
AI_EVENT_MIN_CONFIDENCE=0.70
AI_DOCUMENT_ANALYSIS_MAX_CHARS=12000
AI_NATS_PAYLOAD_LIMIT_BYTES=900000
```

Dokumente werden vollständig lokal extrahiert und in `media_objects.ocr_text`
gespeichert. Für die KI-Analyse wird nur ein begrenzter Auszug verwendet; so
bleiben Dokumentzusammenfassungen kurz und überschreiten keine NATS-Payload-
Limits. `AI_DOCUMENT_ANALYSIS_MAX_CHARS` steuert diese Grenze. Der Worker
veröffentlicht übergroße Analyseergebnisse zusätzlich in kompakter Form, die
vollständige Analyse bleibt in PostgreSQL erhalten.

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
Bei einem Logeintrag mit `401`, `Unauthorized` oder `User Access Token ... is expired`
ist der Token ungültig: entweder einen neuen Hugging-Face-Token mit mindestens
Leserechten in `.env-dockge` eintragen oder `HF_TOKEN` leeren, weil das öffentliche
Embedding-Modell auch ohne Authentifizierung geladen werden kann. Nach einer
Änderung den AI-Worker neu erstellen, damit der Token übernommen wird.
Wenn `HF_TOKEN` leer ist, verhindert der Worker außerdem die implizite Nutzung
eines alten Tokens aus dem Hugging-Face-Cache.

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
AI_HERMES_TIMEOUT_MS=60000
AI_HERMES_RETRY_ATTEMPTS=3
AI_HERMES_RETRY_BASE_MS=1500
AI_HERMES_FAILURE_COOLDOWN_SECONDS=60
```

Bei nicht gesetzter Hermes-URL oder einem temporären Hermes-Fehler bleibt die
lokale, nachvollziehbare Verarbeitung aktiv. Die Nachrichten werden für den
Verifier an den konfigurierten Remote-Dienst übertragen; die URL und der API-
Key müssen daher bewusst gesetzt werden.

Hermes ist optional und bleibt ein Fallback: Der Dienst wird nur aktiviert,
wenn `AI_HERMES_ENABLED=true` und eine URL gesetzt sind. Die lokale Kaskade
bleibt die Primärquelle; Hermes prüft nur unsichere Knowledge-Kandidaten.
Bei Fehlern oder Timeout wird das lokale Ergebnis beibehalten. Temporäre
Timeouts, Verbindungsfehler und HTTP-Fehler 408/425/429/5xx werden bis zu
`AI_HERMES_RETRY_ATTEMPTS`-mal mit exponentiellem Backoff wiederholt. Nach
einem endgültigen Ausfall pausiert der Verifier für
`AI_HERMES_FAILURE_COOLDOWN_SECONDS`, damit ein nicht erreichbarer Remote-Dienst
keine Nachrichtenverarbeitung blockiert. Der Read-Timeout beträgt standardmäßig
60 Sekunden; `AI_HERMES_CONNECT_TIMEOUT_MS` begrenzt den Verbindungsaufbau
separat.

Die Remote-Nutzung ist zusätzlich nach Verarbeitungspfad begrenzt: Der Worker
sendet die unsicheren Knowledge-Kandidaten einer Nachricht gemeinsam in einem
Batch und ebenso alle unsicheren Ortskandidaten. Startup-Backfills, KB-
Neuaufbauten, Neubewertungen, Replays und explizite Feedback-Neuberechnungen
laufen standardmäßig vollständig lokal und laden keine zusätzlichen Medien.
Ein Replay kann nur durch das explizite Ereignisfeld `allowRemoteReview=true`
Remote-Prüfungen erlauben. Jeder Remote-Batch und jeder lokale Skip wird nach
Trigger, Prüfung, Ergebnis, Kandidatenzahl und HTTP-Versuchen in
`ai_hermes_usage` aggregiert. Die Übersicht ist für Administratoren unter
„Hermes-Nutzung“ sichtbar.

### Präzise Ortsauswertung

Die Ortsauswertung verwendet eine mehrstufige Präzisionskaskade. GPS- und
Standortnachrichten von WhatsApp oder Telegram werden direkt mit hoher
Konfidenz übernommen. Text-Orte werden dagegen nur aus einem kleinen
Kandidatenausschnitt mit Ortskontext, Adresse oder NER-Evidenz gebildet; der
komplette Nachrichtentext wird niemals mehr als Ortsname gespeichert.

```dotenv
AI_PLACE_NER_ENABLED=true
AI_PLACE_NER_MODEL=
AI_PLACE_MIN_CONFIDENCE=0.70
AI_PLACE_HERMES_ENABLED=true
AI_PLACE_HERMES_MIN_CONFIDENCE=0.78
AI_PLACE_LEARNING_MIN_CONFIDENCE=0.82
AI_PLACE_GEOCODER_ENABLED=false
AI_PLACE_GEOCODER_URL=https://nominatim.openstreetmap.org/search
AI_PLACE_GEOCODER_USER_AGENT=wagi-place-resolver/1.0
AI_PLACE_GEOCODER_TIMEOUT_MS=5000
AI_PLACE_GEOCODER_THROTTLE_MS=1100
AI_PLACE_REQUIRE_GEOCODER=false
```

Der eingebaute NER-lite-Fallback arbeitet ohne zusätzliches Modell. Für ein
installiertes mehrsprachiges spaCy-Modell kann `AI_PLACE_NER_MODEL` gesetzt
werden; das optionale Paket ist als `place-ner`-Extra in
`apps/ai-worker/pyproject.toml` definiert. Ein Geocoder ist standardmäßig
deaktiviert, damit keine Ortsnamen ungefragt an einen externen Dienst
übertragen werden. Wird er aktiviert, werden erfolgreiche und negative
Auflösungen in `ai_place_resolution_cache` gecacht und die Anfragen gedrosselt.

Hermes prüft nur unsichere Textkandidaten. Bei Hermes-, Geocoder- oder
Modellfehlern bleibt die lokale Entscheidung aktiv; Kandidaten unterhalb der
Mindestkonfidenz werden verworfen. Automatisches Lernen übernimmt ausschließlich
akzeptierte Ortsnamen und nicht den umgebenden Nachrichtentext. Ortsfeedback
lernt ebenfalls nur den bestätigten oder abgelehnten Ortsbegriff.
Die zugehörige Cache-Tabelle und die Bereinigung alter, fälschlich als Orts-
begriffe seedierter Zeit- und Füllwörter werden durch Migration
`infra/migrations/023_place_precision_pipeline.sql` angelegt.

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
MEDIA_ANALYSIS_EVENT_MAX_CHARS=12000
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
nur das MVP-Platzhalterergebnis. Im Live-Betrieb übergeben WhatsApp- und
Telegram-Connectoren verfügbare Quelldateien an die Medienpipeline und speichern
sie dauerhaft in MinIO. Wenn für eine Nachricht keine Quelldatei verfügbar ist,
wird der Audiojob als nicht verfügbar dokumentiert und erzeugt keinen falschen
Transkripttext. Die verbleibenden Produktionsarbeiten sind in
[ROADMAP.md](ROADMAP.md) dokumentiert.

Medien werden in MinIO nach Typ getrennt gespeichert: Bilder in
`MINIO_BUCKET_IMAGES`, Videos in `MINIO_BUCKET_VIDEOS`, Audio in
`MINIO_BUCKET_AUDIO`, Dokumente in `MINIO_BUCKET_DOCUMENTS` und sonstige Medien
in `MINIO_BUCKET_OTHER`. Die API startet standardmäßig mit der aktivierten,
wiederaufnehmbaren Migration aus dem bisherigen `MINIO_BUCKET` und aktualisiert
die Zuordnung in `media_objects.bucket`, bevor Legacy-Objekte gelöscht werden.
Die Bucket-Migration ist in `apps/api/cmd/api/media_buckets.go` isoliert und kann
nach Abschluss über `MEDIA_BUCKET_MIGRATION_ENABLED=false` deaktiviert werden.

Die vertikale Kette kann mit den vorhandenen Demo-/Testdaten der Datenbank und
den Worker-Pipelines geprüft werden. Für eine echte WhatsApp-Verbindung wird
der whatsmeow-Connector über den QR-Flow gekoppelt; die Gruppen- und
Nachrichtenauswahl erfolgt anschließend im Web-UI. Für die Konfiguration siehe
[WhatsApp-Konnektor](#whatsapp-konnektor).

## Architektur

| Bereich | MVP-Implementierung |
| --- | --- |
| WhatsApp | Go + `whatsmeow`, direkte Linked-Device-Verbindung mit PostgreSQL-SQL-Session-State |
| Telegram | Go + `gotd/td`, direkte MTProto-Session, QR-Login, Dialog-/Topic-Snapshot und historischer Backfill |
| Eventing | NATS mit JetStream-fähigem Server, Subjects `wa.*`, `media.*`, `ai.*` |
| Persistenz | PostgreSQL mit PostGIS und pgvector; whatsmeow-Gerätezustand zusätzlich im isolierten Schema `wa_whatsmeow` (Migration `024_whatsmeow_storage.sql`) |
| Medien | MinIO/S3-Konvention, Audio-Job-Pipeline |
| STT | lokales `whisper.cpp`, Modell `medium`, ffmpeg-Normalisierung, JSON-Ergebnis |
| Karten | Leaflet mit OpenStreetMap-Tiles und sichtbarer OSM-Attribution |
| KI | `ai-worker`, validiertes strukturiertes Schema für Relevanz, Facts, Entities, Events, Places und Summary |
| API | Go Standard Library + pgx, Health-/Readiness-/Metrics-Endpunkte |
| UI | Next.js/React, responsive Gruppen- und Nachrichtenübersicht; Knowledge Base maximal zweispaltig |
| Container-Basen | Alpine für Node.js, NATS, NGINX, Migration-Runner und NATS-Provisioner; Distroless für die API; Python Slim für AI-/Media-Worker wegen ONNX/Whisper/OCR-Kompatibilität |

PlantUML-Diagramme liegen in `docs/plantuml`: Gesamtarchitektur, Ingestion-Sequenz, KI-Pipeline, Deployment und Datenmodell. Die Mock-Bilder liegen unter `apps/web/public/mock`; Event-Karten werden im Dashboard interaktiv mit Leaflet gerendert und zeigen die Koordinaten aus den mehrteiligen Event-Quellen.

Die Demo verwendet den öffentlichen OpenStreetMap-Tile-Dienst mit vorgeschriebener Attribution. Für größere oder produktive Installationen muss die [OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) beachtet und gegebenenfalls ein eigener oder dedizierter Tile-Provider eingesetzt werden.

## Lokale Entwicklung

```bash
npm install
npm run build --workspace=@wagi/contracts
npm run build --workspace=@wagi/connector-sdk
cd apps/wa-connector-go && go run .
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
- `GET/POST/PATCH/DELETE /api/v1/admin/ai-learning[...]` für die sprach- und gruppenbezogene Lernmodellverwaltung
- `GET /api/v1/admin/ai-learning?language=de&search=...&category=...&groupId=...&page=1&pageSize=25&sort=weight&sortDirection=desc` für Suche, Gewichtssortierung und Paginierung
- `GET /api/v1/admin/ai-learning/summary?language=de` für Kategorieanzahl und Lernmetriken
- `POST /api/v1/admin/ai-learning/bulk` mit `{ "ids": ["..."], "action": "enable|disable|delete" }` für Mehrfachaktionen
- `GET/POST /api/v1/admin/ai-learning/reassessment` für Status und Start der vollständigen Neubewertung
- Admin-Betriebsübersicht unter `/admin`; die Benutzerverwaltung liegt separat unter `/admin/users`, das Lernmodell unter `/admin/ai-learning`.
- `GET /api/v1/admin/observability?aiPage=1&aiPageSize=20` liefert die paginierte KI-Verarbeitungshistorie. Die dort angezeigte Dauer ist ausschließlich aktive Worker-Zeit; Warteschlange, Retry-Backoff und Neustartwartezeit werden nicht eingerechnet.
- `GET /healthz` und `GET /readyz`
- `GET /api/v1/groups`
- `PUT /api/v1/groups/{groupId}/select` mit `{ "selected": true|false }`
- Die Gruppenverwaltung erfolgt ausschließlich nutzerbezogen unter `/groups`; Administratoren verwalten dort keine Gruppenrechte mehr.

Das KI-Lernmodell lernt auch bei der laufenden Verarbeitung neuer Nachrichten
weiter. Automatisch erkannte neue Begriffe werden gruppen- und sprachbezogen
mit kleinen Gewichten gespeichert. Bereits bekannte Begriffe derselben
Nachricht wirken als konservativ gedeckelte, gewichtete Anker; Benutzerfeedback
bleibt stärker. Ausschlusswörter werden nicht automatisch gelernt.
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

Die Funktion „Alle Nachrichten neu bewerten“ erstellt einen Job für alle
gespeicherten Nachrichten. Der Job liest ausschließlich bereits gespeicherte
Nachrichtentexte, Transkripte, OCR-Texte und Metadaten. Connectoren,
Medien-Downloads und whisper.cpp werden dabei nicht aufgerufen. Die Anfrage
läuft im separaten JetStream-Stream `WAGI_REASSESSMENT` mit dem Durable
Consumer `WAGI_AI_REASSESSMENT`; dadurch bleibt der Live-Stream
`WAGI_EVENTS` für neue Nachrichten und Medien getrennt. Ein konfigurierbarer
Abstand zwischen den Nachrichten verhindert zusätzlich, dass die laufende
Analyse unnötig verdrängt wird.

### Verarbeitung, Wiederanlauf und Dokumente

Der NATS-Provisioner legt den persistenten JetStream-Stream `WAGI_EVENTS`, den
separaten `WAGI_REASSESSMENT`- und `WAGI_DLQ`-Stream sowie die expliziten Durable Consumer für Nachrichten,
Audio, Bilder, Dokumente und Replay an. Die Consumer verwenden explizite ACKs,
konfigurierbare maximale Zustellungen und exponentielles Backoff. Nach dem
letzten Versuch wird das Ereignis in `event_failures` protokolliert, in `dlq.*`
veröffentlicht und quittiert, damit eine einzelne fehlerhafte Nachricht die
Pipeline nicht blockiert.

Die Worker schreiben vor der Verarbeitung einen Inbox-Eintrag in
`event_inbox`. Dadurch werden doppelte JetStream-Zustellungen sicher erkannt.
Die Migration `017_ai_learning_history.sql` speichert zusätzlich jede
administrative, inferierte und Feedback-basierte Lernaktion in
`ai_learning_term_history`, damit die Kategorien im Zeitverlauf ausgewertet
werden können.
Audio- und KI-Jobs werden in `audio_jobs` bzw. `ai_jobs` mit Status, Versuchen,
Fehler und nächstem Versuch gespeichert. Nach einem Neustart werden verwaiste
`processing`-Jobs zurückgesetzt und automatisch erneut eingereiht.
`infra/migrations/018_ai_processing_duration.sql` ergänzt für `ai_jobs` eine
separate kumulierte aktive Verarbeitungszeit. Dadurch bleibt Wartezeit in der
Queue und Retry-Backoff aus der Laufzeitmetrik der Admin-Seite heraus.

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
selbst registrieren. Gruppen und Channels werden vom jeweiligen Nutzer unter
`/groups` ausgewählt und verwaltet; die Admin-Seite verwaltet keine
nutzerbezogenen Gruppenrechte. Sitzungen werden als
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
gespeichert. Der aktuelle MVP verwendet dafür noch keine KMS-Schlüssel und
benötigt deshalb zusätzlichen Datenbank-/Secret-Schutz.

Die Worker speichern pro Connector-Konto und Gruppe `connector_cursors`. Beim
Neustart wird weiterhin der Sieben-Tage-Zeitraum gedrosselt geprüft, bereits
verarbeitete Telegram-Nachrichten werden aber ab dem gespeicherten Telegram-
Message-ID-Cursor fortgesetzt. Bei WhatsApp dient der persistierte Cursor der
Nachvollziehbarkeit und die whatsmeow-History-Abfrage zusätzlich der
Duplikatvermeidung. Gruppen werden automatisch dem Nutzerkonto zugeordnet;
die Auswahl in `/groups` ist pro Nutzer getrennt gespeichert. Entfernte
Gruppen werden aus dessen Auswahl und – falls kein anderer Nutzer mehr Zugriff
hat – mitsamt Nachrichten und Medienbereinigung entfernt.

Events werden weiterhin aus `message_analyses.events` im Dashboard separat
dargestellt. Thematische Fakten und Erkenntnisse werden zusätzlich durch den
AI-Worker erkannt, in `knowledge_topics`/`knowledge_items` gruppiert und unter
`/knowledge` getrennt von Events und relevanten Nachrichten angezeigt.

### KB-Themen, Unterthemen und Neuaufbau

Administratoren pflegen die Oberthemen und ihre Übersetzungen unter
`/admin/knowledge-topics`. Das Feld **Thema** im Lernmodell für
Knowledge-Schlüsselwörter ist ein Dropdown und verwendet die aktiv gepflegten
Themen der gewählten Sprache. Ein gemeinsamer `topicKey` verbindet die fünf
Sprachvarianten.

Die Knowledge Base trennt Oberthemen von automatisch erzeugten Unterthemen.
Unterthemen werden aus stabilen Entitäts-, Orts- und Inhaltsmerkmalen gebildet;
Nachrichten werden nur bei ausreichender inhaltlicher Überschneidung in einem
Unterthema zusammengeführt. Dadurch wird ein allgemeines Thema nicht mehr mit
allen Nachrichten der Gruppe gefüllt.

Über **KB neu erstellen** kann ein Administrator die Knowledge Base aus den
gespeicherten Nachrichtentexten, Transkripten, OCR-Ergebnissen und Metadaten
neu erzeugen. Medien werden dabei nicht erneut heruntergeladen oder
transkribiert. Der Aufbau läuft im separaten JetStream-Stream
`WAGI_KB_REBUILD`; eine neue Generation wird erst nach vollständigem Erfolg
aktiv geschaltet. Bei Fehlern bleibt die bisher sichtbare Generation erhalten.
Der Fortschritt wird auf der Admin-Seite angezeigt.

## Bekannte Risiken und Sicherheitsgrenzen

whatsmeow kommuniziert über das inoffizielle WhatsApp-Web-/Multi-Device-Protokoll und ist keine offizielle WhatsApp Business API. Änderungen am Protokoll, Rate-Limits, Account-Sperren und eine mögliche Unvereinbarkeit mit WhatsApp-Nutzungsbedingungen sind reale Betriebsrisiken. Der Connector muss deshalb als austauschbarer Adapter behandelt werden.

Der MVP verarbeitet ausschließlich Gruppen, die der verknüpfte Account selbst sehen kann. Trotzdem können private Inhalte, personenbezogene Daten, Audio und Standortdaten verarbeitet werden. Vor einem produktiven Einsatz braucht es Einwilligungs-/Hinweisprozesse, Löschfristen, Verschlüsselung, Zugriffskontrollen, Auditierung, Tenant-Isolation, Secret-Management sowie eine rechtliche Prüfung für Datenschutz und Plattformbedingungen.

## Nächste Schritte

1. Tenant-Isolation für Organisationen bzw. private Arbeitsbereiche ergänzen.
2. Transport-/Speicherverschlüsselung, Secret-Management und Secret-Rotation
   produktionsfest umsetzen.
3. Löschfristen, Datenexport, Einwilligungs-/Hinweiskonzept und Audit-Log
   ergänzen sowie die rechtlichen Plattform- und Datenschutzprüfungen abschließen.
4. Strukturierte Logs mit Correlation-IDs, Metriken, Dashboards, Alerts und
   fachliche Readiness-Prüfungen für externe Abhängigkeiten ausbauen.
5. Connector-Fixtures, Contract-/API-/UI-E2E-Tests sowie Datenschutz- und
   Lasttests ergänzen.
6. Backups, Restore-Tests und Ressourcen-/Speicherlimits für Medien, Modelle,
   whisper.cpp und KI-Verarbeitung einführen.
