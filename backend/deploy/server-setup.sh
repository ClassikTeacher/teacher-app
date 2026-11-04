#!/usr/bin/env bash
# One-time bootstrap of a fresh Ubuntu (22.04/24.04) server for the Tutor Platform backend. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/ClassikTeacher/teacher-app/main/backend/deploy/server-setup.sh | sudo bash -s -- <deploy-public-key-file-or-string>
# or copy the file and run `sudo ./server-setup.sh "ssh-ed25519 AAAA... deploy"`.
#
# What it does (idempotent): Docker Engine + compose plugin, user `deploy` in the docker group with the given
# SSH public key, /opt/tutor-platform owned by deploy, ufw (22, 80, 443), unattended security upgrades.
# It does NOT create .env: copy .env.prod.example to /opt/tutor-platform/.env and fill it in (docs/DEPLOY.md).
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/tutor-platform}"
PUBKEY="${1:-}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -n "$PUBKEY" ]] || { echo "usage: server-setup.sh <deploy ssh public key (file or string)>" >&2; exit 1; }
[[ -f "$PUBKEY" ]] && PUBKEY="$(cat "$PUBKEY")"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg ufw unattended-upgrades rsync

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
grep -qxF "$PUBKEY" "/home/$DEPLOY_USER/.ssh/authorized_keys" || echo "$PUBKEY" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 0600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/backups" "$APP_DIR/.deploy"

# docker's json-file logs are capped per container in the compose file; keep the daemon defaults sane too
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
systemctl restart docker

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

dpkg-reconfigure -f noninteractive unattended-upgrades

cat <<EOF

Server is ready.
  1. Put the compose files in $APP_DIR (the deploy workflow syncs backend/deploy/ there on every deploy).
  2. Create $APP_DIR/.env from .env.prod.example (chmod 600, owner $DEPLOY_USER).
  3. Point the DNS A/AAAA record of DOMAIN at this server, then run the "Deploy" workflow in GitHub Actions.
Optional for manual pulls/rollbacks without the workflow: as $DEPLOY_USER run
  echo <GHCR read:packages PAT> | docker login ghcr.io -u <github-login> --password-stdin
EOF
