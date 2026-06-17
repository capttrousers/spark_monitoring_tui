// spark_monitoring_procmem.ts
// Run: npx tsx spark_monitoring_procmem.ts [--once] [--json] [--interval=<ms>] [--log-dir=<path>] [--json-log-dir=<path>] [--prom-node-exporter-dir=<path>]
//
//   (no flags)          live TUI, loops every --interval ms (default 10000)
//   --once              single TUI snapshot, exit
//   --json              NDJSON to stdout, one line per interval — pipe/redirect to file
//   --json --once       single JSON snapshot, exit — good for | jq
//   --json --log-dir=X  NDJSON to X/spark-stats-YYYYMMDD.jsonl, rotated daily at UTC midnight
//   --json-log-dir=X   NDJSON to X/spark-stats-YYYYMMDD.jsonl, implies --json
//   --prom-node-exporter-dir=X  write X/spark_gpu.prom atomically for node_exporter
//   --interval=<ms>     polling interval in ms (default 10000)
import { $, argv } from "zx";
import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import logUpdate from "log-update";
import stringWidth from "string-width";
import { bold, dim, cyan, magenta, green, yellow } from "yoctocolors";
import stripAnsi from "strip-ansi";

$.quiet = true;

// ---------- flags (parsed by zx's bundled minimist) ----------
const FLAG_HELP = Boolean(argv.help) || Boolean(argv.h);
const FLAG_ONCE = Boolean(argv.once);
const INTERVAL  = Number(argv.interval) || 10000;
const JSON_LOG_DIR = typeof argv["json-log-dir"] === "string" ? argv["json-log-dir"] : undefined;
const LOG_DIR = JSON_LOG_DIR ?? (typeof argv["log-dir"] === "string" ? argv["log-dir"] : undefined);
const FLAG_JSON = Boolean(argv.json) || Boolean(JSON_LOG_DIR);
const PROM_NODE_EXPORTER_DIR = typeof argv["prom-node-exporter-dir"] === "string" ? argv["prom-node-exporter-dir"] : undefined;
const FLAG_HEADLESS = FLAG_JSON || Boolean(PROM_NODE_EXPORTER_DIR);

// ---------- types ----------
type MemInfo = {
  total: number;
  avail: number;
  free: number;
  cached: number;
  swapFree: number;
};

type GpuTotal = {
  name: string;
  util: number;
  temp: number;
  clk: number;
  memUsedMb: number;
  memTotalMb: number;
};

type PmonRow = {
  gpu: string;
  pid: string;
  type: string;
  sm: string;
  mem: string;
  enc: string;
  dec: string;
  jpg: string;
  ofa: string;
  fb: string;
  ccpm: string;
  cmd: string;
};

type Sample = {
  ts: string;
  mem: {
    totalGb: number;
    usedGb: number;
    availGb: number;
    swapFreeGb: number;
  };
  gpu: {
    id: number;
    name: string;
    utilPct: number;
    tempC: number;
    smClkMhz: number;
    memUsedMb: number;
    memTotalMb: number;
  }[];
  procs: {
    gpu: string;
    pid: string;
    type: string;
    sm: string;
    mem: string;
    fbMb: string;
    cmd: string;
  }[];
};

function usage(): string {
  return `Usage: spark_monitoring_procmem.ts [options]

Options:
  --once                         Emit one sample/frame and exit.
  --json                         Write NDJSON samples to stdout.
  --log-dir=DIR                  With --json, write daily spark-stats-YYYYMMDD.jsonl files.
  --json-log-dir=DIR             Write daily JSONL files and imply --json.
  --prom-node-exporter-dir=DIR   Atomically write DIR/spark_gpu.prom for node_exporter.
  --interval=MS                  Polling interval. Defaults to 10000.
  -h, --help                     Show this help.`;
}

// ---------- data helpers ----------
async function meminfo(): Promise<MemInfo> {
  const txt = await fs.readFile("/proc/meminfo", "utf8");
  const get = (k: string): number => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : 0;
  };
  return {
    total: get("MemTotal"),
    avail: get("MemAvailable"),
    free: get("MemFree"),
    cached: get("Buffers") + get("Cached") + get("SReclaimable"),
    swapFree: get("SwapFree"),
  };
}

