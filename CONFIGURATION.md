# CONXTOR-Konfiguration

Diese Datei ist die Referenz für die Umgebungsvariablen der lokalen
`docker-compose`-Umgebung und des Dockge-Deployments. Die Vorlage für die lokale
Umgebung ist [`.env.example`](.env.example), die Vorlage für Dockge
[`.env.example-dockge`](.env.example-dockge). Eine produktive `.env-dockge` wird
lokal aus der Vorlage erzeugt und bleibt außerhalb von Git.

```bash
cp .env.example .env
docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build
```

Für Dockge die Variablen in der Stack-Umgebung oder in `.env-dockge` setzen und
`docker-compose-dockge.yaml` verwenden. Die lokalen Compose-Dateien und die
Dockge-Datei sind absichtlich getrennt.

### Service-spezifische Env-Dateien

Die Laufzeitumgebung ist pro Service in externe, versionierbare Env-Dateien
aufgeteilt. Die Datenbank und der einmalige `migrate`-Job bleiben absichtlich
direkt in Compose definiert, damit ihre Initialisierung und Abhängigkeiten an
einer Stelle sichtbar bleiben. Alle anderen Services laden ihre Variablen aus:

| Stack | Verzeichnis |
|---|---|
| Lokaler Stack | [`infra/docker/env/`](infra/docker/env/) |
| Dockge-Stack | [`env-dockge/`](env-dockge/) |

Die Dateien enthalten keine Zugangsdaten. Ihre `${...}`-Referenzen werden beim
Compose-Aufruf aus `.env` beziehungsweise `.env-dockge` aufgelöst. Für Dockge
werden die produktiven Secrets daher weiterhin ausschließlich in der ignorierten
Datei `.env-dockge` oder in der Stack-Umgebung gesetzt. Wird ein Service direkt
gestartet, muss sein `env_file` zusammen mit der jeweiligen Compose-Datei
verwendet werden; die Dateien sind nicht als Ersatz für die Stack-Umgebung
gedacht.

## Öffentliche URL und Browser

| Variable | Standard | Bedeutung |
|---|---:|---|
| `WAGI_PUBLIC_URL` | `http://localhost:3000` | Öffentliche Basis-URL für Verifizierungs- und Passwort-Reset-Links. In Dockge: `https://conxtor.com`. |
| `NEXT_PUBLIC_API_URL` | leer | Leer lassen, wenn Web und API über denselben Host unter `/api/` laufen. |
| `WAGI_CORS_ORIGIN` | leer | Nur bei einem separaten Browser-Origin setzen. Bei Same-Origin-Proxy nicht erforderlich. |
| `WAGI_COOKIE_SECURE` | false lokal, true produktiv | Secure-Flag der Session-Cookies; für HTTPS immer `true`. |
| `PORT` | 8080 API | Interner HTTP-Port des jeweiligen Dienstes. |

## Docker, Dockge und Traefik

| Variable | Standard | Bedeutung |
|---|---:|---|
| `WAGI_PUBLIC_PORT` | `3000` | Host-Port des lokalen NGINX-Gateways. |
| `API_INTERNAL_URL` | `http://api:8080` | Interne API-Adresse, die das Dockge-Web-Proxying verwendet. |
| `GHCR_IMAGE_OWNER` | `conxtor` | GitHub-Organisation für produktive Container-Images. |
| `GHCR_IMAGE_TAG` | `latest` | Image-Tag der Dockge-Services. |
| `TRAEFIK_HOST` | `conxtor.com` | Öffentlicher Hostname des Web-Routers. |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik-Einstiegspunkt. |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | Traefik-Zertifikatsresolver. |
| `DB_HOST` / `DB_USER` | `postgres` / `supabase_admin` | Nur vom Dockge-Migrationsjob verwendete interne Datenbankparameter. |

Im lokalen Stack veröffentlicht nur NGINX den Web-Port. Im Dockge-Stack wird
nur das Web-Image über Traefik geroutet; API, Datenbank, NATS, MinIO und beide
Connectoren bleiben intern.

### Container-Basis-Images

Die Compose-Builds verwenden nach Möglichkeit kleine Basis-Images: Node.js,
NATS, NGINX, der Migration-Runner und der NATS-Provisioner verwenden Alpine;
die Go-API verwendet ein statisches Distroless-Laufzeit-Image. Die AI- und
Media-Worker verwenden `python:3.12-slim`, weil FastEmbed/ONNX sowie
Whisper.cpp, FFmpeg, Tesseract und Poppler dort mit den verfügbaren nativen
Paketen und Binary-Wheels zuverlässig zusammenarbeiten. Die PostgreSQL- und
MinIO-Images bleiben die benötigten Hersteller-Images.

## Nutzer, Login und Rollen

