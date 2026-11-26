import { kvGet, kvSet } from "./db";
import type { SQLiteDatabase } from "expo-sqlite";
import { parseDashboardView, type DashboardView } from "./dashboard-view";

export { DEFAULT_DASHBOARD_VIEW, type DashboardView } from "./dashboard-view";

export { readAppMode as getMode, type AppMode } from "./connection-mode";
export const DEFAULT_REPORTING_TZ = "Asia/Kolkata";

export async function getReportingTimezone(db: SQLiteDatabase): Promise<string> {
  return (await kvGet(db, "reporting_timezone")) ?? DEFAULT_REPORTING_TZ;
}

export async function setReportingTimezone(db: SQLiteDatabase, timeZone: string): Promise<void> {
  await kvSet(db, "reporting_timezone", timeZone);
}

export async function getDashboardView(db: SQLiteDatabase): Promise<DashboardView> {
  return parseDashboardView(await kvGet(db, "dashboard_view"));
}

export async function setDashboardView(db: SQLiteDatabase, view: DashboardView): Promise<void> {
  await kvSet(db, "dashboard_view", JSON.stringify(view));
}
