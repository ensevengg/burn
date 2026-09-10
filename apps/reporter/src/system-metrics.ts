import type { IngestMachineMetricInput } from "@burn/sync-api";
import { cpus, freemem, platform, totalmem } from "node:os";
import { readdir, readFile, realpath } from "node:fs/promises";
import { spawnRunner } from "./tokscale.js";

const HOUR_MS = 60 * 60_000;

interface CpuTick {
  idle: number;
  total: number;
}

function cpuTick(): CpuTick {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function cpuLoadPct(waitMs = 120): Promise<number> {
  const before = cpuTick();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const after = cpuTick();
  const elapsed = after.total - before.total;
  return elapsed <= 0 ? 0 : Math.min(100, Math.max(0, (1 - (after.idle - before.idle) / elapsed) * 100));
}

async function text(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

async function linuxHwmonTemperatures(): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  let entries;
  try {
    entries = await readdir("/sys/class/hwmon", { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const link = `/sys/class/hwmon/${entry.name}`;
    let root = link;
    try {
      root = await realpath(link);
    } catch {
      // Reading through the symlink still works on ordinary sysfs mounts.
    }
    const name = (await text(`${root}/name`))?.toLowerCase() ?? "unknown";
    let sensors;
    try {
      sensors = await readdir(root);
    } catch {
      continue;
    }
    for (const file of sensors.filter((value) => /^temp\d+_input$/.test(value))) {
      const raw = Number(await text(`${root}/${file}`));
      const value = raw / 1000;
      if (!Number.isFinite(value) || value < -50 || value > 200) continue;
      const values = found.get(name) ?? [];
      values.push(value);
      found.set(name, values);
    }
  }
  return found;
}

function hottest(map: Map<string, number[]>, names: RegExp): number | null {
  const values = [...map.entries()].flatMap(([name, readings]) => names.test(name) ? readings : []);
  return values.length === 0 ? null : Math.max(...values);
}

async function nvidiaGpu(): Promise<{ utilization: number; temperature: number | null } | null> {
  const command = platform() === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  try {
    const { stdout } = await spawnRunner(
      { command, prefix: [] },
      ["--query-gpu=utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
      2_000,
    );
    const rows = stdout.trim().split(/\r?\n/).map((row) => row.split(",").map((part) => Number(part.trim())));
    const valid = rows.filter((row) => Number.isFinite(row[0]));
    if (valid.length === 0) return null;
    return {
      utilization: Math.max(...valid.map((row) => Math.min(100, Math.max(0, row[0]!)))),
      temperature: valid.some((row) => Number.isFinite(row[1]))
        ? Math.max(...valid.flatMap((row) => Number.isFinite(row[1]) ? [row[1]!] : []))
        : null,
    };
  } catch {
    return null;
  }
}

async function linuxGpuBusy(): Promise<number | null> {
  let cards;
  try {
    cards = await readdir("/sys/class/drm", { withFileTypes: true });
  } catch {
    return null;
  }
  const values: number[] = [];
  for (const card of cards.filter((entry) => /^card\d+$/.test(entry.name))) {
    const value = Number(await text(`/sys/class/drm/${card.name}/device/gpu_busy_percent`));
    if (Number.isFinite(value) && value >= 0 && value <= 100) values.push(value);
  }
  return values.length === 0 ? null : Math.max(...values);
}

export interface SystemMetricDeps {
  now?: () => number;
  cpuLoad?: () => Promise<number>;
  memory?: () => { total: number; free: number };
  hwmon?: () => Promise<Map<string, number[]>>;
  gpu?: () => Promise<{ utilization: number; temperature: number | null } | null>;
}

/** Best-effort sensors: unsupported temperatures stay null; values are never invented. */
export async function collectSystemMetric(deps: SystemMetricDeps = {}): Promise<IngestMachineMetricInput> {
  const memory = (deps.memory ?? (() => ({ total: totalmem(), free: freemem() })))();
  const [load, sensors, discreteGpu, sysfsGpuBusy] = await Promise.all([
    (deps.cpuLoad ?? cpuLoadPct)(),
    platform() === "linux" ? (deps.hwmon ?? linuxHwmonTemperatures)() : Promise.resolve(new Map<string, number[]>()),
    (deps.gpu ?? nvidiaGpu)(),
    platform() === "linux" ? linuxGpuBusy() : Promise.resolve(null),
  ]);
  const ramUsed = memory.total <= 0 ? 0 : ((memory.total - memory.free) / memory.total) * 100;
  const sysfsGpuTemp = hottest(sensors, /amdgpu|nouveau|i915/);
  return {
    capturedAtMs: (deps.now ?? Date.now)(),
    cpuLoadPct: Number(load.toFixed(1)),
    cpuTempC: hottest(sensors, /coretemp|k10temp|zenpower|cpu_thermal|acpitz/),
    ramUsedPct: Number(Math.min(100, Math.max(0, ramUsed)).toFixed(1)),
    ramTempC: hottest(sensors, /spd5118|jc42|dimm|dram|memory/),
    gpuUtilPct: discreteGpu === null
      ? sysfsGpuBusy
      : Number(discreteGpu.utilization.toFixed(1)),
    gpuTempC: discreteGpu?.temperature ?? sysfsGpuTemp,
  };
}

/** Process-local trailing history for /live/metrics; cloud remains the durable copy. */
export class SystemMetricHistory {
  private samples: IngestMachineMetricInput[] = [];
  private active: Promise<IngestMachineMetricInput> | null = null;

  constructor(
    private readonly collect: () => Promise<IngestMachineMetricInput> = collectSystemMetric,
    private readonly now: () => number = Date.now,
  ) {}

  sample(): Promise<IngestMachineMetricInput> {
    if (this.active !== null) return this.active;
    const pending = this.collect().then((sample) => {
      this.samples.push(sample);
      this.samples = this.samples.filter((item) => item.capturedAtMs >= this.now() - 24 * HOUR_MS);
      return sample;
    });
    this.active = pending;
    void pending.finally(() => {
      if (this.active === pending) this.active = null;
    }).catch(() => {});
    return pending;
  }

  async since(sinceMs: number): Promise<IngestMachineMetricInput[]> {
    await this.sample();
    return this.samples.filter((sample) => sample.capturedAtMs >= sinceMs);
  }
}
