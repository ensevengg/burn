/**
 * Opt-in keep-awake control (ADR 0007). A hold is a child process that owns
 * the OS's sleep inhibitor and exits by itself when its time is up, so a
 * crashed or restarted daemon can never leave a machine awake indefinitely:
 *
 * - Linux: `systemd-inhibit --what=sleep:idle … sleep <seconds>`
 * - macOS: `caffeinate -i -s -t <seconds>`
 * - Windows: a hidden PowerShell that calls SetThreadExecutionState
 *   (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and sleeps.
 *
 * The display is allowed to turn off; only sleep is held off. WSL has no
 * power management of its own; its Windows reporter holds the host awake.
 */
import { KEEP_AWAKE_MAX_MINUTES, type KeepAwakeBackend, type KeepAwakeState } from "@burn/sync-api";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { ControlError, runCommand, type CommandRunner } from "./power-mode.js";

export interface AwakeHold {
  /** Resolves once sleep is actually held off. */
  ready: Promise<void>;
  /** Resolves when the hold process ends, with stderr for diagnosis. */
  exited: Promise<{ code: number | null; stderr: string }>;
  stop(): void;
}

/** What Windows' hold prints once SetThreadExecutionState has succeeded. */
const READY_MARKER = "burn-awake";

export interface KeepAwakeDriver {
  backend: KeepAwakeBackend;
  hold(seconds: number): AwakeHold;
}

export function holdArgs(backend: KeepAwakeBackend, seconds: number): [string, string[]] {
  const whole = String(Math.max(1, Math.floor(seconds)));
  switch (backend) {
    case "systemd-inhibit":
      return [
        "systemd-inhibit",
        ["--what=sleep:idle", "--who=burn", "--why=Kept awake from the burn app", "--mode=block", "sleep", whole],
      ];
    case "caffeinate":
      return ["caffeinate", ["-i", "-s", "-t", whole]];
    case "windows-execution-state":
      return [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          // The flag lives on the calling thread; Start-Sleep keeps that
          // thread (and the hold) alive, and process exit releases it.
          "$k = Add-Type -Name Power -Namespace Burn -PassThru -MemberDefinition " +
            "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'; " +
            "if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 3 }; " +
            `[Console]::Out.WriteLine('${READY_MARKER}'); [Console]::Out.Flush(); ` +
            `Start-Sleep -Seconds ${whole}`,
        ],
      ];
  }
}

/**
 * systemd-inhibit and caffeinate hold from the moment they run, so surviving a
 * short settle is proof enough. PowerShell needs seconds to start and compile
 * its P/Invoke, so Windows waits for its marker instead.
 */
const SETTLE_MS = 400;

function spawnHold(backend: KeepAwakeBackend, seconds: number): AwakeHold {
  const [command, args] = holdArgs(backend, seconds);
  const marked = backend === "windows-execution-state";
  const child = spawn(command, args, {
    shell: false,
    stdio: ["ignore", marked ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
  });
  const ready = marked
    ? new Promise<void>((resolve) => {
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          out = (out + chunk.toString()).slice(-200);
          if (out.includes(READY_MARKER)) resolve();
        });
      })
    : new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("error", (err) => resolve({ code: null, stderr: err.message }));
    child.once("close", (code) => resolve({ code, stderr: stderr.trim() }));
  });
  return {
    ready,
    exited,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The platform's backend when its tool answers; null when unsupported. */
export async function detectKeepAwakeDriver(
  options: { os?: string; osKind?: string | undefined; run?: CommandRunner } = {},
): Promise<KeepAwakeDriver | null> {
  if (options.osKind === "wsl") return null;
  const run = options.run ?? runCommand;
  const os = options.os ?? platform();
  const probe: Record<string, [KeepAwakeBackend, string, string[]]> = {
    linux: ["systemd-inhibit", "systemd-inhibit", ["--version"]],
    // caffeinate has no version flag; `-t 1` holds for one second.
    darwin: ["caffeinate", "caffeinate", ["-t", "1"]],
    win32: ["windows-execution-state", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]],
  };
  const entry = probe[os];
  if (entry === undefined) return null;
  const [backend, command, args] = entry;
  try {
    await run(command, args, 10_000);
  } catch {
    return null;
  }
  return { backend, hold: (seconds) => spawnHold(backend, seconds) };
}

export interface KeepAwakeControllerDeps {
  detect?: () => Promise<KeepAwakeDriver | null>;
  now?: () => number;
  /** How long a fresh hold may take to start before it counts as failed. */
  startTimeoutMs?: number;
  osKind?: string;
}

/** One hold at a time; writes are serialized like power mode's. */
export class KeepAwakeController {
  private driver: Promise<KeepAwakeDriver | null> | null = null;
  private current: { hold: AwakeHold; untilMs: number } | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private exitHook = false;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly deps: KeepAwakeControllerDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  private resolveDriver(): Promise<KeepAwakeDriver | null> {
    this.driver ??= (this.deps.detect ?? (() => detectKeepAwakeDriver({ osKind: this.deps.osKind })))().catch(
      () => null,
    );
    return this.driver;
  }

  async supported(): Promise<boolean> {
    return (await this.resolveDriver()) !== null;
  }

  async state(): Promise<KeepAwakeState> {
    const driver = await this.resolveDriver();
    if (driver === null) throw new ControlError("this machine cannot be kept awake", 404);
    const current = this.current;
    const active = current !== null && current.untilMs > this.now();
    return {
      generatedAt: new Date(this.now()).toISOString(),
      backend: driver.backend,
      until: active ? new Date(current.untilMs).toISOString() : null,
    };
  }

  private release(): void {
    this.current?.hold.stop();
    this.current = null;
  }

  /** Daemon shutdown: drop the hold and refuse new ones. */
  close(): void {
    this.closed = true;
    this.release();
  }

  set(minutes: number): Promise<KeepAwakeState> {
    const run = async (): Promise<KeepAwakeState> => {
      if (this.closed) throw new ControlError("the reporter is stopping", 503);
      if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > KEEP_AWAKE_MAX_MINUTES)
        throw new ControlError(`minutes must be 0–${KEEP_AWAKE_MAX_MINUTES}`, 400);
      const driver = await this.resolveDriver();
      if (driver === null) throw new ControlError("this machine cannot be kept awake", 404);
      if (minutes === 0) {
        this.release();
        return this.state();
      }
      // Start the new hold before dropping the old one, so extending never
      // leaves a gap in which the machine could fall asleep.
      const hold = driver.hold(minutes * 60);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        hold.exited,
        hold.ready.then(() => "ready" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(resolve, this.deps.startTimeoutMs ?? 15_000, "timeout");
        }),
      ]);
      clearTimeout(timer);
      if (outcome !== "ready") {
        hold.stop();
        const reason =
          outcome === "timeout"
            ? "the inhibitor did not start in time"
            : outcome.stderr || `exited ${outcome.code ?? "before starting"}`;
        throw new ControlError(`could not hold sleep off: ${reason.slice(0, 300)}`, 502);
      }
      if (this.closed) {
        hold.stop();
        throw new ControlError("the reporter is stopping", 503);
      }
      this.current?.hold.stop();
      const entry = { hold, untilMs: this.now() + minutes * 60_000 };
      this.current = entry;
      void hold.exited.then(() => {
        if (this.current === entry) this.current = null;
      });
      if (!this.exitHook) {
        this.exitHook = true;
        process.once("exit", () => this.release());
      }
      return this.state();
    };
    const result = this.writing.then(run, run);
    this.writing = result.catch(() => {});
    return result;
  }
}