| Variable | Standard | Bedeutung |
|---|---:|---|
| `WAGI_BOOTSTRAP_ADMIN_EMAIL` | `volker@kerkhoff.es` | E-Mail des ersten Administrators. |
| `WAGI_BOOTSTRAP_ADMIN_NAME` | `Volker Kerkhoff` | Name des ersten Administrators. |
| `WAGI_BOOTSTRAP_ADMIN_PASSWORD` | lokaler MVP-Default | Passwort des ersten Administrators; produktiv zwingend ersetzen. |

Neue Konten werden zunächst als nicht verifiziert gespeichert. Erst der Link aus
der Bestätigungs-E-Mail aktiviert die Anmeldung. Bestehende Konten werden durch
Migration `012_email_auth.sql` als bereits verifiziert behandelt. Die gewählte
Formularsprache wird als Präferenz gespeichert.

Administratoren können Nutzer direkt in der Benutzerverwaltung anlegen. Solche
Konten werden durch die Administratoraktion als verifiziert angelegt. Nutzer
können ihr Profil unter `/profile` ändern. Eine Änderung der E-Mail-Adresse
erfordert das aktuelle Passwort und anschließend eine neue E-Mail-Bestätigung;
eine Passwortänderung beendet alle bestehenden Sitzungen.

## Email und SMTP

| Variable | Standard | Bedeutung |
|---|---:|---|
| `SMTP_ENABLED` | false lokal, true Dockge | Email-Zustellung aktivieren. |
| `SMTP_HOST` | leer | DNS-Name oder intern erreichbarer SMTP-Host. |
| `SMTP_PORT` | `587` | 587 für STARTTLS, 465 für implizites TLS. |
| `SMTP_USERNAME` | leer | Vollständige Mailbox-Adresse oder Provider-Benutzername. |
| `SMTP_PASSWORD` | leer | SMTP-/Mailbox-Passwort; nicht committen. |
| `SMTP_USE_TLS` | true | STARTTLS, typischerweise Port 587. |
| `SMTP_USE_SSL` | false | Implizites TLS, typischerweise Port 465. |
| `SMTP_FROM_EMAIL` | leer | Erlaubte Absenderadresse. |
| `SMTP_FROM_NAME` | WAGI | Absendername. |
| `SMTP_REPLY_TO` | leer | Optionale Antwortadresse. |
| `EMAIL_VERIFICATION_HOURS` | 48 | Gültigkeitsdauer des Verifizierungslinks. |
| `PASSWORD_RESET_HOURS` | 1 | Gültigkeitsdauer des Reset-Links. |

Die API versendet UTF-8-Textmails. Token werden nur als SHA-256-Hash gespeichert.
Verifizierungs- und Reset-Mails verwenden die Sprache des jeweiligen Formulars.
Der Reset-Endpunkt antwortet immer gleich, damit keine Konten aufgezählt werden.

### Mailcow

Mailcow verwendet typischerweise den Submission-Dienst:

```dotenv
SMTP_ENABLED=true
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USERNAME=noreply@conxtor.com
SMTP_PASSWORD=REPLACE_ME_mailbox_password
SMTP_USE_TLS=true
SMTP_USE_SSL=false
SMTP_FROM_EMAIL=noreply@conxtor.com
SMTP_FROM_NAME=WAGI
```

`SMTP_HOST` muss aus dem API-Container erreichbar sein. Bei getrennten
Compose-Projekten ist meistens der Mailcow-FQDN oder ein gemeinsam erreichbarer
Docker-Netzwerkname nötig. Die WAGI-Compose-Datei legt absichtlich kein
zusätzliches Netzwerk an. Port 587 nutzt STARTTLS; für Port 465:

```dotenv
SMTP_PORT=465
SMTP_USE_TLS=false
SMTP_USE_SSL=true
```

Die Absender-Domain muss in Mailcow existieren. Für Zustellbarkeit SPF, DKIM und
DMARC in Mailcow bzw. DNS einrichten.

### Andere verbreitete Anbieter

