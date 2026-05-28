// spark_monitoring_procmem.ts
// Run: npx tsx spark_monitoring_procmem.ts [--once] [--json] [--interval=<ms>] [--log-dir=<path>]
//
//   (no flags)          live TUI, loops every --interval ms (default 10000)
//   --once              single TUI snapshot, exit
//   --json              NDJSON to stdout, one line per interval — pipe/redirect to file
//   --json --once       single JSON snapshot, exit — good for | jq
//   --json --log-dir=X  NDJSON to X/spark-stats-YYYYMMDD.jsonl, rotated daily at UTC midnight
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
const FLAG_ONCE = Boolean(argv.once);
const FLAG_JSON = Boolean(argv.json);
const INTERVAL  = Number(argv.interval) || 10000;
const LOG_DIR   = typeof argv["log-dir"] === "string" ? argv["log-dir"] : undefined;

// ---------- types ----------
type MemInfo = {
  total: number;
  avail: number;
  free: number;
  cached: number;
  swapFree: number;
};

type GpuTotal = { name: string; util: number; temp: number; clk: number };

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
      await $`nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,clocks.sm --format=csv,noheader,nounits`
    ).stdout.trim();
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [name, util, temp, clk] = line.split(",").map((s) => s.trim());
      return {
        name,
        util: Number(util) || 0,
        temp: Number(temp) || 0,
        clk: Number(clk) || 0,
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

function pad(s: string, w: number): string {
  const sw = stringWidth(s);
  return sw >= w ? s : s + " ".repeat(w - sw);
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
      ? g.map((x, i) => `GPU${i} ${x.name}  util ${green(`${x.util}%`)}  temp ${yellow(`${x.temp}C`)}  smclk ${x.clk}MHz`)
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

async function renderJson(): Promise<void> {
  const [m, g, procs] = await Promise.all([meminfo(), gpuTotals(), pmon()]);
  const used = m.total - m.avail;
  const ts = new Date();
  const line = JSON.stringify({
    ts: ts.toISOString(),
    mem: {
      totalGb: +((m.total / 1024 / 1024).toFixed(2)),
      usedGb:  +((used    / 1024 / 1024).toFixed(2)),
      availGb: +((m.avail / 1024 / 1024).toFixed(2)),
      swapFreeGb: +((m.swapFree / 1024 / 1024).toFixed(2)),
    },
    gpu: g.map((x, i) => ({ id: i, name: x.name, utilPct: x.util, tempC: x.temp, smClkMhz: x.clk })),
    procs: procs.map((r) => ({ gpu: r.gpu, pid: r.pid, type: r.type, sm: r.sm, mem: r.mem, fbMb: r.fb, cmd: r.cmd })),
  }) + "\n";
  writeLine(line, ts);
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
  if (FLAG_JSON) {
    await renderJson();
    if (FLAG_ONCE) process.exit(0);
    // Sequential loop: render → sleep → render. Each sample completes before the next starts.
    while (true) {
      await sleep(INTERVAL);
      await renderJson();
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
