// spark-mini-tui.ts
// Run: npm i -g zx && npm i yoctocolors log-update string-width wrap-ansi
// Then: npx tsx spark-mini-tui.ts
import { $ } from "zx";
import fs from "node:fs/promises";
import process from "node:process";
import logUpdate from "log-update";
import stringWidth from "string-width";
import { bold, dim, cyan, magenta, green, yellow } from "yoctocolors";
import stripAnsi from "strip-ansi";

$.quiet = true;

const INTERVAL = Number(process.env.INTERVAL_MS || 1000);
const ONCE_MODE = process.argv.includes("--once");

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

// ---------- helpers ----------
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
      // Format: gpu pid type sm mem enc dec jpg ofa fb ccpm command
      if (cols.length < 12) continue;
      const [gpu, pid, type, sm, mem, enc, dec, jpg, ofa, fb, ccpm, ...cmdParts] = cols;
      if (!/^\d+$/.test(gpu) || !/^\d+$/.test(pid)) continue;
      rows.push({
        gpu,
        pid,
        type,
        sm,
        mem,
        enc,
        dec,
        jpg,
        ofa,
        fb,
        ccpm,
        cmd: cmdParts.join(" "),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

const toGB = (kb?: number): string => {
  const gb = (kb || 0) / 1024 / 1024;
  return `${gb.toFixed(2)} GB`;
};

function pad(s: string, w: number): string {
  const sw = stringWidth(s);
  return sw >= w ? s : s + " ".repeat(w - sw);
}

function line(w: number): string {
  return "─".repeat(Math.max(0, w));
}

function box(title: string, lines: string[], width: number): string {
  // Ensure width doesn't exceed terminal
  const safeWidth = Math.min(width, 78);
  const contentWidth = safeWidth - 4; // Space for "│ " + content + " │"
  
  // Top border
  const titleLen = stripAnsi(title).length;
  const borderLen = Math.max(0, safeWidth - 4 - titleLen);
  const top = `┌ ${title} ${"─".repeat(borderLen)}┐`;
  
  // Body lines
  const body = lines
    .map((l) => {
      const stripped = stripAnsi(l);
      let content = l;
      
      // Truncate if needed
      if (stripped.length > contentWidth) {
        // Find where to cut, accounting for ANSI codes
        let visibleCount = 0;
        let cutIndex = 0;
        for (let i = 0; i < l.length; i++) {
          if (l[i] === '\x1b') {
            // Skip ANSI escape sequence
            while (i < l.length && l[i] !== 'm') i++;
            continue;
          }
          visibleCount++;
          if (visibleCount >= contentWidth - 1) {
            cutIndex = i + 1;
            break;
          }
        }
        content = l.substring(0, cutIndex) + "…";
      }
      
      // Pad to exact width
      const currentWidth = stripAnsi(content).length;
      const padding = " ".repeat(Math.max(0, contentWidth - currentWidth));
      return `│ ${content}${padding} │`;
    })
    .join("\n");
  
  // Bottom border
  const bot = `└${"─".repeat(safeWidth - 2)}┘`;
  
  return [top, body, bot].join("\n");
}

// ---------- render ----------
async function render(): Promise<void> {
  const cols = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 40;
  const boxWidth = cols;

  const [m, g, procs] = await Promise.all([meminfo(), gpuTotals(), pmon()]);
  const used = m.total - m.avail;

  const memBox = box(
    cyan("Memory"),
    [
      `${bold("Total:")} ${toGB(m.total)}`,
      `${bold("Available:")} ${toGB(m.avail)}`,
      `${bold("Used:")} ${toGB(used)}`,
      `${bold("Free:")} ${toGB(m.free)}`,
      `${bold("Cached:")} ${toGB(m.cached)}`,
      `${bold("Swap Free:")} ${toGB(m.swapFree)}`,
    ],
    boxWidth
  );

  const gLines =
    g.length > 0
      ? g.map(
          (x, i) =>
            `GPU${i} ${x.name}  util ${green(`${x.util}%`)}  temp ${yellow(
              `${x.temp}C`
            )}  smclk ${x.clk}MHz`
        )
      : ["nvidia-smi not available"];
  const gpuBox = box(magenta("GPU Totals"), gLines, boxWidth);

  const header = "GPU  PID      T  SM%  MEM%  ENC  DEC  JPG  OFA  FB    CCPM  CMD";
  const maxCmd = Math.max(10, boxWidth - 64);
  const procLines = [bold(header)].concat(
    procs.slice(0, Math.max(1, rows - 16)).map((r) => {
      const cmd =
        r.cmd.length > maxCmd ? r.cmd.slice(0, maxCmd - 1) + "…" : r.cmd;
      
      // Format values: replace "-" with "·" and add "MB" suffix to FB/CCPM
      const formatVal = (v: string) => v === "-" ? "·" : v;
      const formatMB = (v: string) => {
        if (v === "-") return "·";
        const num = Number(v);
        if (isNaN(num)) return v;
        if (num >= 1024) return `${(num / 1024).toFixed(1)}G`;
        return `${num}M`;
      };
      
      return `${pad(r.gpu, 3)}  ${pad(String(r.pid), 7)}  ${pad(
        r.type,
        1
      )}  ${pad(formatVal(r.sm), 3)}  ${pad(formatVal(r.mem), 4)}  ${pad(
        formatVal(r.enc),
        3
      )}  ${pad(formatVal(r.dec), 3)}  ${pad(formatVal(r.jpg), 3)}  ${pad(
        formatVal(r.ofa),
        3
      )}  ${pad(formatMB(r.fb), 4)}  ${pad(formatMB(r.ccpm), 4)}  ${cmd}`;
    })
  );
  const procBox = box(cyan("nvidia-smi pmon (per-process)"), procLines, boxWidth);

  const legendLines = [
    dim("Legend:"),
    dim("  T    - Type - Process type (C=Compute/ML, G=Graphics/Display)"),
    dim("  SM   - Streaming Multiprocessor - GPU compute core utilization %"),
    dim("  MEM  - Memory - GPU memory controller utilization %"),
    dim("  ENC  - Encoder - Video encoding engine utilization %"),
    dim("  DEC  - Decoder - Video decoding engine utilization %"),
    dim("  JPG  - JPEG - JPEG decoder engine utilization %"),
    dim("  OFA  - Optical Flow - Optical flow accelerator utilization %"),
    dim("  FB   - Frame Buffer - GPU memory usage in MB"),
    dim("  CCPM - Confidential Compute - Protected memory usage in MB"),
  ].join("\n");

  const debug = dim(
    `Debug: terminal=${cols}x${rows} | boxWidth=${boxWidth} | maxCmd=${maxCmd}`
  );

  logUpdate(
    [
      memBox,
      "",
      gpuBox,
      "",
      procBox,
      "",
      legendLines,
      "",
      debug,
      dim(`q / Ctrl+C to quit  ·  ${new Date().toLocaleTimeString()}`),
    ].join("\n")
  );
}

// ---------- run ----------

function setupKeys() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.on("data", (b: Buffer) => {
    const k = b.toString();
    if (k === "q" || k === "\u0003") {
      process.exit(0);
    }
  });
}

async function main(): Promise<void> {
  if (ONCE_MODE) {
    await render();
    logUpdate.done();
    process.exit(0);
  }
  
  setupKeys();
  await render();
  setInterval(() => {
    void render();
  }, INTERVAL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

