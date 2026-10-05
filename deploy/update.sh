#!/usr/bin/env bash
# Get the latest Flowdeck code from GitHub and restart the app. Keeps the database and settings.
#   sudo bash /opt/flowdeck/src/deploy/update.sh
set -euo pipefail

main() {
  if [ "$(id -u)" != 0 ]; then echo "Run it with sudo:  sudo bash $0"; exit 1; fi
  local src=/opt/flowdeck/src branch="${FLOWDECK_BRANCH:-main}" before after
  before=$(git -C "$src" rev-parse --short HEAD)
  git -C "$src" fetch -q --depth 1 origin "$branch"
  git -C "$src" reset -q --hard FETCH_HEAD
  after=$(git -C "$src" rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then echo "Already up to date ($after)."; else echo "Updated $before -> $after: $(git -C "$src" log -1 --format=%s)"; fi
  /opt/flowdeck/venv/bin/pip install -q --disable-pip-version-check -r "$src/backend/requirements.txt"
  /opt/flowdeck/venv/bin/python -m compileall -q "$src/backend/app" >/dev/null || true
  chown -R root:root /opt/flowdeck
  # pick up changes to the service or Caddy config too
  install -m 644 "$src/deploy/flowdeck.service" /etc/systemd/system/flowdeck.service
  systemctl daemon-reload
  if [ -f /etc/flowdeck/domain ]; then
    sed "s/__DOMAIN__/$(cat /etc/flowdeck/domain)/g" "$src/deploy/Caddyfile" > /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
  systemctl restart flowdeck
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null http://127.0.0.1:8000/login; then echo "App restarted and answering."; exit 0; fi
    sleep 1
  done
  echo "The app didn't come back. Last log lines:"; journalctl -u flowdeck -n 40 --no-pager; exit 1
}

main "$@"
