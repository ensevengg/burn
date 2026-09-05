import * as SecureStore from "expo-secure-store";
import { kvGet, kvSet } from "./db";
import type { SQLiteDatabase } from "expo-sqlite";

export type AppMode = "unconfigured" | "demo" | "cloud";

export interface ConnectionConfig {
  url: string;
  publishableKey: string;
  readToken: string;
}

const SECURE_URL = "burn.supabase_url";
const SECURE_KEY = "burn.publishable_key";
const SECURE_TOKEN = "burn.read_token";

export const DEFAULT_REPORTING_TZ = "Asia/Kolkata";

export async function getMode(db: SQLiteDatabase): Promise<AppMode> {
  return ((await kvGet(db, "mode")) ?? "unconfigured") as AppMode;
}

export async function getReportingTimezone(db: SQLiteDatabase): Promise<string> {
  return (await kvGet(db, "reporting_timezone")) ?? DEFAULT_REPORTING_TZ;
}

export async function setReportingTimezone(db: SQLiteDatabase, timeZone: string): Promise<void> {
  await kvSet(db, "reporting_timezone", timeZone);
}

export async function saveConnection(db: SQLiteDatabase, config: ConnectionConfig): Promise<void> {
  await SecureStore.setItemAsync(SECURE_URL, config.url);
  await SecureStore.setItemAsync(SECURE_KEY, config.publishableKey);
  await SecureStore.setItemAsync(SECURE_TOKEN, config.readToken);
  await kvSet(db, "mode", "cloud");
}

export async function loadConnection(): Promise<ConnectionConfig | null> {
  const [url, publishableKey, readToken] = await Promise.all([
    SecureStore.getItemAsync(SECURE_URL),
    SecureStore.getItemAsync(SECURE_KEY),
    SecureStore.getItemAsync(SECURE_TOKEN),
  ]);
  if (url === null || publishableKey === null || readToken === null) return null;
  return { url, publishableKey, readToken };
}

export async function clearConnection(db: SQLiteDatabase): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SECURE_URL),
    SecureStore.deleteItemAsync(SECURE_KEY),
    SecureStore.deleteItemAsync(SECURE_TOKEN),
  ]);
  await kvSet(db, "mode", "unconfigured");
}
