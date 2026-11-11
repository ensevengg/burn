/**
 * Opt-in machine controls (ADR 0004). The only control is the OS power mode
 * (Linux power-profiles-daemon / kernel platform_profile), which on most
 * laptops also selects the firmware fan curve. Controls are live-only: state
 * is never mirrored into SQLite and nothing is queued while a machine is
 * offline. Reads and the one write share this validated shape.
 */
import { LiveError } from "./errors";
import {
  object as expectObject,
  string as expectString,
  choice,
  integer,
  nullableString,
  timestamp,
} from "./validation";

/** Advertised in /ping `capabilities` when the reporter has it enabled. */
export const POWER_MODE_CAPABILITY = "power-mode";
export const POWER_MODE_PATH = "/controls/power-mode";
/** Required on every control write. A browser cannot attach it to a
 * cross-origin request without a CORS preflight, which the reporter never
 * grants — so a web page on a tailnet device cannot flip the mode. */
export const CONTROL_HEADER = "x-burn-control";

export type PowerModeBackend = "power-profiles-daemon" | "platform-profile";

export interface MachineFan {
  label: string;
  rpm: number;
  /** Rated maximum when the driver reports one; scales the phone's gauge. */
  maxRpm: number | null;
}

export interface PowerModeState {
  generatedAt: string;
  backend: PowerModeBackend;
  /** Active mode id; may be outside `modes` (e.g. set by firmware hotkey). */
  mode: string | null;
  /** Selectable modes in the backend's own vocabulary. */
  modes: string[];
  /** Backend-reported reason performance is held back (e.g. lap-detected). */
  degraded: string | null;
  fans: MachineFan[];
}

const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function powerModeId(value: unknown, where: string): string {
  const mode = expectString(value, where);
  if (!MODE_ID.test(mode)) throw new LiveError(`${where}: invalid power mode`);
  return mode;
}

/** Validate a reporter's power-mode state before the phone renders it. */
export function parsePowerModeState(raw: unknown): PowerModeState {
  const state = expectObject(raw, "power mode");
  if (!Array.isArray(state.modes) || state.modes.length === 0 || state.modes.length > 8)
    throw new LiveError("power mode: expected 1–8 modes");
  const modes = state.modes.map((mode, index) => powerModeId(mode, `modes[${index}]`));
  if (new Set(modes).size !== modes.length) throw new LiveError("power mode: duplicate modes");
  if (!Array.isArray(state.fans) || state.fans.length > 16)
    throw new LiveError("power mode: expected up to 16 fans");
  const fans = state.fans.map((row, index) => {
    const fan = expectObject(row, `fans[${index}]`);
    const label = expectString(fan.label, `fans[${index}].label`);
    if (!label.trim() || label.length > 64) throw new LiveError(`fans[${index}].label: invalid`);
    const rpm = integer(fan.rpm, `fans[${index}].rpm`);
    if (rpm > 50_000) throw new LiveError(`fans[${index}].rpm: out of range`);
    const maxRpm = fan.maxRpm === null || fan.maxRpm === undefined
      ? null
      : integer(fan.maxRpm, `fans[${index}].maxRpm`, 1);
    if (maxRpm !== null && maxRpm > 50_000) throw new LiveError(`fans[${index}].maxRpm: out of range`);
    return { label, rpm, maxRpm };
  });
  const degraded = nullableString(state.degraded, "degraded");
  if (degraded !== null && degraded.length > 128) throw new LiveError("degraded: too long");
  return {
    generatedAt: timestamp(state.generatedAt, "generatedAt"),
    backend: choice(state.backend, ["power-profiles-daemon", "platform-profile"], "backend"),
    mode: state.mode === null || state.mode === undefined ? null : powerModeId(state.mode, "mode"),
    modes,
    degraded,
    fans,
  };
}

/** Validate a write request body on the reporter. */
export function parsePowerModeRequest(raw: unknown): { mode: string } {
  const body = expectObject(raw, "request");
  // Reject unknown fields so a future, richer request never half-applies.
  for (const key of Object.keys(body))
    if (key !== "mode") throw new LiveError(`request: unexpected field ${key}`);
  return { mode: powerModeId(body.mode, "mode") };
}

/** Machines advertise controls through /ping capabilities only. */
export function supportsPowerMode(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(POWER_MODE_CAPABILITY) ?? false;
}
