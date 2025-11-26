// spark-mini-tui.ts
// Run: npm i -g zx && npm i yoctocolors log-update string-width wrap-ansi
// Then: npx tsx spark-mini-tui.ts
import { $ } from "zx";
import fs from "node:fs/promises";
import process from "node:process";
import logUpdate from "log-update";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { bold, dim, cyan, magenta, green, yellow } from "yoctocolors";

$.quiet = true;

const INTERVAL = Number(process.env.INTERVAL_MS || 1000);

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
  sm: string;
  mem: string;
  enc: string;
  dec: string;
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
      if (cols.length < 9) continue;
      const [gpu, , pid, _type, , sm, mem, enc, dec, ...cmdParts] = cols;
      if (!/^\d+$/.test(gpu) || !/^\d+$/.test(pid)) continue;
      rows.push({
        gpu,
        pid,
        sm,
        mem,
        enc,
        dec,
        cmd: cmdParts.join(" "),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

const kb = (n?: number) => `${(n || 0).toLocaleString("en-US")} kB`;

function pad(s: string, w: number): string {
  const sw = stringWidth(s);
  return sw >= w ? s : s + " ".repeat(w - sw);
}

function line(w: number): string {
  return "─".repeat(Math.max(0, w));
}

function box(title: string, lines: string[], width: number): string {
  const top = `┌ ${title} ${line(Math.max(0, width - 4 - stringWidth(title)))}┐`;
  const body = lines
    .map((l) => {
      const wrapped = wrapAnsi(l, width - 4, { hard: true });
      const padded = pad(wrapped, width - 2);
      return `│ ${padded} │`;
    })
    .join("\n");
  const bot = `└${line(width)}┘`;
  return [top, body, bot].join("\n");
}

// ---------- render ----------
async function render(): Promise<void> {
  const cols = process.stdout.columns ?? 100;
  const rows = process.stdout.rows ?? 40;
  const half = Math.max(30, Math.floor(cols / 2) - 2);

  const [m, g, procs] = await Promise.all([meminfo(), gpuTotals(), pmon()]);
  const used = m.total - m.avail;

  const memBox = box(
    cyan("Memory"),
    [
      `${bold("Total:")} ${kb(m.total)}`,
      `${bold("Available:")} ${kb(m.avail)}`,
      `${bold("Used:")} ${kb(used)}`,
      `${bold("Free:")} ${kb(m.free)}`,
      `${bold("Cached:")} ${kb(m.cached)}`,
      `${bold("Swap Free:")} ${kb(m.swapFree)}`,
    ],
    half
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
  const gpuBox = box(magenta("GPU Totals"), gLines, half);

  const header = "GPU  PID      SM%  MEM%  ENC  DEC  CMD";
  const procWidth = Math.max(30, cols - 4);
  const maxCmd = Math.max(10, procWidth - 34);
  const procLines = [bold(header)].concat(
    procs.slice(0, Math.max(1, rows - 16)).map((r) => {
      const cmd =
        r.cmd.length > maxCmd ? r.cmd.slice(0, maxCmd - 1) + "…" : r.cmd;
      return `${pad(r.gpu, 3)}  ${pad(String(r.pid), 7)}  ${pad(
        r.sm,
        3
      )}  ${pad(r.mem, 4)}  ${pad(r.enc, 3)}  ${pad(r.dec, 3)}  ${cmd}`;
    })
  );
  const procBox = box(cyan("nvidia-smi pmon (per-process)"), procLines, procWidth);

  const memLines = memBox.split("\n");
  const gpuLines = gpuBox.split("\n");
  const topRow = memLines
    .map((l, i) => l + "  " + (gpuLines[i] || ""))
    .join("\n");

  logUpdate(
    [
      topRow,
      "",
      procBox,
      "",
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

