# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build` gestartet. Die vollständigen Migrationen aus `infra/migrations` werden beim ersten Anlegen des PostgreSQL-Volumes geladen. Für eine bereits bestehende Datenbank müssen `006_auth_multitenancy.sql`, `007_connector_onboarding_pool.sql` und `008_whatsapp_contacts.sql` einmal manuell ausgeführt werden. Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf `supabase_admin` stehen; dieser Wert ist der Compose- und `.env.example`-Standard. Der optionale `HF_TOKEN` wird aus der Projektdatei `.env` an den AI-Worker weitergereicht.

## Dockge / öffentliches Deployment

Für den produktionsnahen Betrieb gibt es die getrennte Datei `docker-compose-dockge.yaml` im Projektstamm. Sie verwendet ausschließlich die in GHCR veröffentlichten WAGI-Images; die lokale Compose-Datei bleibt unverändert.

1. Den Workflow `.github/workflows/publish-ghcr.yml` in GitHub unter **Actions** manuell mit `workflow_dispatch` starten. Er veröffentlicht `wagi-api`, `wagi-web`, `wagi-ai-worker`, `wagi-media-worker`, `wagi-wa-connector`, `wagi-tg-connector` und `wagi-nats-provisioner` ausschließlich für `linux/amd64` (Intel/AMD x86_64) und setzt jedes Paket anschließend auf öffentlich.
2. GHCR-Zugriff für Dockge/Docker einrichten, falls die Images privat sind: `docker login ghcr.io` mit einem GitHub-Token mit `read:packages`.
3. `.env.example-dockge` nach `.env-dockge` kopieren und alle `REPLACE_ME`-Werte setzen. Dockge muss diese Datei als Environment-Datei des Stacks verwenden.
4. Den Stack mit `docker-compose --env-file .env-dockge -f docker-compose-dockge.yaml up -d` starten.

Der Workflow verwendet zuerst `GITHUB_TOKEN` für die Sichtbarkeitsänderung. Falls das Repository dafür keine Paket-Adminrechte besitzt, muss in GitHub ein Repository- oder Organisations-Secret `GHCR_ADMIN_TOKEN` hinterlegt werden. Dieses muss einem Organisationsinhaber gehören und die erforderlichen klassischen GitHub-Packages-Rechte besitzen. Alternativ kann die Organisation `conxtor` unter **Settings → Packages → Package Creation** öffentliche Pakete als Standard erlauben. Bereits erzeugte Pakete können auf ihrer GitHub-Paket-Seite unter **Package settings → Change visibility → Public** umgestellt werden. Öffentliche GHCR-Container können anschließend anonym per `docker pull` geladen werden. GitHub dokumentiert, dass die Sichtbarkeit von Organisationspaketen über die Paketverwaltung geändert wird und öffentliche Container ohne Authentifizierung abrufbar sind.

Traefik veröffentlicht nur `https://conxtor.com`: `/api/...` wird an die interne Go-API und alle übrigen Pfade an die interne Next.js-Anwendung geroutet. PostgreSQL, NATS, MinIO, die Connectoren und die Worker haben keine veröffentlichten Ports. Die Compose-Datei deklariert keine eigenen oder externen Docker-Netzwerke; alle Dienste verwenden das von Compose automatisch bereitgestellte Standardnetzwerk. Traefik muss dieses Stack-Netzwerk in der vorhandenen Serverkonfiguration erreichen können. Weil Frontend und API denselben Host verwenden, bleibt `WAGI_CORS_ORIGIN` leer; CORS ist für den normalen Browserzugriff nicht erforderlich. `WAGI_COOKIE_SECURE=true` setzt sichere Session-Cookies für HTTPS.

Die Dockge-Variante verwendet eigene, benannte Volumes (`wagi_dockge_*`) für Datenbank, JetStream, MinIO, Medien, Connector-Sessions und Modelle. Dadurch werden lokale Testdaten nicht verwendet und ein Stack-Neustart löscht keine persistenten Daten.
