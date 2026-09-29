/** Runtime wire gates shared by cloud and peer transports. Missing optional
 * fields remain compatible; malformed supplied fields never become zero/null. */
export function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: expected an object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  return value;
}
export function identity(value: unknown, where: string): string {
  const result = string(value, where);
  if (!result.trim() || result.length > 16_384)
    throw new Error(`${where}: invalid identifier`);
  return result;
}
export function nullableString(value: unknown, where = "field"): string | null {
  return value === null || value === undefined ? null : string(value, where);
}
export function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${where}: expected a finite number`);
  return value;
}
export function integer(value: unknown, where: string, minimum = 0): number {
  const result = number(value, where);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new Error(`${where}: expected a safe integer >= ${minimum}`);
  return result;
}
export function nullableNumber(value: unknown, where = "field"): number | null {
  return value === null || value === undefined ? null : number(value, where);
}
export function boolean(
  value: unknown,
  where: string,
  fallback = false,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`${where}: expected a boolean`);
  return value;
}
export function timestamp(value: unknown, where: string): string {
  const result = string(value, where);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error(`${where}: invalid timestamp`);
  return result;
}
export function nullableTimestamp(
  value: unknown,
  where: string,
): string | null {
  return value === null || value === undefined ? null : timestamp(value, where);
}
export function decimal(value: unknown, where: string): string {
  const result = string(value, where);
  if (!/^[+-]?\d+(\.\d+)?$/.test(result))
    throw new Error(`${where}: expected a decimal string`);
  return result;
}
export function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  where: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`${where}: invalid value`);
  return value as T;
}
export function nullableObject(
  value: unknown,
  where: string,
): Record<string, unknown> | null {
  return value === null || value === undefined ? null : object(value, where);
}
