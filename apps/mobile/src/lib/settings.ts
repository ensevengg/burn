import { kvGet, kvSet } from "./db";
import type { SQLiteDatabase } from "expo-sqlite";

export { readAppMode as getMode, type AppMode } from "./connection-mode";
export const DEFAULT_REPORTING_TZ = "Asia/Kolkata";

export async function getReportingTimezone(db: SQLiteDatabase): Promise<string> {
  return (await kvGet(db, "reporting_timezone")) ?? DEFAULT_REPORTING_TZ;
}

export async function setReportingTimezone(db: SQLiteDatabase, timeZone: string): Promise<void> {
  await kvSet(db, "reporting_timezone", timeZone);
}
