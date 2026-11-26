/** Pure keep-awake helpers (ADR 0007), kept free of React Native for tests. */

/** Durations offered on the phone, in minutes. */
export const HOLD_CHOICES = [60, 120, 240, 480] as const;

export function holdChoiceLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** Remaining time as "1h 12m", "45m" or "<1m"; null once the hold is over. */
export function holdLeft(untilMs: number | null, now: number): string | null {
  if (untilMs === null || untilMs <= now) return null;
  const minutes = Math.ceil((untilMs - now) / 60_000);
  if (minutes <= 1 && untilMs - now < 60_000) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
