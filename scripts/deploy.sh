#!/usr/bin/env bash
# Roda NO SERVIDOR (como root), chamado pelo GitHub Actions apos o git reset.
# Idempotente: pode rodar quantas vezes quiser.
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/conecta-pup}"
APP_USER="pup"
DOMAIN="${DOMAIN:-pup.pontedosdados.com.br}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n==> %s\n' "$*"; }

log "Dependencias do sistema (Chromium, nginx, certbot)"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl git nginx certbot python3-certbot-nginx \
  fonts-liberation fonts-noto-color-emoji \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
  libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
  libxrandr2 xdg-utils

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "Instalando Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

log "Usuario de servico"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

run_as_app() {
  runuser -u "$APP_USER" -- env \
    HOME="$APP_DIR" \
    PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer" \
    "$@"
}

log "npm ci + build"
cd "$APP_DIR"
run_as_app npm ci --no-audit --no-fund
run_as_app npm run build
run_as_app npm prune --omit=dev --no-audit --no-fund
run_as_app mkdir -p "$APP_DIR/.sessions"

log "systemd"
install -m 644 "$APP_DIR/deploy/conecta-pup.service" /etc/systemd/system/conecta-pup.service
systemctl daemon-reload
systemctl enable conecta-pup >/dev/null
systemctl restart conecta-pup

log "nginx"
install -m 644 "$APP_DIR/deploy/nginx-conecta-pup.conf" /etc/nginx/sites-available/conecta-pup
ln -sf /etc/nginx/sites-available/conecta-pup /etc/nginx/sites-enabled/conecta-pup
nginx -t
systemctl reload nginx

log "Certificado HTTPS"
SERVER_IP="$(curl -fsS -m 5 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "Certificado de $DOMAIN ja existe (renovacao automatica via certbot.timer)"
elif [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then
  if [ -n "$CERTBOT_EMAIL" ]; then
    EMAIL_ARGS=(-m "$CERTBOT_EMAIL")
  else
    EMAIL_ARGS=(--register-unsafely-without-email)
  fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${EMAIL_ARGS[@]}"
else
  echo "AVISO: DNS de $DOMAIN ($DNS_IP) ainda nao aponta para este servidor ($SERVER_IP); HTTPS sera emitido num proximo deploy."
fi

log "Healthcheck"
for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:3100/health >/dev/null; then
    curl -sS http://127.0.0.1:3100/health; echo
    echo "OK"
    exit 0
  fi
  sleep 2
done
echo "A API nao respondeu em /health"
journalctl -u conecta-pup -n 40 --no-pager || true
exit 1
