#!/usr/bin/env bash
set -e

# Run as your normal user (not sudo). The script will call sudo only for the
# systemd-installing steps. If invoked with sudo, $SUDO_USER is the real user.
TARGET_USER="${SUDO_USER:-$(whoami)}"

if [ "$TARGET_USER" = "root" ]; then
  echo "Refusing to install with User=root. Run as your normal user (script will sudo as needed)."
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="spark-monitoring"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Installing ${SERVICE_NAME} for user: $TARGET_USER"
echo "Repo dir: $REPO_DIR"

# Resolve template -> /etc/systemd/system/
sed "s/__USER__/$TARGET_USER/g" "$REPO_DIR/${SERVICE_NAME}.service" \
  | sudo tee "$SERVICE_DST" > /dev/null

echo "Wrote $SERVICE_DST"

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}.service"
sudo systemctl restart "${SERVICE_NAME}.service"
sudo systemctl status "${SERVICE_NAME}.service"
