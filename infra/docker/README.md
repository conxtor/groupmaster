# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build` gestartet. Die vollständigen Migrationen aus `infra/migrations` werden beim ersten Anlegen des PostgreSQL-Volumes geladen. Für eine bereits bestehende Datenbank müssen `006_auth_multitenancy.sql`, `007_connector_onboarding_pool.sql` und `008_whatsapp_contacts.sql` einmal manuell ausgeführt werden. Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf `supabase_admin` stehen; dieser Wert ist der Compose- und `.env.example`-Standard. Der optionale `HF_TOKEN` wird aus der Projektdatei `.env` an den AI-Worker weitergereicht.

## Dockge / öffentliches Deployment

Für den produktionsnahen Betrieb gibt es die getrennte Datei `docker-compose-dockge.yaml` im Projektstamm. Sie verwendet ausschließlich die in GHCR veröffentlichten WAGI-Images; die lokale Compose-Datei bleibt unverändert.

1. Den Workflow `.github/workflows/publish-ghcr.yml` in GitHub unter **Actions** manuell mit `workflow_dispatch` starten. Er veröffentlicht `wagi-api`, `wagi-web`, `wagi-ai-worker`, `wagi-media-worker`, `wagi-wa-connector`, `wagi-tg-connector` und `wagi-nats-provisioner`.
2. GHCR-Zugriff für Dockge/Docker einrichten, falls die Images privat sind: `docker login ghcr.io` mit einem GitHub-Token mit `read:packages`.
3. `.env.example-dockge` nach `.env-dockge` kopieren und alle `REPLACE_ME`-Werte setzen. Dockge muss diese Datei als Environment-Datei des Stacks verwenden.
4. Den Stack mit `docker-compose --env-file .env-dockge -f docker-compose-dockge.yaml up -d` starten.

Traefik veröffentlicht nur `https://conxtor.com`: `/api/...` wird an die interne Go-API und alle übrigen Pfade an die interne Next.js-Anwendung geroutet. PostgreSQL, NATS, MinIO, die Connectoren und die Worker haben keine veröffentlichten Ports. Die Compose-Datei deklariert keine eigenen oder externen Docker-Netzwerke; alle Dienste verwenden das von Compose automatisch bereitgestellte Standardnetzwerk. Traefik muss dieses Stack-Netzwerk in der vorhandenen Serverkonfiguration erreichen können. Weil Frontend und API denselben Host verwenden, bleibt `WAGI_CORS_ORIGIN` leer; CORS ist für den normalen Browserzugriff nicht erforderlich. `WAGI_COOKIE_SECURE=true` setzt sichere Session-Cookies für HTTPS.

Die Dockge-Variante verwendet eigene, benannte Volumes (`wagi_dockge_*`) für Datenbank, JetStream, MinIO, Medien, Connector-Sessions und Modelle. Dadurch werden lokale Testdaten nicht verwendet und ein Stack-Neustart löscht keine persistenten Daten.
