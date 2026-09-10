/**
 * burn-events runner (D2 seam): resolves the exporter binary, runs it, and
 * hands the raw JSONL to events.ts for validation. Resolution order:
 * BURN_EVENTS_BIN env → PATH probe (`burn-events` / `burn-events.exe`).
 *
 * The exporter embeds tokscale-core (its crate version tracks the tokscale
 * pin, enforced by a drift-guard test), so a version mismatch means the
 * records were produced by a different parser than the pinned CLI — rejected
 * loudly rather than pushed with mixed parser provenance.
 */
import { platform } from "node:os";
import { spawnRunner, TokscaleError, type Runner } from "./tokscale.js";

export class ExporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExporterError";
  }
}

let cachedExporter: Runner | null = null;
let cachedExporterVersion: string | null = null;
let exporterVersionProbe: Promise<string | null> | null = null;
let cachedCapabilities: ExporterCapabilities | null = null;
let capabilitiesProbe: Promise<ExporterCapabilities | null> | null = null;

export interface ExporterCapabilities {
  protocol: number;
  tokscaleVersion: string;
  capabilities: string[];
}

export function parseExporterCapabilities(stdout: string): ExporterCapabilities | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof value["protocol"] !== "number" || typeof value["tokscale_version"] !== "string" || !Array.isArray(value["capabilities"]) || !value["capabilities"].every((item) => typeof item === "string")) return null;
    return { protocol: value["protocol"], tokscaleVersion: value["tokscale_version"], capabilities: value["capabilities"] as string[] };
  } catch {
    return null;
  }
}

export function assertExporterCapabilities(value: ExporterCapabilities | null, pin: string): void {
  if (value === null || value.tokscaleVersion !== pin || !value.capabilities.includes("fingerprint-v1")) {
    throw new ExporterError(`burn-events ${pin} is missing the fingerprint-v1 capability — rebuild it: cargo install --path crates/burn-events`);
  }
}

export function exporterCapabilities(): Promise<ExporterCapabilities | null> {
  if (cachedCapabilities !== null) return Promise.resolve(cachedCapabilities);
  if (capabilitiesProbe !== null) return capabilitiesProbe;
  const pending = (async () => {
    try {
      const runner = await resolveExporter();
      const { stdout } = await spawnRunner(runner, ["--capabilities"], 60_000);
      const parsed = parseExporterCapabilities(stdout);
      if (parsed !== null) cachedCapabilities = parsed;
      return parsed;
    } catch {
      return null;
    }
  })();
  capabilitiesProbe = pending;
  void pending.finally(() => { if (capabilitiesProbe === pending) capabilitiesProbe = null; });
  return pending;
}

export async function resolveExporter(): Promise<Runner> {
  if (cachedExporter !== null) return cachedExporter;
  const candidates: Runner[] = [];
  const override = process.env["BURN_EVENTS_BIN"];
  if (override) candidates.push({ command: override, prefix: [] });
  candidates.push({ command: "burn-events", prefix: [] });
  if (platform() === "win32") candidates.push({ command: "burn-events.exe", prefix: [] });

  for (const candidate of candidates) {
    try {
      await spawnRunner(candidate, ["--version"], 60_000);
      cachedExporter = candidate;
      return candidate;
    } catch {
      /* probe the next location */
    }
  }
  const tried = override ? `${override}, burn-events` : "burn-events on PATH";
  throw new ExporterError(
    `burn-events exporter not found (tried ${tried}). ` +
      `Install it once per machine: cargo install --path crates/burn-events ` +
      `— or download a release binary and point BURN_EVENTS_BIN at it.`,
  );
}

/** Semver from `burn-events --version` ("burn-events 4.15.1"), or null. */
export function exporterVersion(): Promise<string | null> {
  if (cachedExporterVersion !== null) return Promise.resolve(cachedExporterVersion);
  if (exporterVersionProbe !== null) return exporterVersionProbe;
  const pending = (async () => {
    try {
      const runner = await resolveExporter();
      const { stdout } = await spawnRunner(runner, ["--version"], 60_000);
      const version = /^burn-events\s+(\S+)/m.exec(stdout)?.[1] ?? null;
      if (version !== null) cachedExporterVersion = version;
      return version;
    } catch {
      return null;
    }
  })();
  exporterVersionProbe = pending;
  void pending.finally(() => {
    if (exporterVersionProbe === pending) exporterVersionProbe = null;
  });
  return pending;
}

export function assertExporterMatchesPin(version: string, pin: string): void {
  if (version !== pin) {
    throw new ExporterError(
      `burn-events ${version} does not match the tokscale pin ${pin} — the exporter embeds ` +
        `tokscale-core, so rebuild it: cargo install --path crates/burn-events`,
    );
  }
}

/** Cheap source-generation probe; null falls back to an uncached scan. */
export async function exporterFingerprint(): Promise<string | null> {
  try {
    const runner = await resolveExporter();
    const { stdout } = await spawnRunner(runner, ["--fingerprint"], 60_000);
    const fingerprint = stdout.trim();
    return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
  } catch {
    // Older same-pin development binaries do not have this command. Serving
    // uncached remains correct until they are rebuilt.
    return null;
  }
}

/** Full scan through the exporter; returns its raw JSONL stdout. */
export async function fetchEventsJsonl(sinceMs: number, timeoutMs = 300_000): Promise<string> {
  const runner = await resolveExporter();
  const args = sinceMs > 0 ? ["--since-ms", String(sinceMs)] : [];
  try {
    const { stdout } = await spawnRunner(runner, args, timeoutMs);
    return stdout;
  } catch (err) {
    if (err instanceof TokscaleError) throw new ExporterError(err.message);
    throw err;
  }
}
