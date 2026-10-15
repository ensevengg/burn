import type { SQLiteDatabase } from "expo-sqlite";
export type MirrorChange = "events" | "quotas" | "machines" | "systems";
const generations = new WeakMap<SQLiteDatabase, number>();
export const syncGeneration = (db: SQLiteDatabase): number => generations.get(db) ?? 0;
export const advanceSyncGeneration = (db: SQLiteDatabase): void => {
  generations.set(db, syncGeneration(db) + 1);
};
const listeners = new Set<(db: SQLiteDatabase, kind: MirrorChange) => void>();
export function subscribeMirrorChanges(
  listener: (db: SQLiteDatabase, kind: MirrorChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishMirrorChange(db: SQLiteDatabase, kind: MirrorChange): void {
  for (const listener of listeners) listener(db, kind);
}

/**
 * Per-machine pull progress, published by the pull driver itself so that
 * coalesced callers (who share one pending promise) all observe it. UI-only:
 * nothing here gates writes.
 */
export type PullProgress =
  | { kind: "begin"; machines: string[] }
  | { kind: "settled"; environmentId: string; state: "live" | "offline" | "error" | "skipped" };
const progressListeners = new Set<(db: SQLiteDatabase, event: PullProgress) => void>();
export function subscribePullProgress(
  listener: (db: SQLiteDatabase, event: PullProgress) => void,
): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}
export function publishPullProgress(db: SQLiteDatabase, event: PullProgress): void {
  for (const listener of progressListeners) listener(db, event);
}
