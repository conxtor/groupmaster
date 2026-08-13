# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build` gestartet. Die versionierten Migrationen aus `infra/migrations` werden beim ersten Anlegen des PostgreSQL-Volumes und bei jedem Lauf des `migrate`-Dienstes verarbeitet. Für bereits bestehende Datenbanken genügt daher `docker-compose --env-file .env -f infra/docker/docker-compose.yml run --rm migrate`; der Runner prüft Version und SHA-256-Prüfsumme jeder Migration. Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf `supabase_admin` stehen; dieser Wert ist der Compose- und `.env.example`-Standard. Der optionale `HF_TOKEN` wird aus der Projektdatei `.env` an den AI-Worker weitergereicht.

## Dockge / öffentliches Deployment

Für den produktionsnahen Betrieb gibt es die getrennte Datei `docker-compose-dockge.yaml` im Projektstamm. Sie verwendet ausschließlich die in GHCR veröffentlichten WAGI-Images; die lokale Compose-Datei bleibt unverändert.

1. In der Organisation `conxtor` unter **Settings → Packages → Package Creation** öffentliche Pakete als Standard erlauben. Bereits erzeugte Pakete müssen auf ihrer GitHub-Paket-Seite unter **Package settings → Change visibility → Public** umgestellt werden.
2. Den Workflow `.github/workflows/publish-ghcr.yml` in GitHub unter **Actions** manuell mit `workflow_dispatch` starten. Er veröffentlicht `wagi-api`, `wagi-web`, `wagi-ai-worker`, `wagi-media-worker`, `wagi-wa-connector`, `wagi-tg-connector`, `wagi-nats-provisioner` und `wagi-migrate` ausschließlich für `linux/amd64` (Intel/AMD x86_64).
3. GHCR-Zugriff für Dockge/Docker ist bei öffentlichen Images nicht erforderlich. Für private Images wäre `docker login ghcr.io` mit einem GitHub-Token mit `read:packages` nötig.
4. `.env.example-dockge` nach `.env-dockge` kopieren und alle `REPLACE_ME`-Werte setzen. Dockge muss diese Datei als Environment-Datei des Stacks verwenden.
5. Den Stack mit `docker-compose --env-file .env-dockge -f docker-compose-dockge.yaml up -d` starten.

`GHCR_ADMIN_TOKEN` wird für diesen Workflow nicht benötigt. Die Sichtbarkeit wird einmalig in der GitHub-Paketverwaltung oder über die Organisationsvoreinstellung festgelegt. Öffentliche GHCR-Container können anschließend ohne Authentifizierung geladen werden.

Das Dockge-Migrations-Image enthält den SQL-Migrationsrunner und alle Migrationen. Dadurch benötigt der Dockge-Stack keine relativen Mounts auf `infra/migration-runner` oder `infra/migrations`; der Fehler `/runner/run.sh: not found` tritt auch dann nicht auf, wenn Dockge nur die Compose- und Env-Datei verwaltet.

Traefik veröffentlicht nur `https://conxtor.com` und routet ausschließlich zur Web-Anwendung. Die Web-Route fordert über `tls.domains[0].main` ausdrücklich ein Zertifikat für `conxtor.com` beim Resolver aus `TRAEFIK_CERTRESOLVER` an. Next.js leitet `/api/...` serverseitig über `API_INTERNAL_URL` an die interne Go-API weiter. PostgreSQL, NATS, MinIO, die Go-API, die Connectoren und die Worker haben keine veröffentlichten Ports und die API ist ausdrücklich für Traefik deaktiviert. Die Compose-Datei deklariert keine eigenen oder externen Docker-Netzwerke; alle Dienste verwenden das von Compose automatisch bereitgestellte Standardnetzwerk. Traefik muss dieses Stack-Netzwerk in der vorhandenen Serverkonfiguration erreichen können. Weil Frontend und API für den Browser denselben Host verwenden, bleibt `WAGI_CORS_ORIGIN` leer; CORS ist für den normalen Browserzugriff nicht erforderlich. `WAGI_COOKIE_SECURE=true` setzt sichere Session-Cookies für HTTPS.

Wenn weiterhin `TRAEFIK DEFAULT CERT` angezeigt wird, ist der im Label eingetragene Resolvername in der laufenden Traefik-Instanz nicht definiert oder ACME ist dort nicht erfolgreich konfiguriert. Für den Standardwert `TRAEFIK_CERTRESOLVER=letsencrypt` muss Traefik statisch beispielsweise Folgendes enthalten:

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@example.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

Außerdem müssen `conxtor.com` (A und gegebenenfalls AAAA) auf den Server zeigen und die Ports 80 und 443 den Traefik-EntryPoints `web` und `websecure` zugeordnet sein. Bei einem anderen Resolvernamen muss ausschließlich `TRAEFIK_CERTRESOLVER` in `.env-dockge` angepasst werden. Nach Änderung der Traefik- oder Stack-Konfiguration den Stack neu deployen und die Traefik-Logs auf eine erfolgreiche ACME-Ausstellung prüfen.

Die Compose-Varianten enthalten keinen separaten Bucket-Initialisierungsdienst. Der `media-worker` prüft den jeweiligen typabhängigen Bucket (`MINIO_BUCKET_IMAGES`, `MINIO_BUCKET_VIDEOS`, `MINIO_BUCKET_AUDIO`, `MINIO_BUCKET_DOCUMENTS` oder `MINIO_BUCKET_OTHER`) vor Medienzugriffen und legt ihn bei Bedarf idempotent an. Die API führt bei aktiviertem `MEDIA_BUCKET_MIGRATION_ENABLED` beim Start einmalig die wiederaufnehmbare Migration aus dem Legacy-Bucket `MINIO_BUCKET` aus. Ein Neustart löscht weder Buckets noch vorhandene Objekte. Die Dockge-Variante verwendet eigene, benannte Volumes (`wagi_dockge_*`) für Datenbank, JetStream, MinIO, Medien, Connector-Sessions und Modelle. Dadurch werden lokale Testdaten nicht verwendet und ein Stack-Neustart löscht keine persistenten Daten.
