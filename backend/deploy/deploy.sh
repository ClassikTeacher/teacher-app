#!/usr/bin/env bash
# Deploys one image tag of the backend on this server:
#   pull → pre-migration DB dump → migrations → restart api/worker → health wait → (rollback on failure).
#
#   deploy.sh <image-tag>            deploy (or roll back to) the given tag, e.g. sha-1a2b3c4 or main
#   deploy.sh --status               show the running and the previous tag, container state
#   deploy.sh --rollback             redeploy the previous tag (migrations stay: they are backward compatible)
#
# Env: GHCR_USER / GHCR_TOKEN (or GHCR_TOKEN_STDIN=1 and the token on stdin) — `docker login ghcr.io`
#      before pulling; omit when the server is already logged in (server-setup.sh).
#      APP_DIR (default /opt/tutor-platform), KEEP_BACKUPS (default 10).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tutor-platform}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
STATE_DIR="$APP_DIR/.deploy"
BACKUP_DIR="$APP_DIR/backups"
COMPOSE=(docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.prod.yml")

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

current_tag() { cat "$STATE_DIR/current" 2>/dev/null || true; }
previous_tag() { cat "$STATE_DIR/previous" 2>/dev/null || true; }

set_env_tag() {
  # keep IMAGE_TAG in .env so that plain `docker compose` commands see the same image as the deploy
  local tag="$1"
  if grep -q '^IMAGE_TAG=' "$APP_DIR/.env"; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$tag|" "$APP_DIR/.env"
  else
    printf '\nIMAGE_TAG=%s\n' "$tag" >> "$APP_DIR/.env"
  fi
}

status() {
  local cur prev; cur="$(current_tag)"; prev="$(previous_tag)"
  log "current: ${cur:--}  previous: ${prev:--}"
  "${COMPOSE[@]}" ps
}

login_ghcr() {
  # a token from CI is short-lived: log out again at the end so a stale login does not linger on the server
  if [[ "${GHCR_TOKEN_STDIN:-0}" == "1" ]]; then
    docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  elif [[ -n "${GHCR_TOKEN:-}" ]]; then
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  fi
}

backup_db() {
  mkdir -p "$BACKUP_DIR"
  local cur; cur="$(current_tag)"
  local file="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${cur:-none}.sql.gz"
  if [[ -n "$("${COMPOSE[@]}" ps -q --status running postgres 2>/dev/null)" ]] \
     && "${COMPOSE[@]}" exec -T postgres pg_dump -U tutor -d tutor --no-owner | gzip > "$file"; then
    log "database dumped to $file"
    # keep the newest KEEP_BACKUPS dumps
    ls -1t "$BACKUP_DIR"/pre-deploy-*.sql.gz 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
  else
    rm -f "$file"
    log "no running database yet: skipping the pre-deploy dump"
  fi
}

wait_healthy() {
  # `compose up --wait` returns non-zero when a service fails its healthcheck within the start period
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180 api worker
}

deploy() {
  local tag="$1"
  [[ -f "$APP_DIR/.env" ]] || die "$APP_DIR/.env is missing (see .env.prod.example)"
  mkdir -p "$STATE_DIR"
  local prev; prev="$(current_tag)"
  log "deploying $tag (running: ${prev:-none})"

  login_ghcr
  export IMAGE_TAG="$tag"
  "${COMPOSE[@]}" pull --quiet api worker
  "${COMPOSE[@]}" up -d --wait postgres redis s3

  backup_db
  log "applying migrations"
  "${COMPOSE[@]}" run --rm migrate

  if wait_healthy; then
    [[ -n "$prev" && "$prev" != "$tag" ]] && printf '%s' "$prev" > "$STATE_DIR/previous"
    printf '%s' "$tag" > "$STATE_DIR/current"
    set_env_tag "$tag"
    "${COMPOSE[@]}" up -d caddy
    docker image prune -f >/dev/null 2>&1 || true
    log "deployed $tag"
    status
    return 0
  fi

  log "api/worker did not become healthy on $tag"
  "${COMPOSE[@]}" logs --tail=100 api worker || true
  if [[ -n "$prev" && "$prev" != "$tag" ]]; then
    log "rolling back to $prev (migrations of $tag stay applied: they are backward compatible by the DoD)"
    export IMAGE_TAG="$prev"
    "${COMPOSE[@]}" up -d --wait --wait-timeout 180 api worker || log "rollback did not become healthy either"
    set_env_tag "$prev"
  fi
  die "deploy of $tag failed"
}

case "${1:-}" in
  --status) status ;;
  --rollback)
    prev="$(previous_tag)"
    [[ -n "$prev" ]] || die "no previous tag recorded"
    deploy "$prev"
    ;;
  '' | -h | --help) sed -n '2,12p' "$0" ;;
  *) deploy "$1" ;;
esac
