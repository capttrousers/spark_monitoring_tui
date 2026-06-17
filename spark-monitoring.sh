#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: spark-monitoring [options]

Runs the Spark host stats collector and streams sparkrun_ vLLM logs.

Options:
  --json-log-dir=DIR             Write daily JSONL stats to DIR/spark-stats-YYYYMMDD.jsonl
                                 Defaults to ~/vllm-logs.
  --prom-node-exporter-dir=DIR   Atomically write DIR/spark_gpu.prom for node_exporter.
  --interval=MS                  Stats polling interval. Defaults to 5000.
  -h, --help                     Show this help.

This command expects local npm dependencies to be installed in the repo.
Run: cd ~/spark_monitoring_tui && npm install
USAGE
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
JSON_LOG_DIR="$HOME/vllm-logs"
PROM_NODE_EXPORTER_DIR=""
INTERVAL_MS="5000"
METRICS_ACCESS_LOG_RE='GET /metrics HTTP.*200 OK'

for arg in "$@"; do
  case "$arg" in
    --json-log-dir=*)
      JSON_LOG_DIR="${arg#*=}"
      ;;
    --prom-node-exporter-dir=*)
      PROM_NODE_EXPORTER_DIR="${arg#*=}"
      ;;
    --interval=*)
      INTERVAL_MS="${arg#*=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$JSON_LOG_DIR"

if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # The Spark host installs Node via nvm, and systemd does not load shell profiles.
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
fi

TSX_BIN="$REPO_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "Missing $TSX_BIN. Run: cd $REPO_DIR && npm install" >&2
  exit 1
fi

STATS_ARGS=(
  --json-log-dir="$JSON_LOG_DIR"
  --interval="$INTERVAL_MS"
)

if [ -n "$PROM_NODE_EXPORTER_DIR" ]; then
  STATS_ARGS+=(--prom-node-exporter-dir="$PROM_NODE_EXPORTER_DIR")
fi

echo "Starting stats collector..."
"$TSX_BIN" "$REPO_DIR/spark_monitoring_procmem.ts" "${STATS_ARGS[@]}" &
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
  local logfile="$JSON_LOG_DIR/vllm-$(date +%Y%m%d-%H%M%S)-${safe_container}.log"

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
