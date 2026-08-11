# Docker-Infrastruktur

Die lokale MVP-Umgebung wird mit `docker-compose --env-file .env -f infra/docker/docker-compose.yml up --build` gestartet. Die vollständige Initialmigration `001_init.sql` wird beim ersten Anlegen des PostgreSQL-Volumes aus `infra/migrations` geladen. Für das verwendete Supabase-Postgres-Image muss `POSTGRES_USER` auf `supabase_admin` stehen; dieser Wert ist der Compose- und `.env.example`-Standard. Der optionale `HF_TOKEN` wird aus der Projektdatei `.env` an den AI-Worker weitergereicht.
