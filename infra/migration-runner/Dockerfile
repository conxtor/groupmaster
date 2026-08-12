FROM postgres:15-alpine

COPY infra/migration-runner/run.sh /usr/local/bin/wagi-migrate
COPY infra/migrations /migrations

RUN chmod 0755 /usr/local/bin/wagi-migrate
