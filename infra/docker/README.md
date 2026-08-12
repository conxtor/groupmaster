# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build` gestartet. Die vollständigen Migrationen aus `infra/migrations` werden beim ersten Anlegen des PostgreSQL-Volumes geladen. Für eine bereits bestehende Datenbank müssen `006_auth_multitenancy.sql`, `007_connector_onboarding_pool.sql` und `008_whatsapp_contacts.sql` einmal manuell ausgeführt werden. Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf `supabase_admin` stehen; dieser Wert ist der Compose- und `.env.example`-Standard. Der optionale `HF_TOKEN` wird aus der Projektdatei `.env` an den AI-Worker weitergereicht.

## Dockge / öffentliches Deployment

Für den produktionsnahen Betrieb gibt es die getrennte Datei `docker-compose-dockge.yaml` im Projektstamm. Sie verwendet ausschließlich die in GHCR veröffentlichten WAGI-Images; die lokale Compose-Datei bleibt unverändert.

1. In der Organisation `conxtor` unter **Settings → Packages → Package Creation** öffentliche Pakete als Standard erlauben. Bereits erzeugte Pakete müssen auf ihrer GitHub-Paket-Seite unter **Package settings → Change visibility → Public** umgestellt werden.
2. Den Workflow `.github/workflows/publish-ghcr.yml` in GitHub unter **Actions** manuell mit `workflow_dispatch` starten. Er veröffentlicht `wagi-api`, `wagi-web`, `wagi-ai-worker`, `wagi-media-worker`, `wagi-wa-connector`, `wagi-tg-connector` und `wagi-nats-provisioner` ausschließlich für `linux/amd64` (Intel/AMD x86_64) und prüft anschließend den anonymen Abruf jedes Images.
3. GHCR-Zugriff für Dockge/Docker ist bei öffentlichen Images nicht erforderlich. Für private Images wäre `docker login ghcr.io` mit einem GitHub-Token mit `read:packages` nötig.
4. `.env.example-dockge` nach `.env-dockge` kopieren und alle `REPLACE_ME`-Werte setzen. Dockge muss diese Datei als Environment-Datei des Stacks verwenden.
5. Den Stack mit `docker-compose --env-file .env-dockge -f docker-compose-dockge.yaml up -d` starten.

`GHCR_ADMIN_TOKEN` wird für diesen Workflow nicht benötigt: GitHub bietet für die Sichtbarkeit von GHCR-Organisationspaketen keinen unterstützten REST-Endpunkt. Die Sichtbarkeit wird daher einmalig in der GitHub-Paketverwaltung oder über die Organisationsvoreinstellung festgelegt. Der Workflow prüft danach, dass das Image anonym geladen werden kann. GitHub dokumentiert, dass die Sichtbarkeit von Organisationspaketen über die Paketverwaltung geändert wird und öffentliche Container ohne Authentifizierung abrufbar sind.

Traefik veröffentlicht nur `https://conxtor.com`: `/api/...` wird an die interne Go-API und alle übrigen Pfade an die interne Next.js-Anwendung geroutet. PostgreSQL, NATS, MinIO, die Connectoren und die Worker haben keine veröffentlichten Ports. Die Compose-Datei deklariert keine eigenen oder externen Docker-Netzwerke; alle Dienste verwenden das von Compose automatisch bereitgestellte Standardnetzwerk. Traefik muss dieses Stack-Netzwerk in der vorhandenen Serverkonfiguration erreichen können. Weil Frontend und API denselben Host verwenden, bleibt `WAGI_CORS_ORIGIN` leer; CORS ist für den normalen Browserzugriff nicht erforderlich. `WAGI_COOKIE_SECURE=true` setzt sichere Session-Cookies für HTTPS.

Die Dockge-Variante verwendet eigene, benannte Volumes (`wagi_dockge_*`) für Datenbank, JetStream, MinIO, Medien, Connector-Sessions und Modelle. Dadurch werden lokale Testdaten nicht verwendet und ein Stack-Neustart löscht keine persistenten Daten.
