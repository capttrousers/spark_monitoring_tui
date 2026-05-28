# spark_monitoring_tui

Live monitoring TUI and vLLM log persistence for NVIDIA DGX Spark.

## Scripts

**`spark_monitoring_procmem.ts`** — terminal dashboard + JSON logger for system RAM and GPU stats.

```bash
npx tsx spark_monitoring_procmem.ts                    # live TUI
npx tsx spark_monitoring_procmem.ts --once             # single TUI snapshot, exit
npx tsx spark_monitoring_procmem.ts --json             # NDJSON stream → redirect to file
npx tsx spark_monitoring_procmem.ts --json --once      # single JSON snapshot → | jq
npx tsx spark_monitoring_procmem.ts --json --interval=5000  # 5s polling
```

**`spark-monitoring.sh`** — polls for a running sparkrun container, then streams:
- `~/vllm-logs/vllm-<timestamp>.log` — vLLM server output
- `~/vllm-logs/spark-stats-<timestamp>.jsonl` — GPU/memory stats every 10s

Both files are timestamped at container start and survive container removal.

## Setup on DGX Spark

### 1. Clone and install deps

```bash
git clone git@github.com:capttrousers/spark_monitoring_tui.git ~/spark_monitoring_tui
cd ~/spark_monitoring_tui
npm install
chmod +x spark-monitoring.sh install.sh
```

### 2. Install systemd service

```bash
./install.sh
```

Run as your normal user (NOT with `sudo`). The script detects your username, substitutes
it into the service template, then calls `sudo` internally only for the systemd-install
steps. Running the whole script with `sudo` would set `User=root` in the unit file, which
is wrong.

### 3. Check it's working

```bash
ls -lh ~/vllm-logs/
```

Once a sparkrun container is running you should see both a `.log` and a `.jsonl` file appear.

## Updating

```bash
cd ~/spark_monitoring_tui && git pull && npm install
sudo systemctl restart spark-monitoring.service
```

## Uninstalling

```bash
./uninstall.sh
```

Stops, disables, and removes the systemd service. Log files in `~/vllm-logs/` are
preserved.

## Reading logs after a crash

```bash
# Last vLLM output before crash
tail -100 ~/vllm-logs/vllm-<timestamp>.log

# GPU stats around crash time
tail -20 ~/vllm-logs/spark-stats-<timestamp>.jsonl | jq .

# Search for errors across all vLLM logs
grep -i "error\|oom\|killed\|exception" ~/vllm-logs/*.log
```
