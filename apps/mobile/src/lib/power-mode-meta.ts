/**
 * Pure presentation rules for the power-mode control (ADR 0004): how each OS
 * mode id reads, which glyph it gets, and how fast a fan rotor should turn.
 * Mode ids come from the machine (power-profiles-daemon or the kernel
 * platform_profile vocabulary) and never render raw.
 */
import { humanize } from "./labels";

export type ModeGlyph = "leaf" | "balance" | "bolt" | "flame" | "dot";

export interface ModeMeta {
  label: string;
  description: string;
  glyph: ModeGlyph;
  /** 0 = coolest/quietest … 1 = hottest/loudest. */
  heat: number;
}

const KNOWN: Record<string, Omit<ModeMeta, "label">> = {
  cool: { glyph: "leaf", heat: 0, description: "Keeps the chassis cool; fans stay low." },
  quiet: { glyph: "leaf", heat: 0.1, description: "Quietest fans, lower clocks." },
  "low-power": { glyph: "leaf", heat: 0.15, description: "Quiet fans, lower clocks, longest battery." },
  "power-saver": { glyph: "leaf", heat: 0.15, description: "Quiet fans, lower clocks, longest battery." },
  balanced: { glyph: "balance", heat: 0.5, description: "Fans and clocks follow the load." },
  "balanced-performance": { glyph: "bolt", heat: 0.65, description: "Leans toward speed; fans a little louder." },
  performance: { glyph: "bolt", heat: 0.85, description: "Higher clocks; fans spin up early." },
  "max-power": { glyph: "flame", heat: 1, description: "Everything unlocked; loudest fans." },
};

const ORDER = Object.keys(KNOWN);

export function modeMeta(mode: string): ModeMeta {
  const known = KNOWN[mode];
  const label = humanize(mode);
  if (known === undefined) return { label, description: "Set by the machine's own power manager.", glyph: "dot", heat: 0.5 };
  return { label, ...known };
}

/** Coolest first; unknown ids keep their relative order after known ones. */
export function orderModes(modes: readonly string[]): string[] {
  const rank = (mode: string) => {
    const index = ORDER.indexOf(mode);
    return index === -1 ? ORDER.length : index;
  };
  return [...modes].sort((a, b) => rank(a) - rank(b));
}

/** Without a rated maximum, laptop fans top out around here. */
const ASSUMED_MAX_RPM = 6_000;

export function fanFraction(rpm: number, maxRpm: number | null): number {
  if (!Number.isFinite(rpm) || rpm <= 0) return 0;
  return Math.min(1, rpm / (maxRpm ?? ASSUMED_MAX_RPM));
}

/**
 * Milliseconds per rotor turn. Real fans spin far faster than the eye can
 * follow (3,000 rpm = 50 turns/s), so speed maps onto a readable 2.4 s → 0.35 s
 * band instead; a stopped fan returns null.
 */
export function rotorPeriodMs(rpm: number, maxRpm: number | null): number | null {
  const fraction = fanFraction(rpm, maxRpm);
  if (fraction === 0) return null;
  return Math.round(2_400 - (2_400 - 350) * Math.sqrt(fraction));
}

export function formatRpm(rpm: number): string {
  return `${Math.round(rpm).toLocaleString("en-US")} rpm`;
}
