# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose -f infra/docker/docker-compose.yml up --build` gestartet. Die Migrationen werden beim ersten Anlegen des PostgreSQL-Volumes aus `infra/migrations` geladen.
