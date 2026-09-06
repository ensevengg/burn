import type { SQLiteDatabase } from "expo-sqlite";
import type { MirrorChange } from "./sync-cloud";
const generations = new WeakMap<SQLiteDatabase, number>();
export const cloudGeneration = (db: SQLiteDatabase): number => generations.get(db) ?? 0;
export const advanceCloudGeneration = (db: SQLiteDatabase): void => {
  generations.set(db, cloudGeneration(db) + 1);
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
