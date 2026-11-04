#!/usr/bin/env bash
# Nightly logical backup of PostgreSQL (the pre-deploy dumps are separate, see deploy.sh). Not a replacement for
# WAL archiving with point-in-time recovery (M7-03), but enough for the pilot. Install for the deploy user:
#   crontab -e  →  15 3 * * * /opt/tutor-platform/backup.sh >> /opt/tutor-platform/backups/backup.log 2>&1
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/tutor-platform}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/nightly-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.prod.yml" \
  exec -T postgres pg_dump -U tutor -d tutor --no-owner | gzip > "$file"
find "$BACKUP_DIR" -name 'nightly-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup written: $file ($(du -h "$file" | cut -f1))"