async function gpuTotals(): Promise<GpuTotal[]> {
  try {
    const out = (
      await $`nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,clocks.sm,memory.used,memory.total --format=csv,noheader,nounits`
    ).stdout.trim();
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [name, util, temp, clk, memUsedMb, memTotalMb] = line.split(",").map((s) => s.trim());
      return {
        name,
        util: Number(util) || 0,
        temp: Number(temp) || 0,
        clk: Number(clk) || 0,
        memUsedMb: Number(memUsedMb) || 0,
        memTotalMb: Number(memTotalMb) || 0,
      };
    });
  } catch {
    return [];
  }
}

async function pmon(): Promise<PmonRow[]> {
  try {
    const out = (await $`nvidia-smi pmon -c 1 -s um`).stdout
      .trim()
      .split("\n")
      .filter((l: string) => l && !l.startsWith("#"));
    const rows: PmonRow[] = [];
    for (const line of out) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 12) continue;
      const [gpu, pid, type, sm, mem, enc, dec, jpg, ofa, fb, ccpm, ...cmdParts] = cols;
      if (!/^\d+$/.test(gpu) || !/^\d+$/.test(pid)) continue;
      rows.push({ gpu, pid, type, sm, mem, enc, dec, jpg, ofa, fb, ccpm, cmd: cmdParts.join(" ") });
    }
    return rows;
  } catch {
    return [];
  }
}

// ---------- TUI helpers ----------
const toGB = (kb?: number): string => `${((kb || 0) / 1024 / 1024).toFixed(2)} GB`;
const mbToBytes = (mb: number): number => mb * 1024 * 1024;

function pad(s: string, w: number): string {
  const sw = stringWidth(s);
  return sw >= w ? s : s + " ".repeat(w - sw);
}

function formatGpuMem(usedMb: number, totalMb: number): string {
  if (!totalMb) return "mem n/a";
  return `mem ${(usedMb / 1024).toFixed(1)}/${(totalMb / 1024).toFixed(1)}GiB`;
}

function box(title: string, lines: string[], width: number): string {
  const safeWidth = Math.min(width, 78);
  const contentWidth = safeWidth - 4;
  const borderLen = Math.max(0, safeWidth - 4 - stripAnsi(title).length);
  const top = `┌ ${title} ${"─".repeat(borderLen)}┐`;
  const body = lines
    .map((l) => {
      const stripped = stripAnsi(l);
      let content = l;
      if (stripped.length > contentWidth) {
        let visibleCount = 0;
        let cutIndex = 0;
        for (let i = 0; i < l.length; i++) {
          if (l[i] === "\x1b") {
            while (i < l.length && l[i] !== "m") i++;
            continue;
          }
          visibleCount++;
          if (visibleCount >= contentWidth - 1) { cutIndex = i + 1; break; }
        }
        content = l.substring(0, cutIndex) + "…";
      }
      const padding = " ".repeat(Math.max(0, contentWidth - stripAnsi(content).length));
      return `│ ${content}${padding} │`;
    })
    .join("\n");
  return [top, body, `└${"─".repeat(safeWidth - 2)}┘`].join("\n");
}

