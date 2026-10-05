#!/usr/bin/env bash
# Flowdeck server setup for a fresh Ubuntu 22.04 / 24.04 VM. Run in the VM's SSH window:
#
#   curl -fsSL https://raw.githubusercontent.com/Blackhat1314/FlowDeck_prod/main/deploy/setup.sh -o setup.sh
#   sudo bash setup.sh flowdeck.site
#
# It downloads the app from GitHub into /opt/flowdeck, runs it as a service that restarts on crashes and reboots,
# and puts Caddy in front, which gets and renews the HTTPS certificate on its own. Running it again is safe: it
# updates the app and keeps the database (/var/lib/flowdeck) and settings (/etc/flowdeck/flowdeck.env).
set -euo pipefail

REPO="${FLOWDECK_REPO:-https://github.com/Blackhat1314/FlowDeck_prod.git}"
BRANCH="${FLOWDECK_BRANCH:-main}"
APP=/opt/flowdeck
SRC=$APP/src
DATA=/var/lib/flowdeck
ETC=/etc/flowdeck
ENVF=$ETC/flowdeck.env
PORT=8000

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m%s\033[0m\n' "$*"; }
warn() { printf '   \033[33m%s\033[0m\n' "$*"; }

main() {   # everything runs from here, so updating this file mid-run can't confuse bash
  local domain="${1:-}"
  if [ -z "$domain" ] && [ -f "$ETC/domain" ]; then domain="$(cat "$ETC/domain")"; fi
  if [ -z "$domain" ]; then echo "usage: sudo bash setup.sh <domain>     for example: sudo bash setup.sh flowdeck.site"; exit 1; fi
  if [ "$(id -u)" != 0 ]; then echo "Run it with sudo:  sudo bash setup.sh $domain"; exit 1; fi
  domain="${domain#http://}"; domain="${domain#https://}"; domain="${domain%%/*}"

  step "1/8 System packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q git python3-venv python3-pip curl gnupg debian-keyring debian-archive-keyring apt-transport-https
  ok "installed"

  step "2/8 Swap (2 GB safety net for memory spikes)"
  if swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
    ok "already on"
  else
    [ -f /swapfile ] || { fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "2 GB swap on"
  fi

  step "3/8 Can this server reach the exchanges?"
  local blocked=0 u code
  for u in https://fapi.binance.com/fapi/v1/ping https://dapi.binance.com/dapi/v1/ping https://api.binance.com/api/v3/ping \
           https://api.bybit.com/v5/market/time https://www.okx.com/api/v5/public/time \
           https://api.exchange.coinbase.com/time https://www.deribit.com/api/v2/public/get_time; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$u" || true)
    printf '   %-52s %s\n' "$u" "$code"
    [ "$code" = 200 ] || blocked=1
  done
  if [ $blocked = 0 ]; then ok "all reachable"; else warn "an exchange didn't answer 200: its feed will stay offline. Send this output to Claude."; fi

  step "4/8 App code from GitHub ($REPO, $BRANCH)"
  mkdir -p "$APP" "$DATA" "$ETC"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch -q --depth 1 origin "$BRANCH"
    git -C "$SRC" reset -q --hard FETCH_HEAD
  else
    rm -rf "$SRC"
    git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
  fi
  ok "at commit $(git -C "$SRC" log -1 --format='%h %s')"

  step "5/8 Python packages"
  id flowdeck >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin flowdeck
  [ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
  "$APP/venv/bin/pip" install -q --disable-pip-version-check --upgrade pip
  "$APP/venv/bin/pip" install -q --disable-pip-version-check -r "$SRC/backend/requirements.txt"
  "$APP/venv/bin/python" -m compileall -q "$SRC/backend/app" >/dev/null || true
  chown -R root:root "$APP"           # code is read-only for the app
  chown -R flowdeck:flowdeck "$DATA"  # only the database folder is writable
  chmod 750 "$DATA"
  ok "Python $("$APP/venv/bin/python" -c 'import sys; print(sys.version.split()[0])'), packages installed"

  step "6/8 Settings and the app service"
  if [ ! -f "$ENVF" ]; then
    cat > "$ENVF" <<EOF
# Flowdeck settings. After editing: sudo systemctl restart flowdeck
FLOWDECK_DB=$DATA/flowdeck.db
# Caddy is the one proxy in front: trust its X-Forwarded-* headers, and only send the cookie over HTTPS
FLOWDECK_TRUST_PROXY=1
FLOWDECK_PROXY_HOPS=1
FLOWDECK_SECURE_COOKIE=1
FLOW_VENUE=usdm
# the site's address, used for links in emails (never taken from the request)
FLOWDECK_SITE_URL=https://$domain
# Email for password resets and new sign-in alerts (any SMTP provider; port 25 is blocked on Google Cloud), then restart:
# SMTP_HOST=smtp.resend.com
# SMTP_PORT=587
# SMTP_USER=resend
# SMTP_PASSWORD=re_xxxxxxxxxxxxxxxx
# MAIL_FROM=Flowdeck <no-reply@$domain>
# Razorpay keys for the Pay button (Dashboard > Account & Settings > API Keys), then restart:
# RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxxx
# RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
# History on disk ($DATA/history): days of 1-minute heatmap + footprint to keep (0 = forever),
# and days of footprint to back-fill from Binance's daily trade files (0 = off)
# FLOWDECK_ARCHIVE_DAYS=0
# FLOWDECK_FILL_DAYS=7
EOF
    ok "wrote $ENVF"
  else
    ok "kept $ENVF"
  fi
  chown root:flowdeck "$ENVF"; chmod 640 "$ENVF"
  echo "$domain" > "$ETC/domain"
  install -m 644 "$SRC/deploy/flowdeck.service" /etc/systemd/system/flowdeck.service
  systemctl daemon-reload
  systemctl enable -q flowdeck
  systemctl restart flowdeck
  printf '   waiting for the app'
  local up=0
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/login"; then up=1; break; fi
    printf '.'; sleep 1
  done
  echo
  if [ $up = 1 ]; then ok "app running on 127.0.0.1:$PORT"; else
    warn "the app didn't start. Last log lines:"; journalctl -u flowdeck -n 40 --no-pager; exit 1; fi

  step "7/8 Caddy and HTTPS for $domain"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
  sed "s/__DOMAIN__/$domain/g" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; exit 1; }
  systemctl enable -q caddy
  systemctl restart caddy
  ok "Caddy serving $domain (www.$domain redirects to it)"

  step "8/8 Checks"
  local myip dnsip
  myip=$(curl -s -m 5 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' || true)
  [ -n "$myip" ] || myip=$(curl -s -m 5 https://api.ipify.org || true)
  dnsip=$(getent ahostsv4 "$domain" | awk 'NR==1{print $1}' || true)
  echo "   this server's public IP : ${myip:-unknown}"
  echo "   $domain points to       : ${dnsip:-nothing yet}"
  if [ -n "$myip" ] && [ "$myip" != "$dnsip" ]; then
    warn "DNS doesn't point here yet. Caddy keeps retrying and gets the certificate once it does."
  fi
  printf '   waiting for the HTTPS certificate'
  local live=0
  for _ in $(seq 1 40); do
    if curl -fs -o /dev/null -m 5 "https://$domain/login"; then live=1; break; fi
    printf '.'; sleep 3
  done
  echo
  if [ $live = 1 ]; then ok "https://$domain is live"; else
    warn "HTTPS isn't ready yet. Check again in a few minutes:  curl -I https://$domain"
    warn "Caddy's log:  sudo journalctl -u caddy -n 50 --no-pager"
  fi

  if [ -f "$DATA/FIRST_ADMIN_LOGIN.txt" ]; then
    echo
    echo "   ------------------------------------------------------------"
    sed 's/^/   /' "$DATA/FIRST_ADMIN_LOGIN.txt"
    echo "   ------------------------------------------------------------"
    echo "   Sign in at https://$domain/login, change the password and email,"
    echo "   then delete the file:  sudo rm $DATA/FIRST_ADMIN_LOGIN.txt"
  fi
  cat <<EOF

Done. Useful commands:
  sudo bash $SRC/deploy/update.sh       get the latest code from GitHub and restart
  sudo systemctl status flowdeck        is the app running?
  sudo journalctl -u flowdeck -f        live app log (Ctrl+C to stop)
  sudo systemctl restart flowdeck       restart the app
EOF
}

main "$@"
