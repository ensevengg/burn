/**
 * Local mirror of the server schema in expo-sqlite (WAL). All screens render
 * from here first — nothing blocks on the network (engineering convention).
 * Day/month/year bucketing happens at render time from UTC instants (D8);
 * no pre-bucketed day keys are ever stored.
 */
import * as SQLite from "expo-sqlite";
import { withWriteLock } from "./writelock";

export type { SQLiteDatabase } from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbPromise === null) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("burn.db");
      await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      await db.execAsync(`
        create table if not exists environments (
          id text primary key,
          slug text not null unique,
          display_name text not null,
          host_group text,
          os_kind text not null,
          reporter_version text,
          tokscale_version text,
          export_schema integer,
          reporting_timezone text,
          last_heartbeat_at text,
          last_success_at text,
          last_error text,
          latest_revision integer not null default 0
        );
        create table if not exists usage_events (
          event_id text primary key,
          environment_id text not null,
          client text not null,
          provider_id text not null,
          model_id text not null,
          session_id text not null,
          session_title text,
          workspace_key text,
          workspace_label text,
          agent text,
          occurred_at_ms integer not null,
          source_offset_minutes integer,
          source_timezone text,
          source_local_date text,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          cache_read_tokens integer not null default 0,
          cache_write_tokens integer not null default 0,
          reasoning_tokens integer not null default 0,
          message_count integer not null default 1,
          is_turn_start integer not null default 0,
          duration_ms integer,
          cost text not null default '0',
          cost_source text not null default 'unknown',
          cost_is_complete integer not null default 0,
          model_attribution_conflicted integer not null default 0,
          parser_version text not null default 'unknown',
          revision integer not null default 0
        );
        create index if not exists usage_events_occurred_idx on usage_events (occurred_at_ms);
        create index if not exists usage_events_session_idx on usage_events (environment_id, session_id);
        create table if not exists quota_snapshots (
          row_key text primary key,
          environment_id text,
          provider text not null,
          account_key text not null,
          account_label text,
          plan text,
          metric text not null,
          used_percent real,
          remaining_percent real,
          remaining_label text,
          resets_at text,
          credit_status text,
          spend_control text,
          status text not null,
          error text,
          fetched_at text not null
        );
        create table if not exists kv (key text primary key, value text not null);
        create table if not exists model_prices (
          model_id text primary key,
          input_cost_per_m real not null,
          cache_read_cost_per_m real not null,
          output_cost_per_m real
        );
      `);
      // C1 parity: installs created before export_schema existed get the column
      // added here; fresh installs already have it from the create block.
      try {
        await db.execAsync("alter table environments add column export_schema integer");
      } catch {
        /* column already exists */
      }
      return db;
    })();
  }
  return dbPromise;
}

export async function kvGet(db: SQLite.SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>("select value from kv where key = ?", [key]);
  return row?.value ?? null;
}

export async function kvSet(db: SQLite.SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync("insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", [
    key,
    value,
  ]);
}

/**
 * Wipes synced data + sync state. Preference keys (reporting_timezone,
 * theme_mode) survive — they are user settings, not data (B2, first-check);
 * callers set `mode` explicitly after a reset.
 */
export function resetDb(db: SQLite.SQLiteDatabase): Promise<void> {
  return withWriteLock(() => wipeForReseed(db));
}

/** Same deletes as resetDb, for callers already holding the write lock. */
export async function wipeForReseed(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync("delete from usage_events");
    await db.runAsync("delete from environments");
    await db.runAsync("delete from quota_snapshots");
    await db.runAsync(
      "delete from kv where key not in ('reporting_timezone', 'theme_mode')",
    );
  });
}