// ---------- TUI render ----------
async function render(): Promise<void> {
  const cols = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 40;
  const boxWidth = cols;

  const [m, g, procs] = await Promise.all([meminfo(), gpuTotals(), pmon()]);
  const used = m.total - m.avail;

  const memBox = box(cyan("Memory"), [
    `${bold("Total:")} ${toGB(m.total)}`,
    `${bold("Available:")} ${toGB(m.avail)}`,
    `${bold("Used:")} ${toGB(used)}`,
    `${bold("Free:")} ${toGB(m.free)}`,
    `${bold("Cached:")} ${toGB(m.cached)}`,
    `${bold("Swap Free:")} ${toGB(m.swapFree)}`,
  ], boxWidth);

  const gpuBox = box(magenta("GPU Totals"),
    g.length > 0
      ? g.map((x, i) => `GPU${i} ${x.name}  util ${green(`${x.util}%`)}  temp ${yellow(`${x.temp}C`)}  smclk ${x.clk}MHz  ${formatGpuMem(x.memUsedMb, x.memTotalMb)}`)
      : ["nvidia-smi not available"],
    boxWidth
  );

  const maxCmd = Math.max(10, boxWidth - 64);
  const formatVal = (v: string) => v === "-" ? "·" : v;
  const formatMB = (v: string) => {
    if (v === "-") return "·";
    const num = Number(v);
    if (isNaN(num)) return v;
    return num >= 1024 ? `${(num / 1024).toFixed(1)}G` : `${num}M`;
  };
  const procBox = box(cyan("nvidia-smi pmon (per-process)"), [bold("GPU  PID      T  SM%  MEM%  ENC  DEC  JPG  OFA  FB    CCPM  CMD")].concat(
    procs.slice(0, Math.max(1, rows - 16)).map((r) => {
      const cmd = r.cmd.length > maxCmd ? r.cmd.slice(0, maxCmd - 1) + "…" : r.cmd;
      return `${pad(r.gpu, 3)}  ${pad(String(r.pid), 7)}  ${pad(r.type, 1)}  ${pad(formatVal(r.sm), 3)}  ${pad(formatVal(r.mem), 4)}  ${pad(formatVal(r.enc), 3)}  ${pad(formatVal(r.dec), 3)}  ${pad(formatVal(r.jpg), 3)}  ${pad(formatVal(r.ofa), 3)}  ${pad(formatMB(r.fb), 4)}  ${pad(formatMB(r.ccpm), 4)}  ${cmd}`;
    })
  ), boxWidth);

  logUpdate([
    memBox, "",
    gpuBox, "",
    procBox, "",
    [
      dim("Legend:"),
      dim("  T    - Process type (C=Compute/ML, G=Graphics/Display)"),
      dim("  SM   - Streaming Multiprocessor utilization %"),
      dim("  MEM  - GPU memory controller utilization %"),
      dim("  FB   - Frame Buffer — GPU memory usage"),
      dim("  CCPM - Confidential Compute protected memory"),
    ].join("\n"), "",
    dim(`terminal=${cols}x${rows}  interval=${INTERVAL}ms`),
    dim(`q / Ctrl+C to quit  ·  ${new Date().toLocaleTimeString()}`),
  ].join("\n"));
}

// ---------- JSON output: stdout or daily-rotated file ----------
let currentDay = "";
let currentStream: WriteStream | null = null;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
}

function writeLine(line: string, ts: Date): void {
  if (!LOG_DIR) {
    process.stdout.write(line);
    return;
  }
  const day = utcDay(ts);
  if (day !== currentDay) {
    currentStream?.end();
    const filePath = path.join(LOG_DIR, `spark-stats-${day}.jsonl`);
    currentStream = createWriteStream(filePath, { flags: "a" });
    currentDay = day;
  }
  currentStream!.write(line);
}

async function collectSample(): Promise<Sample> {
  const [m, g, procs] = await Promise.all([meminfo(), gpuTotals(), pmon()]);
  const used = m.total - m.avail;
  const ts = new Date();
  return {
    ts: ts.toISOString(),
    mem: {
      totalGb: +((m.total / 1024 / 1024).toFixed(2)),
      usedGb:  +((used    / 1024 / 1024).toFixed(2)),
      availGb: +((m.avail / 1024 / 1024).toFixed(2)),
      swapFreeGb: +((m.swapFree / 1024 / 1024).toFixed(2)),
    },
    gpu: g.map((x, i) => ({
      id: i,
      name: x.name,
      utilPct: x.util,
      tempC: x.temp,
      smClkMhz: x.clk,
      memUsedMb: x.memUsedMb,
      memTotalMb: x.memTotalMb,
    })),
    procs: procs.map((r) => ({ gpu: r.gpu, pid: r.pid, type: r.type, sm: r.sm, mem: r.mem, fbMb: r.fb, cmd: r.cmd })),
  };
}

function promLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function promLine(name: string, labels: Record<string, string>, value: number): string {
  const labelText = Object.entries(labels)
    .map(([k, v]) => `${k}="${promLabel(v)}"`)
    .join(",");
  const metricValue = Number.isFinite(value) ? value : 0;
  return `${name}{${labelText}} ${metricValue}`;
}

function buildPrometheusText(sample: Sample): string {
  const lines: string[] = [
    "# HELP spark_gpu_temp_celsius Spark GPU temperature in Celsius.",
    "# TYPE spark_gpu_temp_celsius gauge",
    "# HELP spark_gpu_util_percent Spark GPU utilization percent.",
    "# TYPE spark_gpu_util_percent gauge",
    "# HELP spark_gpu_sm_clock_mhz Spark GPU SM clock in MHz.",
    "# TYPE spark_gpu_sm_clock_mhz gauge",
    "# HELP spark_gpu_mem_used_bytes Spark GPU memory used in bytes.",
    "# TYPE spark_gpu_mem_used_bytes gauge",
    "# HELP spark_gpu_mem_total_bytes Spark GPU memory total in bytes.",
    "# TYPE spark_gpu_mem_total_bytes gauge",
    "# HELP spark_gpu_textfile_last_success_timestamp_seconds Last successful Spark GPU textfile sample timestamp.",
    "# TYPE spark_gpu_textfile_last_success_timestamp_seconds gauge",
  ];

  for (const gpu of sample.gpu) {
    const labels = { gpu: String(gpu.id), name: gpu.name };
    lines.push(promLine("spark_gpu_temp_celsius", labels, gpu.tempC));
    lines.push(promLine("spark_gpu_util_percent", labels, gpu.utilPct));
    lines.push(promLine("spark_gpu_sm_clock_mhz", labels, gpu.smClkMhz));
    lines.push(promLine("spark_gpu_mem_used_bytes", labels, mbToBytes(gpu.memUsedMb)));
    lines.push(promLine("spark_gpu_mem_total_bytes", labels, mbToBytes(gpu.memTotalMb)));
  }

  lines.push(`spark_gpu_textfile_last_success_timestamp_seconds ${Math.floor(Date.parse(sample.ts) / 1000)}`);
  return `${lines.join("\n")}\n`;
}

async function writePrometheusText(sample: Sample): Promise<void> {
  if (!PROM_NODE_EXPORTER_DIR) return;
  await fs.mkdir(PROM_NODE_EXPORTER_DIR, { recursive: true });
  const finalPath = path.join(PROM_NODE_EXPORTER_DIR, "spark_gpu.prom");
  const tmpPath = path.join(PROM_NODE_EXPORTER_DIR, `.spark_gpu.prom.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, buildPrometheusText(sample), "utf8");
  await fs.rename(tmpPath, finalPath);
}

async function renderHeadless(): Promise<void> {
  const sample = await collectSample();
  if (FLAG_JSON) {
    writeLine(`${JSON.stringify(sample)}\n`, new Date(sample.ts));
  }
  await writePrometheusText(sample);
}

// ---------- run ----------
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function setupKeys() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.on("data", (b: Buffer) => {
    const k = b.toString();
    if (k === "q" || k === "") process.exit(0);
  });
}

async function main(): Promise<void> {
  if (FLAG_HELP) {
    console.log(usage());
    process.exit(0);
  }

  if (FLAG_HEADLESS) {
    await renderHeadless();
    if (FLAG_ONCE) process.exit(0);
    // Sequential loop: render → sleep → render. Each sample completes before the next starts.
    while (true) {
      await sleep(INTERVAL);
      await renderHeadless();
    }
  }

  if (FLAG_ONCE) {
    await render();
    logUpdate.done();
    process.exit(0);
  }

  setupKeys();
  await render();
  // Sequential loop: render → sleep → render. Each frame completes before the next starts.
  while (true) {
    await sleep(INTERVAL);
    await render();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
