#!/usr/bin/env bash
set -e

LOG_DIR="$HOME/vllm-logs"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$LOG_DIR"

source ~/.nvm/nvm.sh

echo "vLLM log streamer started. Polling for sparkrun container..."

while true; do
  CONTAINER=$(docker ps --format '{{.Names}}' | grep sparkrun | head -1)

  if [ -n "$CONTAINER" ]; then
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    LOGFILE="$LOG_DIR/vllm-$TIMESTAMP.log"
    STATSFILE="$LOG_DIR/spark-stats-$TIMESTAMP.jsonl"

    echo "Found container: $CONTAINER"
    echo "  vLLM log  -> $LOGFILE"
    echo "  GPU stats -> $STATSFILE"

    # Start GPU/memory stats poller in background (every 10s)
    npx --prefix "$REPO_DIR" tsx "$REPO_DIR/spark_monitoring_procmem.ts" --json --interval=10000 >> "$STATSFILE" 2>&1 &
    MONITOR_PID=$!

    # Stream vLLM logs (blocks until container dies or stream ends)
    docker exec "$CONTAINER" tail -F /tmp/sparkrun_serve.log >> "$LOGFILE" 2>&1 || true

    # Stop stats poller when vLLM stream ends
    kill $MONITOR_PID 2>/dev/null || true
    echo "Stream ended for $CONTAINER. Re-polling..."
  fi

  sleep 5
done
