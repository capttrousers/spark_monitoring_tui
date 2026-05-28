#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
USER="$(whoami)"
SERVICE_NAME="spark-monitoring"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Installing ${SERVICE_NAME} for user: $USER"
echo "Repo dir: $REPO_DIR"

# Resolve template -> /etc/systemd/system/
sed "s/__USER__/$USER/g" "$REPO_DIR/${SERVICE_NAME}.service" \
  | sudo tee "$SERVICE_DST" > /dev/null

echo "Wrote $SERVICE_DST"

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}.service"
sudo systemctl restart "${SERVICE_NAME}.service"
sudo systemctl status "${SERVICE_NAME}.service"
