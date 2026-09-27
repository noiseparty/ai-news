#!/usr/bin/env bash
#
# deploy.sh -- install / update ai.skabene.id.lv on the VPS.
#
# Idempotent: safe to re-run. Never touches /var/lib/ai-news (posts + subscribers), never
# regenerates an existing ADMIN_TOKEN, never restarts Caddy (reload only), and validates
# the Caddyfile before loading it, restoring the backup on any failure.
#
#   ./deploy/deploy.sh            -- from the workstation: push the tree, then run phase 2 over ssh
#   ./deploy/deploy.sh --on-box   -- phase 2; runs as root ON the VPS

set -Eeuo pipefail

HOST="${AI_DEPLOY_HOST:-84.247.128.86}"
SSH_USER="${AI_DEPLOY_USER:-root}"
APP_DIR="/opt/ai-news"
STAGE_DIR="/root/ai-news-deploy"
UNIT_NAME="ai-news.service"
UNIT_DST="/etc/systemd/system/$UNIT_NAME"
ENV_FILE="/etc/ai-news.env"
CADDYFILE="/etc/caddy/Caddyfile"
SITE="ai.skabene.id.lv"
PORT=8931

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

say()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
trap 'rc=$?; printf "FATAL: failed at line %s (exit %s): %s\n" "$LINENO" "$rc" "$BASH_COMMAND" >&2; exit $rc' ERR

on_box() {
  [ "$(id -u)" -eq 0 ] || die "phase 2 must run as root on the VPS"
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$APP_DIR/server.js" ] || die "$APP_DIR/server.js missing -- phase 1 (push) did not run"
  /usr/bin/node --check "$APP_DIR/server.js" || die "server.js failed node --check on the box"
  chown -R root:root "$APP_DIR"
  chmod -R u=rwX,go=rX "$APP_DIR"   # DynamicUser must be able to read the code

  # ---- secret: generated once, kept forever ----------------------------------------
  if [ ! -s "$ENV_FILE" ]; then
    say "generating ADMIN_TOKEN into $ENV_FILE (root:root 0600)"
    umask 077
    printf 'ADMIN_TOKEN=%s\nSITE_TITLE=AI Dispatch\n' "$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')" > "$ENV_FILE"
  fi
  chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"

  # ---- systemd -----------------------------------------------------------------------
  if ! cmp -s "$here/ai-news.service" "$UNIT_DST"; then
    say "installing $UNIT_DST"
    install -o root -g root -m 0644 "$here/ai-news.service" "$UNIT_DST"
    systemctl daemon-reload
  fi
  systemctl enable "$UNIT_NAME" >/dev/null
  systemctl restart "$UNIT_NAME"

  say "waiting for 127.0.0.1:$PORT/api/health"
  local ok=0 i
  for i in $(seq 1 20); do
    if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" -ne 1 ]; then
    journalctl -u "$UNIT_NAME" -n 60 --no-pager >&2 || true
    die "$UNIT_NAME did not answer within 20s"
  fi

  # ---- Caddy ---------------------------------------------------------------------------
  # Pre-create the log as caddy:caddy -- a root-run `caddy validate` would otherwise create it
  # root:root 0600 and the real reload would fail with permission denied (see status-page INFRA.md).
  local log_path=/var/log/caddy/ai.log
  [ -e "$log_path" ] || : > "$log_path"
  chown caddy:caddy "$log_path"; chmod 0640 "$log_path"

  if grep -qE "^[[:space:]]*${SITE//./\\.}[[:space:]]*\{" "$CADDYFILE"; then
    say "Caddy block for $SITE already present -- not appending"
  else
    local backup="$CADDYFILE.bak-ai-$(date +%Y-%m-%d-%H%M)"
    cp -a "$CADDYFILE" "$backup"
    cat "$here/caddy-ai-block.txt" >> "$CADDYFILE"
    if ! caddy validate --adapter caddyfile --config "$CADDYFILE"; then
      cp -a "$backup" "$CADDYFILE"
      die "Caddyfile rejected; previous config restored, Caddy untouched"
    fi
    if ! timeout 60 caddy reload --config "$CADDYFILE" --adapter caddyfile; then
      cp -a "$backup" "$CADDYFILE"
      timeout 60 caddy reload --config "$CADDYFILE" --adapter caddyfile || warn "rollback reload failed too"
      die "Caddy rejected the new config at load time; previous config restored"
    fi
    say "Caddy reloaded with $SITE (backup: $backup)"
  fi

  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "https://$SITE/api/health" || true)"
  [ "$code" = 200 ] && say "https://$SITE/api/health -> 200" || warn "https://$SITE/api/health -> $code (DNS / cert still propagating?)"
}

push() {
  local src; src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  node --check "$src/server.js"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "install -d -m 0755 '$APP_DIR' && install -d -m 0700 '$STAGE_DIR'"
  say "pushing app -> $HOST:$APP_DIR"
  # Replace code wholesale (tar can't mirror deletions); data lives in /var/lib, not here.
  tar -C "$src" -czf - --exclude=./data --exclude=./.git --exclude=./deploy --exclude=./.env --exclude=./node_modules . \
    | ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "find '$APP_DIR' -mindepth 1 -delete && tar -C '$APP_DIR' -xzf -"
  tar -C "$src/deploy" -czf - . | ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "tar -C '$STAGE_DIR' -xzf -"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "bash '$STAGE_DIR/deploy.sh' --on-box"
}

case "${1:-}" in
  --on-box) on_box ;;
  ""|--push) push ;;
  *) die "usage: deploy.sh [--push | --on-box]" ;;
esac
