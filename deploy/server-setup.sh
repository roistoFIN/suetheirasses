#!/usr/bin/env bash
# One-time bootstrap for a fresh Ubuntu box that will run suethemchickens.online.
#
# Run this AS ROOT, once, on the new server:
#   scp deploy/server-setup.sh root@204.168.187.107:/root/
#   ssh root@204.168.187.107
#   bash /root/server-setup.sh
#
# What it does, in order:
#   1. Updates packages, enables unattended-upgrades for security patches.
#   2. Creates a non-root `deploy` user with sudo, and copies your current
#      authorized_keys to it (so you can still log in after root SSH is disabled).
#   3. Hardens sshd: no root login, no password auth (key-only).
#   4. Sets up ufw allowing only SSH/HTTP/HTTPS.
#   5. Installs Docker Engine + the Compose plugin, adds `deploy` to the docker group.
#   6. Creates /opt/suethemchickens (owned by deploy) — this is the DEPLOY_HOST target
#      directory the GitHub Actions deploy job (.github/workflows/docker.yml) writes to.
#   7. Generates a passphrase-less deploy-only SSH keypair for GitHub Actions to use
#      (never your personal key — Actions can't handle a passphrase prompt) and prints
#      the private key once, for you to paste into the DEPLOY_SSH_KEY GitHub secret.
#
# Safe to re-run — every step is idempotent (checks before creating/changing).

set -euo pipefail

DEPLOY_USER="deploy"
APP_DIR="/opt/suethemchickens"

echo "==> Updating packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ufw unattended-upgrades ca-certificates gnupg

echo "==> Enabling unattended-upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Creating ${DEPLOY_USER} user"
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
  usermod -aG sudo "${DEPLOY_USER}"
fi

echo "==> Copying your current authorized_keys to ${DEPLOY_USER} (so you can still log in once root SSH is off)"
mkdir -p "/home/${DEPLOY_USER}/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
fi
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
chmod 700 "/home/${DEPLOY_USER}/.ssh"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys" 2>/dev/null || true

echo "==> Hardening sshd (root login off, password auth off)"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh

echo "==> Configuring firewall (22, 80, 443)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "${DEPLOY_USER}"

echo "==> Creating ${APP_DIR}"
mkdir -p "${APP_DIR}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_DIR}"

echo "==> Generating a passphrase-less CI deploy key (GitHub Actions can't handle a passphrase prompt)"
CI_KEY="/home/${DEPLOY_USER}/.ssh/github_actions_deploy"
if [ ! -f "${CI_KEY}" ]; then
  sudo -u "${DEPLOY_USER}" ssh-keygen -t ed25519 -N "" -f "${CI_KEY}" -C "github-actions-deploy"
  cat "${CI_KEY}.pub" >> "/home/${DEPLOY_USER}/.ssh/authorized_keys"
fi

echo ""
echo "=================================================================="
echo "Done. Next steps:"
echo ""
echo "1. From THIS terminal (still logged in), open a SECOND terminal and"
echo "   confirm you can log in as the deploy user BEFORE closing this session:"
echo "     ssh ${DEPLOY_USER}@$(curl -s ifconfig.me)"
echo ""
echo "2. Copy this private key into the GitHub repo secret DEPLOY_SSH_KEY"
echo "   (Settings -> Secrets and variables -> Actions -> New repository secret)."
echo "   It is only ever printed this once:"
echo "------------------------------------------------------------------"
cat "${CI_KEY}"
echo "------------------------------------------------------------------"
echo ""
echo "3. Also set these repository secrets:"
echo "     DEPLOY_HOST = $(curl -s ifconfig.me)"
echo "     DEPLOY_USER = ${DEPLOY_USER}"
echo ""
echo "4. Copy .env.production.example to ${APP_DIR}/.env as the deploy user"
echo "   and fill in POSTGRES_PASSWORD / ADMIN_TOKEN (openssl rand -hex 24 for each)."
echo "=================================================================="