| Dienst | Host | Sicherheit | Hinweis |
|---|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` | 587 STARTTLS oder 465 TLS | meist App-Passwort |
| Microsoft 365 / Outlook | `smtp.office365.com` | 587 STARTTLS | SMTP AUTH muss erlaubt sein |
| SendGrid | `smtp.sendgrid.net` | 587 STARTTLS | Benutzer `apikey`, Passwort API-Key |
| Mailgun | `smtp.mailgun.org` | 587 STARTTLS | Mailgun-SMTP-Benutzer |
| Amazon SES | regionaler SES-SMTP-Host | 587 STARTTLS oder 465 TLS | SES-SMTP-Zugangsdaten |
| Postmark | `smtp.postmarkapp.com` | 587 STARTTLS | Server-Token gemäß Postmark-Konto |

## PostgreSQL, NATS und MinIO

| Variable | Standard | Bedeutung |
|---|---:|---|
| `POSTGRES_USER` | `supabase_admin` | PostgreSQL-Bootstrapuser. |
| `POSTGRES_PASSWORD` | lokal `app` | Passwort des Bootstrapusers. |
| `POSTGRES_DB` | `app` | Datenbankname. |
| `DATABASE_URL` | lokaler URL-Wert | Verbindungs-URL für API/Worker. |
| `WAGI_DB_PASSWORD` | Dockge erforderlich | Passwort der least-privileged Rolle `wagi_app`. |
| `NATS_URL` | `nats://nats:4222` | NATS-/JetStream-Verbindung. |
| `NATS_EVENT_MAX_AGE_DAYS` | 30 | Event-Aufbewahrung. |
| `NATS_DLQ_MAX_AGE_DAYS` | 90 | DLQ-Aufbewahrung. |
| `NATS_REASSESSMENT_MAX_AGE_DAYS` | 30 | Aufbewahrung des separaten Neubewertungs-Streams. |
| `NATS_REASSESSMENT_ACK_WAIT_SECONDS` | 86400 | Ack-Zeitfenster für lange Neubewertungsjobs. |
| `NATS_THREAD_REASSESSMENT_MAX_AGE_DAYS` | 30 | Aufbewahrung des separaten Thread-Neubewertungs-Streams. |
| `NATS_THREAD_REASSESSMENT_ACK_WAIT_SECONDS` | 86400 | Ack-Zeitfenster für Thread-Neubewertungen. |
| `NATS_KB_REBUILD_MAX_AGE_DAYS` | 30 | Aufbewahrung des separaten KB-Neuaufbau-Streams. |
| `NATS_KB_REBUILD_ACK_WAIT_SECONDS` | 86400 | Ack-Zeitfenster für einen laufenden KB-Neuaufbau. |
| `NATS_MAX_DELIVERIES` | 5 | Zustellversuche vor DLQ. |
| `NATS_RETRY_BASE_SECONDS` | 5 | Basis-Backoff. |
| `NATS_RETRY_MAX_SECONDS` | 300 | Backoff-Obergrenze. |
| `MINIO_ENDPOINT` | `http://minio:9000` | S3-kompatibler MinIO-Endpunkt. |
| `MINIO_ROOT_USER` | lokal `minio` | MinIO-Administrator. |
| `MINIO_ROOT_PASSWORD` | lokal `miniosecret` | MinIO-Administratorpasswort; produktiv ersetzen. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Root-Fallback | API-/Worker-Zugang. |
| `MINIO_BUCKET` | `wa-media` | Legacy-Bucket für die einmalige Migration und Rückwärtskompatibilität. |
| `MINIO_BUCKET_IMAGES` | `wa-media-images` | Bucket für Bildoriginale und Bildthumbnails. |
| `MINIO_BUCKET_VIDEOS` | `wa-media-videos` | Bucket für Videodateien. |
| `MINIO_BUCKET_AUDIO` | `wa-media-audio` | Bucket für Audiodateien. |
| `MINIO_BUCKET_DOCUMENTS` | `wa-media-documents` | Bucket für Dokumente und extrahierte Dokumentmedien. |
| `MINIO_BUCKET_OTHER` | `wa-media-other` | Fallback-Bucket für nicht klassifizierte Medientypen. |
| `MEDIA_BUCKET_MIGRATION_ENABLED` | `true` | API-Startmigration von `MINIO_BUCKET` in die typabhängigen Buckets. Zum späteren Entfernen/Deaktivieren auf `false` setzen. |
| `MEDIA_DIR` | `/data/media` | Lokales Arbeits-/Medienverzeichnis. |
| `MEDIA_SIGNING_SECRET` | produktiv erforderlich | Secret für kurzlebige Medien-URLs. |
| `MEDIA_CLEANUP_TOKEN` | erforderlich | Interner Bereinigungstoken. |

MinIO, NATS, PostgreSQL und Connector-Ports werden produktiv nicht über
Traefik veröffentlicht. Medien laufen über die API.

### Knowledge-Base-Themen und Neuaufbau

Die Admin-Seite `/admin/knowledge-topics` verwaltet die Tabelle
`knowledge_topic_definitions`. Themen werden pro Sprache (`de`, `es`, `ca`,
`en`, `fr`) gespeichert; der `topicKey` muss innerhalb einer Sprache eindeutig
sein und verbindet Übersetzungen. Nur aktivierte Themen werden im Dropdown des
Keyword-Lernmodells und bei der Benennung neuer KB-Einträge angeboten.

