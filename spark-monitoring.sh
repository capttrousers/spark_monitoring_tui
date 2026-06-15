#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="$HOME/vllm-logs"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
METRICS_ACCESS_LOG_RE='GET /metrics HTTP.*200 OK'

mkdir -p "$LOG_DIR"
source ~/.nvm/nvm.sh

# Always-on stats collector. Writes to $LOG_DIR/spark-stats-YYYYMMDD.jsonl (daily rotate).
echo "Starting stats collector..."
npx --prefix "$REPO_DIR" tsx "$REPO_DIR/spark_monitoring_procmem.ts" \
  --json --interval=5000 --log-dir="$LOG_DIR" &
STATS_PID=$!

declare -A STREAM_PIDS=()

cleanup() {
  kill "$STATS_PID" 2>/dev/null || true
  if ((${#STREAM_PIDS[@]})); then
    for pid in "${STREAM_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
}
trap cleanup EXIT INT TERM

sanitize_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

stream_container_logs() {
  local container="$1"
  local safe_container
  safe_container=$(sanitize_name "$container")
  local logfile="$LOG_DIR/vllm-$(date +%Y%m%d-%H%M%S)-${safe_container}.log"

  echo "Found container: $container -> $logfile"
  docker exec "$container" tail -F /tmp/sparkrun_serve.log 2>&1 \
    | grep --line-buffered -vE "$METRICS_ACCESS_LOG_RE" \
    >> "$logfile" || true
  echo "vLLM stream ended for $container."
}

echo "Stats collector PID: $STATS_PID. Polling for sparkrun containers..."

while true; do
  if ((${#STREAM_PIDS[@]})); then
    for container in "${!STREAM_PIDS[@]}"; do
      if ! kill -0 "${STREAM_PIDS[$container]}" 2>/dev/null; then
        unset 'STREAM_PIDS[$container]'
      fi
    done
  fi

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    if [ -n "${STREAM_PIDS[$container]:-}" ] && kill -0 "${STREAM_PIDS[$container]}" 2>/dev/null; then
      continue
    fi
    stream_container_logs "$container" &
    STREAM_PIDS[$container]=$!
  done < <(docker ps --format '{{.Names}}' | grep '^sparkrun_' || true)

  sleep 5
done
