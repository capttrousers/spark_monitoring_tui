#!/usr/bin/env bash
set -e

# Removes the spark-monitoring systemd service. Safe to run if not installed.

SERVICE_NAME="spark-monitoring"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Uninstalling ${SERVICE_NAME}..."

sudo systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
sudo systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
sudo rm -f "$SERVICE_DST"
sudo systemctl daemon-reload

echo "Removed $SERVICE_DST"
echo "Note: log files in ~/vllm-logs/ are preserved. Delete manually if desired."