Der Button **KB neu erstellen** erzeugt eine neue Generation. Der AI-Worker
liest dabei nur bereits gespeicherte Texte, Audio-Transkripte und OCR-Inhalte.
Die Verarbeitung nutzt den isolierten JetStream-Stream
`knowledge.rebuild.requested` im Stream `WAGI_KB_REBUILD`. Die bisherige
Generation bleibt während des Aufbaus sichtbar und wird bei Fehlern nicht
ersetzt. Dafür sind keine zusätzlichen Umgebungsvariablen erforderlich; die
beiden `NATS_KB_REBUILD_*`-Werte steuern nur Aufbewahrung und Ack-Zeitfenster.

Die Funktion **Threads neu bewerten** verwendet den separaten Stream
`WAGI_THREAD_REASSESSMENT`. Die beiden `NATS_THREAD_REASSESSMENT_*`-Werte
steuern dessen Aufbewahrung und Ack-Zeitfenster. Automatische Beziehungen
werden neu berechnet; manuelles Thread-Feedback bleibt erhalten.

Auf `/admin/ai-learning` steht zusätzlich **KB neu bewerten** zur Verfügung.
Diese Funktion baut die komplette KB der aktuell ausgewählten Gruppen in einer
neuen Generation auf. Jede gespeicherte Nachricht wird erneut verarbeitet;
vorhandene Texte, Transkripte, OCR-Daten und Metadaten werden als Kontext
verwendet. Medien werden weder erneut geladen noch transkribiert. Die Option
**Bestehende KB-Begriffe löschen und neu erzeugen** ist standardmäßig
deaktiviert. Ohne diese Option wird die neue vollständige Generation parallel
aufgebaut und anschließend aktiviert. Mit der Option werden nur automatisch
gelernte, gruppengebundene KB-Schlüsselwörter neu aufgebaut; von System oder
Administratoren gepflegte Begriffe sowie manuelle Ausschlüsse bleiben erhalten.
Die alte sichtbare KB-Generation wird erst nach einem erfolgreichen Lauf
entfernt.

Es gibt keinen separaten Bucket-Initialisierungscontainer. Der `media-worker` prüft den
jeweiligen Zielbucket vor Uploads und Bereinigungen und legt ihn bei Bedarf
idempotent an. Bei aktivierter `MEDIA_BUCKET_MIGRATION_ENABLED` prüft die API beim
Start, ob der Legacy-Bucket vorhanden ist, kopiert bestehende Objekte anhand des
Medientyps, trägt den Zielbucket in `media_objects.bucket` ein und löscht die alte
Kopie erst danach. Der Ablauf ist wiederaufnehmbar und kann nach Abschluss durch
Deaktivieren der Option und Entfernen der isolierten Datei
`apps/api/cmd/api/media_buckets.go` aus dem API-Build entfernt werden. Der persistente
MinIO-Datenträger bleibt bei Neustarts erhalten.

## Connector-Pools und WhatsApp

| Variable | Standard | Bedeutung |
|---|---:|---|
| `CONNECTOR_POOL_ENABLED` | true | Poolbetrieb aktivieren. |
| `WA_CONNECTOR_POOL_SIZE` | 5 | WhatsApp-Arbeitsplätze. |
| `WA_ONBOARDING_SLOTS` | 1 | Freie QR-Onboarding-Plätze. |
| `WA_CONNECTOR_ACCOUNT_ID` | leer | Optionaler Account für Einzeltests. |
| `WA_BACKFILL_DAYS` | 7 | Neustart-/Aktivierungszeitfenster. |
| `WA_BACKFILL_THROTTLE_MS` / `WA_BACKFILL_GROUP_DELAY_MS` | 250 / 1500 | Backfill-Pausen. |
| `WA_HISTORY_PAGE_SIZE` | 50 | Maximale Zahl von Nachrichten je History-Anfrage. |
| `WA_HISTORY_REQUEST_DELAY_MS` | 500 | Pause zwischen angeforderten History-Seiten. |
| `WA_SYNC_GRACE_SECONDS` | 60 | Nachlauf für History-Sync- und Live-Ereignisse nach der Verbindung. |
| `WA_WHATSMEOW_SQL_SCHEMA` | `wa_whatsmeow` | PostgreSQL-Schema für verschlüsselten whatsmeow-Geräte- und Signal-State. |
| `WA_DATABASE_SSLMODE` | `disable` lokal | PostgreSQL-SSL-Modus für den whatsmeow-SQL-Store. Für TLS-gesicherte Produktionsdatenbanken z. B. `require` oder `verify-full` setzen. |
| `WA_MEDIA_DOWNLOAD_ATTEMPTS` | 3 | Medienwiederholungen. |
| `WA_MEDIA_RETRY_INTERVAL_MS` | 60000 | Abstand zwischen Medienwiederholungen. |
| `GROUP_REFRESH_INTERVAL_MS` | 60000 | Gruppen-/Topic-Aktualisierung, mindestens 30 Sekunden. |
| `CONNECTOR_LEASE_SECONDS` | 90 | Lease-Dauer eines Slots. |
| `CONNECTOR_ACCOUNT_SLOT_SECONDS` | 1800 | Maximale Nutzerverarbeitung je Slot. |
| `CONNECTOR_SYNC_INTERVAL_SECONDS` | 300 | Turnusmäßige Verarbeitung. |
| `CONNECTOR_POOL_SIZE`, `CONNECTOR_ONBOARDING_SLOTS`, `CONNECTOR_POOL_RETRY_DELAY_MS`, `CONNECTOR_START_DELAY_MS`, `CONNECTOR_ROLE`, `CONNECTOR_WORKER_ID` | dienstabhängig | Allgemeine Pool-/Prozessdefaults. |

