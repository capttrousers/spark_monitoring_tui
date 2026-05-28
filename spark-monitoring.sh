#!/usr/bin/env bash
set -e

LOG_DIR="$HOME/vllm-logs"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$LOG_DIR"
source ~/.nvm/nvm.sh

# Always-on stats collector. Writes to $LOG_DIR/spark-stats-YYYYMMDD.jsonl (daily rotate).
echo "Starting stats collector..."
npx --prefix "$REPO_DIR" tsx "$REPO_DIR/spark_monitoring_procmem.ts" \
  --json --interval=5000 --log-dir="$LOG_DIR" &
STATS_PID=$!

# Clean up the stats collector if this script exits for any reason.
trap "kill $STATS_PID 2>/dev/null || true" EXIT INT TERM

echo "Stats collector PID: $STATS_PID. Polling for sparkrun container..."

while true; do
  CONTAINER=$(docker ps --format '{{.Names}}' | grep sparkrun | head -1)

  if [ -n "$CONTAINER" ]; then
    LOGFILE="$LOG_DIR/vllm-$(date +%Y%m%d-%H%M%S).log"
    echo "Found container: $CONTAINER -> $LOGFILE"

    # Block on vLLM log stream until container dies.
    docker exec "$CONTAINER" tail -F /tmp/sparkrun_serve.log >> "$LOGFILE" 2>&1 || true

    echo "vLLM stream ended for $CONTAINER. Re-polling..."
  fi

  sleep 5
done
