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
