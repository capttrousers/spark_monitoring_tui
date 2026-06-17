# spark_monitoring_tui

Live monitoring TUI, Prometheus textfile output, and vLLM log persistence for NVIDIA DGX Spark.

## Scripts

**`spark_monitoring_procmem.ts`** — terminal dashboard, JSON logger, and Prometheus textfile writer for system RAM and GPU stats.

```bash
npx tsx spark_monitoring_procmem.ts                          # live TUI
npx tsx spark_monitoring_procmem.ts --once                   # single TUI snapshot, exit
npx tsx spark_monitoring_procmem.ts --json                   # NDJSON to stdout
npx tsx spark_monitoring_procmem.ts --json --once            # single JSON snapshot → | jq
npx tsx spark_monitoring_procmem.ts --json --log-dir=DIR     # NDJSON to DIR/spark-stats-YYYYMMDD.jsonl (daily rotate)
npx tsx spark_monitoring_procmem.ts --json-log-dir=DIR       # same as above, implies --json
npx tsx spark_monitoring_procmem.ts --prom-node-exporter-dir=DIR  # atomically writes DIR/spark_gpu.prom
npx tsx spark_monitoring_procmem.ts --json --interval=5000   # 5s polling (default 10s)
```

**`spark-monitoring.sh`** — runs the stats collector continuously and streams vLLM logs whenever a sparkrun container is up:
- `~/vllm-logs/spark-stats-YYYYMMDD.jsonl` — system stats every 5s, always on, daily-rotated
- `~/vllm-logs/vllm-<timestamp>-<container>.log` — vLLM server output, one file per SparkRun container session
- `/var/lib/node_exporter/textfile_collector/spark_gpu.prom` — optional Prometheus textfile for node_exporter

The vLLM log streamer starts one stream per running `sparkrun_` container and filters successful Prometheus `/metrics` access lines to avoid unbounded scrape noise. Both log families survive container removal and crashes.

## Setup on DGX Spark

### 1. Clone

```bash
git clone git@github.com:capttrousers/spark_monitoring_tui.git ~/spark_monitoring_tui
cd ~/spark_monitoring_tui
```

### 2. Install local dependencies

```bash
npm install
```

Run as your normal user. This installs the local runtime dependency used by the root CLI:

```bash
~/spark_monitoring_tui/node_modules/.bin/tsx
```

Systemd installation is owned by the Ansible monitoring repo, not this repo.

### 3. Check it's working

```bash
ls -lh ~/vllm-logs/
```

You should immediately see a `spark-stats-YYYYMMDD.jsonl` file growing. The
`vllm-<timestamp>-<container>.log` only appears once a sparkrun container is running.

## Updating

```bash
cd ~/spark_monitoring_tui && git pull && npm install
```

After that, rerun the Ansible monitoring playbook that owns the systemd service.

## Reading logs after a crash

```bash
# Last vLLM output before crash
tail -100 ~/vllm-logs/vllm-<timestamp>-<container>.log

# Stats around crash time (e.g. GPU temp, throttling)
tail -20 ~/vllm-logs/spark-stats-$(date -u +%Y%m%d).jsonl | jq .

# Just temps and clocks across today
jq -c '{ts, temp: .gpu[0].tempC, clk: .gpu[0].smClkMhz}' ~/vllm-logs/spark-stats-$(date -u +%Y%m%d).jsonl

# Search for errors across all vLLM logs
grep -i "error\|oom\|killed\|exception" ~/vllm-logs/*.log
```
