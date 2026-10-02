import type { SQLiteDatabase } from "expo-sqlite";
import { withWriteLock } from "./writelock";

export type AppMode = "unconfigured" | "demo" | "direct";
async function readValue(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>("select value from kv where key=?", [key]);
  return row?.value ?? null;
}
async function writeValue(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync("insert into kv (key,value) values (?,?) on conflict(key) do update set value=excluded.value", [key,value]);
}

/** Upgrade old backend selections without deleting cached history/preferences.
 * Known machine URLs become registrations; existing registrations win. No
 * network request is required to open the app or perform this migration. */
export async function readAppMode(db: SQLiteDatabase): Promise<AppMode> {
  return withWriteLock(async () => {
    let mode = await readValue(db, "mode");
    if (mode === "cloud") {
      await db.withTransactionAsync(async () => {
        await db.runAsync(
          `insert into direct_machines (id,slug,base_url,display_name,added_at)
           select id,slug,live_endpoint,display_name,? from environments
           where live_endpoint like 'http://%' or live_endpoint like 'https://%'
           on conflict do nothing`,
          [new Date().toISOString()],
        );
        await db.runAsync(
          "update environments set last_heartbeat_at=null,last_error='Add the machine URL to resume refreshes.' where id not in (select id from direct_machines)",
        );
        await db.runAsync("delete from kv where key in ('watermark_revision','cloud_cursors_v2','cloud_membership_v2')");
        await writeValue(db, "mode", "direct");
      });
      mode = "direct";
    }
    if (mode === "direct" && await readValue(db, "machine_backend_v1") === null) {
      // One corrective replay after switching authority to the machine.
      await db.withTransactionAsync(async () => {
        await db.runAsync("delete from kv where key glob 'direct_full_at_*' or key glob 'direct_hash_*' or key glob 'direct_backfill_*'");
        await writeValue(db, "machine_backend_v1", "1");
      });
    }
    return mode === "demo" || mode === "direct" ? mode : "unconfigured";
  });
}
