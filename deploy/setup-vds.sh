#!/usr/bin/env bash
# One-shot setup: gets Etsy Command Center running on a fresh VDS, reachable
# over real HTTPS from any browser, with no domain purchase and no DNS setup.
#
# Run this ON THE VDS (SSH into it first), as a user that has sudo:
#
#   bash deploy/setup-vds.sh <VDS_PUBLIC_IP>
#
# Example:
#   bash deploy/setup-vds.sh 203.0.113.45
#
# What it does, in order: installs Node if missing, installs the app,
# builds it, generates a random app password, installs Caddy for automatic
# HTTPS (using a free nip.io hostname that maps straight back to your IP,
# so no domain is needed), installs a systemd service so the app survives
# reboots, and prints the URL + password to open it from a browser.
#
# Safe to re-run: it reuses what is already installed/configured instead of
# redoing it, except it always rebuilds the app itself so you're on the
# latest code.

set -euo pipefail

IP="${1:-}"
if [[ -z "$IP" ]]; then
  echo "Usage: bash deploy/setup-vds.sh <VDS_PUBLIC_IP>" >&2
  exit 1
fi
HOSTNAME_="$(echo "$IP" | tr '.' '-').nip.io"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "==> App directory: $APP_DIR"
echo "==> Public URL will be: https://$HOSTNAME_"

# --- Node -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  echo "==> Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

# --- App ----------------------------------------------------------------------
echo "==> Installing and building the app..."
npm run setup
npm run build

# --- .env / app password ------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
fi
if ! grep -q '^APP_PASSWORD=.\+' "$ENV_FILE"; then
  GENERATED_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  if grep -q '^APP_PASSWORD=' "$ENV_FILE"; then
    sed -i "s|^APP_PASSWORD=.*|APP_PASSWORD=$GENERATED_PASSWORD|" "$ENV_FILE"
  else
    echo "APP_PASSWORD=$GENERATED_PASSWORD" >> "$ENV_FILE"
  fi
fi
APP_PASSWORD="$(grep '^APP_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
grep -q '^HOST=' "$ENV_FILE" && sed -i "s|^HOST=.*|HOST=127.0.0.1|" "$ENV_FILE" || echo "HOST=127.0.0.1" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- Caddy (automatic HTTPS) --------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$HOSTNAME_ {
	reverse_proxy 127.0.0.1:4317
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

# --- systemd service -----------------------------------------------------------
CURRENT_USER="$(whoami)"
sudo tee /etc/systemd/system/etsy-command-center.service >/dev/null <<SERVICE
[Unit]
Description=Etsy Command Center
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) scripts/start.mjs
Restart=on-failure
RestartSec=5
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
SERVICE
sudo systemctl daemon-reload
sudo systemctl enable --now etsy-command-center
sudo systemctl restart etsy-command-center

# --- firewall (best-effort; skipped if ufw isn't in use) -----------------------
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 443/tcp >/dev/null || true
  sudo ufw allow 22/tcp >/dev/null || true
fi

echo ""
echo "================================================================"
echo " Ready."
echo ""
echo " Open:      https://$HOSTNAME_"
echo " Password:  $APP_PASSWORD"
echo ""
echo " Write these two down -- the password is also saved in:"
echo "   $ENV_FILE"
echo "================================================================"
