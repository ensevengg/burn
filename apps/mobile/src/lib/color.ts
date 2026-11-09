/** Blend two `#rrggbb` colors; t=0 is `from`, t=1 is `to`. Other formats
 * are returned unblended (the target wins once t reaches 1). */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);
  const a = parse(from);
  const b = parse(to);
  const k = Math.max(0, Math.min(1, t));
  if (a === null || b === null) return k < 1 ? from : to;
  return `#${a.map((value, i) => Math.round(value + (b[i]! - value) * k).toString(16).padStart(2, "0")).join("")}`;
}
