/**
 * Opt-in power-mode control (ADR 0004). Linux only: power-profiles-daemon is
 * preferred because it is the session's authority over the kernel
 * platform_profile (and stays in sync with firmware hotkeys such as Fn+Q);
 * a directly writable platform_profile is the fallback. On most laptops the
 * platform profile also selects the firmware fan curve.
 */
import type { MachineFan, PowerModeBackend, PowerModeState } from "@burn/sync-api";
import { spawn } from "node:child_process";
import { access, constants, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { platform } from "node:os";

export class ControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

/** Spawn without a shell; stderr is folded into the rejection for diagnosis. */
export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: { ...process.env, LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`));
    });
  });

interface BackendReading {
  mode: string | null;
  modes: string[];
  degraded: string | null;
}

export interface PowerModeDriver {
  backend: PowerModeBackend;
  read(): Promise<BackendReading>;
  set(mode: string): Promise<void>;
}

/** `powerprofilesctl list`: `* balanced:` marks the active profile; indented
 * `Degraded:` lines carry the reason performance is held back. */
export function parseProfilesList(output: string): BackendReading {
  const modes: string[] = [];
  let mode: string | null = null;
  let degraded: string | null = null;
  let current: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const header = /^(\*?)\s*([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header) {
      current = header[2]!;
      modes.push(current);
      if (header[1] === "*") mode = current;
      continue;
    }
    const reason = /^\s+Degraded:\s*(.+?)\s*$/.exec(line);
    if (reason && current !== null && reason[1] !== "no") degraded = reason[1]!;
  }
  // Present coolest → hottest regardless of the daemon's listing order.
  return { mode, modes: sortModes(modes), degraded };
}

/** Kernel and power-profiles-daemon vocabularies, ordered by heat. */
const MODE_ORDER = [
  "cool",
  "quiet",
  "low-power",
  "power-saver",
  "balanced",
  "balanced-performance",
  "performance",
  "max-power",
];

export function sortModes(modes: readonly string[]): string[] {
  const rank = (mode: string) => {
    const index = MODE_ORDER.indexOf(mode);
    return index === -1 ? MODE_ORDER.length : index;
  };
  return [...new Set(modes)].sort((a, b) => rank(a) - rank(b));
}

function deniedMessage(err: unknown): string | null {
  const text = (err as Error).message ?? String(err);
  if (!/AccessDenied|NotAuthorized|not authorized|Permission denied|EACCES|EPERM/i.test(text)) return null;
  return "Refused: nobody is signed in on this machine. To allow changes while signed out, run `burn-report controls polkit-rule` on it once.";
}

export function powerProfilesDaemon(run: CommandRunner = runCommand): PowerModeDriver {
  return {
    backend: "power-profiles-daemon",
    read: async () => parseProfilesList(await run("powerprofilesctl", ["list"], 5_000)),
    set: async (mode) => {
      try {
        await run("powerprofilesctl", ["set", mode], 8_000);
      } catch (err) {
        const denied = deniedMessage(err);
        throw denied ? new ControlError(denied, 403) : err;
      }
    },
  };
}

/** Direct kernel interface. `custom` needs vendor tuning first, so it is
 * never offered as a target. */
export function platformProfile(root = "/sys"): PowerModeDriver {
  const file = `${root}/firmware/acpi/platform_profile`;
  return {
    backend: "platform-profile",
    read: async () => {
      const [mode, choices] = await Promise.all([
        readFile(file, "utf8"),
        readFile(`${file}_choices`, "utf8"),
      ]);
      return {
        mode: mode.trim() || null,
        modes: sortModes(choices.trim().split(/\s+/).filter((choice) => choice && choice !== "custom")),
        degraded: null,
      };
    },
    set: async (mode) => {
      try {
        await writeFile(file, mode);
      } catch (err) {
        const denied = deniedMessage(err);
        throw denied
          ? new ControlError(
              "Refused: this machine needs power-profiles-daemon running to change modes.",
              403,
            )
          : err;
      }
    },
  };
}

/** First driver that answers wins; null when this machine has no power modes. */
export async function detectPowerModeDriver(
  options: { run?: CommandRunner; root?: string; os?: string } = {},
): Promise<PowerModeDriver | null> {
  if ((options.os ?? platform()) !== "linux") return null;
  const ppd = powerProfilesDaemon(options.run);
  try {
    if ((await ppd.read()).modes.length > 0) return ppd;
  } catch {
    // Not installed or not running; fall through to the kernel file.
  }
  const sysfs = platformProfile(options.root);
  try {
    await access(`${options.root ?? "/sys"}/firmware/acpi/platform_profile`, constants.R_OK);
    if ((await sysfs.read()).modes.length > 0) return sysfs;
  } catch {
    // No platform profile support.
  }
  return null;
}

async function text(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

interface HwmonFans {
  fans: { index: number; label: string | null; rpm: number; maxRpm: number | null }[];
}

/**
 * Fan tachometers from hwmon. Some laptops expose the same fans through two
 * drivers (e.g. Lenovo `yogafan` and `lenovo_wmi_other`); when two chips
 * report the same number of fans, the one that also reports rated maxima —
 * or failing that, any non-zero speed — is kept. Two genuinely different
 * chips with equal fan counts would also collapse; fans are informational.
 */
export async function readFans(root = "/sys"): Promise<MachineFan[]> {
  let entries: string[];
  try {
    entries = (await readdir(`${root}/class/hwmon`)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  } catch {
    return [];
  }
  const chips: HwmonFans[] = [];
  for (const entry of entries) {
    let dir = `${root}/class/hwmon/${entry}`;
    try {
      dir = await realpath(dir);
    } catch {
      // Reading through the link still works on ordinary sysfs mounts.
    }
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const fans: HwmonFans["fans"] = [];
    for (const file of files) {
      const match = /^fan(\d+)_input$/.exec(file);
      if (!match) continue;
      // An unreadable or empty tachometer is skipped, not shown as stopped.
      const raw = await text(`${dir}/${file}`);
      const rpm = raw ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(rpm) || rpm < 0 || rpm > 50_000) continue;
      const max = Number(await text(`${dir}/fan${match[1]}_max`));
      fans.push({
        index: Number(match[1]),
        label: (await text(`${dir}/fan${match[1]}_label`)) || null,
        rpm,
        maxRpm: Number.isSafeInteger(max) && max > 0 && max <= 50_000 ? max : null,
      });
    }
    if (fans.length > 0) chips.push({ fans: fans.sort((a, b) => a.index - b.index) });
  }
  const score = (chip: HwmonFans) =>
    chip.fans.filter((fan) => fan.maxRpm !== null).length * 2 + chip.fans.filter((fan) => fan.rpm > 0).length;
  // One chip per fan count; ties keep the first. Map order is first-seen.
  const byCount = new Map<number, HwmonFans>();
  for (const chip of chips) {
    const best = byCount.get(chip.fans.length);
    if (best === undefined || score(chip) > score(best)) byCount.set(chip.fans.length, chip);
  }
  let n = 0;
  return [...byCount.values()].flatMap((chip) =>
    chip.fans.map((fan) => ({ label: fan.label ?? `Fan ${++n}`, rpm: fan.rpm, maxRpm: fan.maxRpm })),
  );
}

export interface PowerModeControllerDeps {
  detect?: () => Promise<PowerModeDriver | null>;
  fans?: () => Promise<MachineFan[]>;
  now?: () => number;
  /** Delay between read-backs while a change settles. */
  sleep?: (ms: number) => Promise<void>;
}

/** Shared state reads (≤1 s old) and one serialized write at a time. */
export class PowerModeController {
  private driver: Promise<PowerModeDriver | null> | null = null;
  private missingSince: number | null = null;
  private cached: { at: number; state: Promise<PowerModeState> } | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PowerModeControllerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private resolveDriver(): Promise<PowerModeDriver | null> {
    // A daemon that was not up yet at boot is retried, at most once a minute.
    if (this.driver === null || (this.missingSince !== null && this.now() - this.missingSince >= 60_000)) {
      this.missingSince = null;
      const detecting = (this.deps.detect ?? detectPowerModeDriver)().catch(() => null);
      this.driver = detecting;
      void detecting.then((driver) => {
        if (driver === null && this.driver === detecting) this.missingSince = this.now();
      });
    }
    return this.driver;
  }

  async supported(): Promise<boolean> {
    return (await this.resolveDriver()) !== null;
  }

  private async fresh(): Promise<PowerModeState> {
    const resolving = this.resolveDriver();
    const driver = await resolving;
    if (driver === null) throw new ControlError("this machine exposes no power modes", 404);
    const [reading, fans] = await Promise.all([
      driver.read().catch((err: unknown) => {
        // The backend went away (e.g. the daemon stopped): detect again on the
        // next read, so a fallback is found or the control stops advertising.
        if (this.driver === resolving) this.driver = null;
        throw err;
      }),
      (this.deps.fans ?? readFans)().catch(() => []),
    ]);
    if (reading.modes.length === 0) throw new ControlError("this machine exposes no power modes", 404);
    return {
      generatedAt: new Date(this.now()).toISOString(),
      backend: driver.backend,
      mode: reading.mode,
      modes: reading.modes.slice(0, 8),
      degraded: reading.degraded,
      fans: fans.slice(0, 16),
    };
  }

  state(): Promise<PowerModeState> {
    if (this.cached && this.now() - this.cached.at < 1_000) return this.cached.state;
    const state = this.fresh();
    const entry = { at: this.now(), state };
    this.cached = entry;
    state.catch(() => {
      if (this.cached === entry) this.cached = null;
    });
    return state;
  }

  set(mode: string): Promise<PowerModeState> {
    const run = async (): Promise<PowerModeState> => {
      this.cached = null;
      const before = await this.state();
      if (!before.modes.includes(mode))
        throw new ControlError(`"${mode}" is not one of this machine's modes`, 409);
      const driver = (await this.resolveDriver())!;
      if (before.mode !== mode) await driver.set(mode);
      // The daemon applies changes asynchronously; confirm before answering.
      for (let attempt = 0; ; attempt++) {
        this.cached = null;
        const after = await this.state();
        if (after.mode === mode) return after;
        if (attempt >= 6)
          throw new ControlError(`the machine stayed on "${after.mode ?? "unknown"}"`, 502);
        await this.sleep(150);
      }
    };
    const result = this.writing.then(run, run);
    this.writing = result.catch(() => {});
    return result;
  }
}