Echte WhatsApp-Sessions müssen persistent gespeichert werden. Der produktive
Consumer-Connector verwendet [whatsmeow](https://github.com/tulir/whatsmeow)
für die direkte Linked-Device-Verbindung. Die verschlüsselten Geräte- und
Signal-Daten werden in PostgreSQL im eigenen Schema `wa_whatsmeow` gespeichert;
ein Auth-Dateivolume ist nicht erforderlich. Der Connector ist nicht Teil der
offiziellen WhatsApp-Business-API und bleibt deshalb einer austauschbaren
Adaptergrenze unterstellt.

## Telegram Direct / MTProto

| Variable | Standard | Bedeutung |
|---|---:|---|
| `TG_CONNECTOR_POOL_SIZE` | 5 | Telegram-Arbeitsplätze. |
| `TG_ONBOARDING_SLOTS` | 1 | Freie QR-Onboarding-Plätze. |
| `TG_API_ID` / `TG_API_HASH` | leer | Zugangsdaten von my.telegram.org/apps. |
| `TG_CONNECTOR_ACCOUNT_ID` | leer | Optionales Konto für gezielte Einzeltests. |
| `TG_BACKFILL_DAYS` | 7 | Neustart-/Aktivierungszeitfenster. |
| `TG_BACKFILL_THROTTLE_MS` / `TG_BACKFILL_GROUP_DELAY_MS` | 500 / 2000 | Backfill-Pausen. |
| `TG_PORT` | 3002 | Interner Status-/QR-Port. |
| `TG_STATE_DIR` | `/data/tg-state` | Kompatibilitätsvolume; Sessiondaten werden primär in PostgreSQL gespeichert. |
| `CONNECTOR_ROLE` | `processing` | `onboarding` für den dedizierten QR-Slot, `processing` für Backfill/Updates. |

Bei jedem erfolgreichen Direct-Snapshot werden die Dialoge, Supergroups,
Channels und Topics des Nutzers mit der Datenbank abgeglichen. Verlassene
Einträge verschwinden aus Auswahl und Dashboard. Bei gemeinsam genutzten Chats
werden nur `user_group_access` und der Cursor dieses Nutzers entfernt. Für
vollständig verwaiste Chats löscht der Connector zusätzlich
`event_inbox`/`event_failures` und die Medienobjekte; die abhängigen
Nachrichten-, Analyse-, Event-, Knowledge-Base- und Jobdaten werden über die
PostgreSQL-Kaskade entfernt. Eine unvollständige Snapshot-Aktualisierung löst
keine Bereinigung aus.

Das Compose-Image wird aus `apps/tg-connector-go/Dockerfile` gebaut. Es nutzt
Go 1.25, `gotd/td` und ein minimales Alpine-Laufzeitimage; der Build erzwingt
`linux/amd64` für die GHCR-Produktionsimages. Der Connector verwendet
ausschließlich persönliche MTProto-Sessions und bietet keinen Bot-API- oder
GramJS-Fallback.

## KI und Medien

| Variable | Standard | Bedeutung |
|---|---:|---|
| `AI_MODEL`, `AI_PROVIDER` | heuristic-mvp / hybrid | Analyseprofil und Provider. |
| `AI_ENDPOINT`, `AI_API_KEY` | leer | Optionaler AI-Adapter. |
| `AI_PROMPT_VERSION`, `AI_KNOWLEDGE_VERSION` | cascade-v5-places | Prompt-/Schema-Versionen. |
| `AI_CONTEXT_MAX_MESSAGES` | 80 | Kontextfenster. |
| `AI_EVENT_WINDOW_HOURS` / `AI_EVENT_MIN_CONFIDENCE` | 36 / 0.70 | Event-Fenster und Mindestkonfidenz. |
| `AI_THREAD_WINDOW_HOURS` | 18 | Zeitfenster, in dem Nachrichten einer Gruppe als mögliche Fortsetzung betrachtet werden. |
| `AI_THREAD_MAX_CANDIDATES` | 6 | Maximale Zahl der stärksten Thread-Kandidaten je Nachricht. |
| `AI_THREAD_AUTO_LINK_THRESHOLD` | 0.50 | Mindestscore für eine automatische, persistierte Thread-Beziehung. Explizite Antworten werden unabhängig davon verknüpft. |
| `AI_THREAD_CONTEXT_THRESHOLD` | 0.42 | Niedrigere Schwelle für Thread-Kontext, der Events und Knowledge-Auswertungen unterstützen darf. |
| `AI_EMBEDDINGS_ENABLED` | true | Embeddings aktivieren. |
| `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_CACHE_DIR` | MiniLM / fastembed cache | Modell und Cache. |
| `AI_HF_MODEL_LOAD_INTERVAL_SECONDS` | 86400 | Mindestabstand zu Hugging Face. |
| `HF_TOKEN` | leer | Optionaler HF-Token für höhere Gratislimits. |
| `HF_HUB_DISABLE_TELEMETRY` | `1` | Optionale Hugging-Face-Telemetrie deaktivieren. |
| `HF_HUB_ETAG_TIMEOUT` | `10` | Timeout für Hugging-Face-Metadatenabfragen. |
| `AI_SEMANTIC_DISCOVERY_THRESHOLD` / `AI_SEMANTIC_MERGE_THRESHOLD` | 0.90 / 0.18 | Präzisionsschwelle für neue Themen und Distanzschwelle für die Zusammenführung. |
| `AI_SEMANTIC_DISCOVERY_MARGIN` | 0.05 | Mindestabstand zum zweitbesten Thema; verhindert uneindeutige automatische Zuordnungen. |
| `AI_PLACE_NER_ENABLED`, `AI_PLACE_NER_MODEL` | true / leer | NER-lite bzw. optionales spaCy-Modell für Ortskandidaten. |
| `AI_PLACE_MIN_CONFIDENCE` | 0.70 | Mindestkonfidenz für akzeptierte Text-Orte. GPS-Orte umgehen diese Schwelle. |
| `AI_PLACE_HERMES_ENABLED`, `AI_PLACE_HERMES_MIN_CONFIDENCE` | true / 0.78 | Hermes-Prüfung unsicherer Ortskandidaten. Sie greift nur bei aktivierter Hermes-Verbindung. |
| `AI_PLACE_LEARNING_MIN_CONFIDENCE` | 0.82 | Mindestkonfidenz, ab der ein akzeptierter Ortsname automatisch gruppenspezifisch lernen darf. |
| `AI_PLACE_GEOCODER_ENABLED` | false | Externe geografische Validierung aktivieren. Standardmäßig aus Datenschutzgründen deaktiviert. |
| `AI_PLACE_GEOCODER_URL` | Nominatim-Suchendpunkt | Geocoder-Endpunkt; kann durch einen internen oder selbst betriebenen Dienst ersetzt werden. |
| `AI_PLACE_GEOCODER_USER_AGENT` | wagi-place-resolver/1.0 | Kennung für Geocoder-Anfragen. |
| `AI_PLACE_GEOCODER_TIMEOUT_MS`, `AI_PLACE_GEOCODER_THROTTLE_MS` | 5000 / 1100 | Timeout und Mindestabstand zwischen Geocoder-Anfragen. |
| `AI_PLACE_REQUIRE_GEOCODER` | false | Wenn true, werden nicht auflösbare Textkandidaten verworfen. |
| `AI_HERMES_ENABLED` | false | Hermes-Agent-Prüfung/Fallback. |
| `AI_HERMES_URL`, `AI_HERMES_API_KEY`, `AI_HERMES_MODEL` | leer / leer / hermes-agent | Hermes-Verbindung. |
| `AI_HERMES_TIMEOUT_MS`, `AI_HERMES_CONNECT_TIMEOUT_MS` | 60000 / 10000 | Hermes-Timeouts. |
| `AI_HERMES_RETRY_ATTEMPTS`, `AI_HERMES_RETRY_BASE_MS`, `AI_HERMES_RETRY_MAX_MS` | 3 / 1500 / 10000 | Hermes-Backoff. |
| `AI_HERMES_FAILURE_COOLDOWN_SECONDS` | 60 | Pause nach Fehlern. |
| `AI_HERMES_REVIEW_ALL`, `AI_HERMES_MIN_CONFIDENCE` | false / 0.78 | Prüfumfang und Konfidenz. |
| `AI_MAX_RETRIES`, `AI_STALE_PROCESSING_SECONDS` | 5 / 900 | KI-Retry und Recovery. |
| `AI_REASSESSMENT_DELAY_MS` | 100 | Pause zwischen Neubewertungsnachrichten, damit Live-Verarbeitung Vorrang behält. |
| `AI_DOCUMENT_ANALYSIS_MAX_CHARS` | 12000 | Dokumentkontext. |
| `AI_NATS_PAYLOAD_LIMIT_BYTES` | 900000 | Analyse-Payload. |
| `AI_LEARNING_INFERENCE_BASE_DELTA` | 0.003 | Kleine Grundverstärkung für neue, automatisch erkannte Begriffe. |
| `AI_LEARNING_CONTEXT_BONUS` | 0.009 | Maximaler Zusatz durch bereits bekannte, gewichtete Begriffe derselben Nachricht. |
| `AI_LEARNING_MAX_DELTA` | 0.015 | Obergrenze einer automatischen Verstärkung; Benutzerfeedback bleibt deutlich stärker. |
| `AI_LEARNING_MAX_TERMS_PER_SIGNAL` | 8 | Maximale Anzahl neuer Begriffe je Kategorie bzw. Knowledge-Thema und Nachricht. |
| `AI_KB_MIN_CONTENT_CHARS` / `AI_KB_MIN_CONTENT_TOKENS` | 48 / 6 | Mindestumfang einer Nachricht, bevor sie als Knowledge-Kandidat betrachtet wird. |
| `AI_KB_MIN_STRONG_TERMS` / `AI_KB_MIN_SUPPORTING_TERMS` | 2 / 1 | Konservative Evidenzschwellen: zwei starke Begriffe oder ein starker plus ein unterstützender Begriff. |
| `AI_KB_MAX_TOPICS_PER_MESSAGE` | 1 | Maximale Zahl der Knowledge-Themen je Nachricht; reduziert Mehrfachablage. |
| `AI_KB_MIN_INFERRED_OCCURRENCES` | 2 | Wiederholungen im selben Gruppen-/Themenkontext, bevor ein automatisch gelernter Begriff aktiv wird. |
| `AI_KB_MAX_INFERRED_TERMS_PER_TOPIC` | 2 | Obergrenze neuer, automatisch vorgeschlagener KB-Begriffe je Thema und Nachricht. |

Hermes wird pro Nachricht höchstens einmal für Knowledge-Kandidaten und
höchstens einmal für Ortskandidaten angefragt; beide Kandidatenmengen werden
gebündelt. Startup-Backfills, KB-Neuaufbauten, Reassessment, Replay und
Feedback-Neuberechnungen sind standardmäßig `local-only`. Für Replay muss ein
Ereignis ausdrücklich `allowRemoteReview=true` setzen. Die aggregierte Nutzung
steht in `ai_hermes_usage` und in der Admin-Observability zur Verfügung.

Die automatische Lernschleife läuft für neue Nachrichten weiter. Sie arbeitet
gruppen- und sprachgebunden: Bereits vorhandene aktive Begriffe in derselben
Gruppe liefern einen konservativ gedeckelten Kontextbonus. Relevanzgewichte
werden dabei auf die vorhandene Skala normiert; negative Relevanzbegriffe
reduzieren den Bonus. Neue Begriffe werden nur für erkannte Relevanz-, Event-,
Ort- oder Knowledge-Signale angelegt. Ausschlusswörter werden nicht automatisch
erzeugt. Explizites Nutzerfeedback bleibt stärker als diese automatische
Inferenz.

### Zusammenhängende Nachrichten ohne Reply-Funktion

Der AI-Worker führt zusätzlich eine gruppenbezogene, erklärbare Thread-Kaskade
aus. Sie bewertet zeitliche Nähe, gemeinsame Inhaltsbegriffe, gleichen Absender
und vorhandene Reply-Referenzen. Nur Beziehungen oberhalb von
`AI_THREAD_AUTO_LINK_THRESHOLD` werden dauerhaft in
`conversation_threads`, `conversation_thread_messages` und
`message_relations` gespeichert. Der niedrigere
`AI_THREAD_CONTEXT_THRESHOLD` darf den Kontext für Events, Action Items und
Knowledge-Quellen erweitern, erzeugt aber noch keine dauerhafte Beziehung.

Im Dashboard kann der Nutzer pro erkannter Beziehung **Zusammenhang bestätigen**
oder **Nachricht trennen** wählen. Diese Rückmeldung wird mit Nutzer und Gruppe
in `conversation_relation_feedback` historisiert. Eine Trennung blockiert die
automatische Wiederaufnahme desselben Nachrichtenpaares; eine Bestätigung kann
auch zwei Nachrichten verknüpfen, die den automatischen Schwellwert nicht
erreicht haben. Das Feedback ist somit immer auf die betreffende Gruppe
begrenzt und beeinflusst keine andere Gruppe.

Die Seite `/admin/ai-learning` zeigt die Kategorien Relevanz, Events, Action Items,
Orte, Knowledge-Schlüsselwort und Ausschlusswort mit ihren aktuellen und zeitlichen
Lernmetriken. Jede Kategorie besitzt eine eigene Unterseite für Suche,
Paginierung, Bearbeitung und Mehrfachaktionen. Die Zeitmetriken werden aus der
Tabelle `ai_learning_term_history` berechnet und benötigen keine zusätzliche
Konfiguration.
| `WHISPER_ENABLED` | true | whisper.cpp aktivieren. |
| `WHISPER_MODEL` | medium | Modellgröße. |
| `WHISPER_LANGUAGE` | auto | Automatische oder feste Sprache. |
| `WHISPER_LANGUAGES` | es,ca,de,en,fr | Aktivierte Sprachen. |
| `WHISPER_CPP_BIN`, `WHISPER_MODEL_PATH` | automatisch | whisper.cpp und GGML-Modell. |
| `WHISPER_THREADS` | 4 | CPU-Threads. |
| `MEDIA_MAX_RETRIES`, `MEDIA_STALE_PROCESSING_SECONDS` | 3 / 900 | Medien-Retry und Recovery. |
| `MEDIA_ANALYSIS_EVENT_MAX_CHARS` | 12000 | OCR-/Dokument-Payload. |
| `AUDIO_WORK_DIR`, `LOG_LEVEL` | dienstabhängig | Arbeitsverzeichnis und Log-Level. |

Die Relevanz wird als `high`, `medium` oder `low` gespeichert. Die dafür
verwendeten globalen Sprachbegriffe sowie gruppenspezifischen Lerngewichte
werden nicht über Umgebungsvariablen, sondern in der Tabelle
`ai_learning_terms` gepflegt. Administratoren können sie unter
`/admin/ai-learning` nach Sprache und Kategorie verwalten. Die Kategorien sind
Relevanz, Event, Action Items, Ort, Knowledge-Schlüsselwort und Ausschlusswort.

Die Listen können über die Gewichtsspalte auf jeder Kategorie-Unterseite
aufsteigend oder absteigend sortiert werden. Beim manuellen Löschen wird der
Begriff in `ai_learning_term_exclusions` als dauerhafter Ausschluss für seine
Sprache, Kategorie, sein Thema und seine Gruppe gespeichert. Automatisches
Lernen und Hermes-Prüfungen berücksichtigen diese Ausschlüsse. Eine bewusst
neu angelegte oder bearbeitete Entsprechung durch den Administrator hebt den
passenden Ausschluss wieder auf.

Die Migration `014_relevance_learning.sql` legt die Lernstruktur und die
initialen Heuristikbegriffe an. Die Folge-Migration
`015_more_exclusion_words.sql` ergänzt die fünf unterstützten Sprachen um
weitere Füllwörter, Gesprächspartikeln und häufige Floskeln. Die Ausschluss-
und Füllwortlisten werden zur Laufzeit ausschließlich aus der Datenbank geladen;
im AI-Worker und in der API gibt es dafür keine parallelen statischen Listen.
Die bestehende Migration 014 wird nicht nachträglich geändert, damit ihre
Prüfsumme bei bereits installierten Systemen stabil bleibt.
`026_ai_learning_exclusions.sql` ergänzt die dauerhaften Tombstones für
manuell entfernte Lernbegriffe.
`027_action_items_learning.sql` ergänzt die JSONB-Persistenz für Action Items,
die Kategorie-Constraints und mehrsprachige Standardbegriffe für Aufgaben.

Die Standard-KB-Themen werden durch `019_knowledge_topics.sql` in
`knowledge_topic_definitions` angelegt; `022_knowledge_topic_roles.sql`
ergänzt die datenbankbasierte Signalrolle je Thema.
`021_knowledge_heuristics.sql` legt
die datenbankbasierten Topic-/Detailbegriffe an und ergänzt
`knowledge_subtopic_terms` für die gruppen- und sprachgebundene, konservative
Unterthemen-Heuristik. Der AI-Worker liest Themen, Beschreibungen und Begriffe
bei der Verarbeitung aus PostgreSQL; neue Oberthemen müssen daher nicht im
Code ergänzt werden. Unterthemen werden aus Inhaltsüberschneidungen gebildet,
ihre verwendeten Begriffe mit kleinen Gewichten gespeichert und bei späteren
Nachrichten wieder berücksichtigt. Die Titel werden aus dem Threadinhalt
abgeleitet. Ein „KB neu erstellen“-Lauf baut diese Struktur in einer separaten
Generation neu auf und schaltet sie erst nach erfolgreichem Abschluss aktiv.

## Betriebsregeln

- Secrets nie in Git, QR-Logs oder frei zugängliche Konfigurationsdateien legen.
- Nach Änderungen an `.env` die betroffenen Container neu erstellen.
- Bestehende Datenbanken führen Migrationen über den `migrate`-Service aus.
- Für neue Registrierungen muss `SMTP_ENABLED=true` und der SMTP-Server aus
  dem API-Container erreichbar sein. Der Bootstrap-Administrator bleibt davon
  unabhängig.
