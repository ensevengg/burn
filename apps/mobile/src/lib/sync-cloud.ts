import { mergeCloudEvents, mergeQuota } from "./mirror-writes";
import { quotaMirrorKey } from "@burn/sync-api";
import type { DeltaCursors, MobileSyncApi } from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { withWriteLock } from "./writelock";

export type MirrorChange = "events" | "machines" | "quotas";
export interface SyncResult {
  pulledEvents: number;
  pages: number;
  watermark: number;
  hasMore: boolean;
  quotaError?: string;
}
const WATERMARK_KEY = "watermark_revision";
const MAX_PAGES = 8;
const CURSORS_KEY = "cloud_cursors_v2";
const MEMBERSHIP_KEY = "cloud_membership_v2";
async function kvGet(db: SQLiteDatabase, key: string): Promise<string | null> {
  return (
    (
      await db.getFirstAsync<{ value: string }>(
        "select value from kv where key = ?",
        [key],
      )
    )?.value ?? null
  );
}
async function kvSet(
  db: SQLiteDatabase,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync("insert or replace into kv (key, value) values (?, ?)", [
    key,
    value,
  ]);
}

/** Independent network channels; only local commits share the SQLite write lock. */
export async function pullCloud(
  db: SQLiteDatabase,
  phone: MobileSyncApi,
  assertActive: () => void = () => {},
  onChange: (kind: MirrorChange) => void = () => {},
  signal?: AbortSignal,
): Promise<SyncResult> {
  const pullEvents = async (): Promise<SyncResult> => {
    const sinceRevision = Number((await kvGet(db, WATERMARK_KEY)) ?? 0);
    let watermark = sinceRevision;
    // Ignore the legacy global watermark once: replay repairs older missed machines.
    let cursors: DeltaCursors = JSON.parse(
      (await kvGet(db, CURSORS_KEY)) ?? "{}",
    );
    let pulledEvents = 0;
    let pages = 0;
    let hasMore = false;

    // Loop until the backend reports everything below the watermark shipped.
    // Each page commits atomically before the watermark advances.
    for (let page = 0; page < MAX_PAGES; page++) {
      assertActive();
      const delta = await phone.fetchDelta(cursors, 1000, signal);
      hasMore = delta.hasMore;
      if (hasMore && delta.events.length === 0)
        throw new Error("Backend returned an empty unfinished page");
      await withWriteLock(async () => {
        assertActive();
        let membershipChanged = false;
        let quotasChanged = false;
        await db.withTransactionAsync(async () => {
          const direct = await db.getAllAsync<{ id: string; slug: string }>(
            "select id,slug from direct_machines",
          );
          // Environment membership is authoritative in cloud mode. Reconcile
          // deletions without removing machines registered directly on this phone.
          const local = await db.getAllAsync<{ id: string }>(
            "select id from environments",
          );
          const present = new Set([
            ...delta.environments.map((env) => env.id),
            ...direct.map((machine) => machine.id),
          ]);
          for (const env of local) {
            if (present.has(env.id)) continue;
            await db.runAsync(
              "delete from usage_events where environment_id=?",
              [env.id],
            );
            const removedQuotas = await db.runAsync(
              "delete from quota_snapshots where environment_id=?",
              [env.id],
            );
            quotasChanged ||= removedQuotas.changes > 0;
            await db.runAsync("delete from environments where id=?", [env.id]);
            delete cursors[env.id];
            membershipChanged = true;
          }
          for (const env of delta.environments) {
            const peer = direct.find(
              (machine) => machine.slug === env.slug && machine.id !== env.id,
            );
            if (peer) {
              // Switching modes preserves one machine identity, its local rows,
              // paging state and registry even when the server uses a UUID.
              await db.runAsync("update direct_machines set id=? where id=?", [
                env.id,
                peer.id,
              ]);
              await db.runAsync(
                "update usage_events set environment_id=? where environment_id=?",
                [env.id, peer.id],
              );
              const quotas = await db.getAllAsync<{
                row_key: string;
                provider: string;
                account_key: string;
                metric: string;
                status: "ok" | "error";
              }>(
                "select row_key,provider,account_key,metric,status from quota_snapshots where environment_id=?",
                [peer.id],
              );
              for (const q of quotas) {
                quotasChanged = true;
                const target = quotaMirrorKey(
                  env.id,
                  q.provider,
                  q.account_key,
                  q.metric,
                  q.status,
                );
                // A parallel quota pull may already have populated the UUID.
                // Preserve whichever collection is newer during reassociation.
                await db.runAsync(
                  `delete from quota_snapshots where row_key=? and julianday(fetched_at)<=
                  (select julianday(fetched_at) from quota_snapshots where row_key=?)`,
                  [target, q.row_key],
                );
                await db.runAsync(
                  "update or ignore quota_snapshots set environment_id=?,row_key=? where row_key=?",
                  [env.id, target, q.row_key],
                );
                await db.runAsync(
                  "delete from quota_snapshots where row_key=?",
                  [q.row_key],
                );
              }
              for (const prefix of [
                "direct_since_v3_",
                "direct_hash_",
                "direct_backfill_",
                "direct_full_at_",
              ]) {
                const value = await kvGet(db, prefix + peer.id);
                if (value !== null) {
                  await kvSet(db, prefix + env.id, value);
                  await db.runAsync("delete from kv where key=?", [
                    prefix + peer.id,
                  ]);
                }
              }
              await db.runAsync("delete from environments where id=?", [
                peer.id,
              ]);
              peer.id = env.id;
              membershipChanged = true;
            }
            await db.runAsync(
              `insert into environments
             (id, slug, display_name, host_group, os_kind, reporter_version, tokscale_version,
              export_schema, reporting_timezone, last_heartbeat_at, last_success_at, last_error, latest_revision, live_endpoint)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set
             slug = excluded.slug, display_name = excluded.display_name,
             host_group = excluded.host_group, os_kind = excluded.os_kind,
             reporter_version = excluded.reporter_version, tokscale_version = excluded.tokscale_version,
             export_schema = excluded.export_schema,
             reporting_timezone = excluded.reporting_timezone,
             last_heartbeat_at = excluded.last_heartbeat_at, last_success_at = excluded.last_success_at,
             last_error = excluded.last_error, latest_revision = excluded.latest_revision,
             live_endpoint = excluded.live_endpoint`,
              [
                env.id,
                env.slug,
                env.displayName,
                env.hostGroup,
                env.osKind,
                env.reporterVersion,
                env.tokscaleVersion,
                env.exportSchema,
                env.reportingTimezone,
                env.lastHeartbeatAt,
                env.lastSuccessAt,
                env.lastError,
                env.latestRevision,
                env.liveEndpoint,
              ],
            );
          }
          await kvSet(
            db,
            MEMBERSHIP_KEY,
            JSON.stringify(delta.environments.map((env) => env.id)),
          );
          const orphanQuotas =
            await db.runAsync(`delete from quota_snapshots where environment_id is not null
            and environment_id not in (select id from environments)`);
          quotasChanged ||= orphanQuotas.changes > 0;
          await mergeCloudEvents(db, delta.events, assertActive);
          assertActive();
          const next = delta.cursors ?? { ...cursors };
          // Non-Supabase adapters may derive continuations from their returned rows.
          for (const event of delta.events) {
            const previous = next[event.environmentId];
            if (
              !previous ||
              event.revision > previous.revision ||
              (event.revision === previous.revision &&
                event.eventId > previous.eventId)
            ) {
              next[event.environmentId] = {
                revision: event.revision,
                eventId: event.eventId,
              };
            }
          }
          for (const envId of Object.keys(next)) {
            if (!delta.environments.some((env) => env.id === envId))
              delete next[envId];
          }
          for (const [envId, cursor] of Object.entries(cursors)) {
            if (!delta.environments.some((env) => env.id === envId)) continue;
            const nextCursor = next[envId];
            if (
              !nextCursor ||
              nextCursor.revision < cursor.revision ||
              (nextCursor.revision === cursor.revision &&
                nextCursor.eventId < cursor.eventId)
            ) {
              throw new Error("Backend cursor moved backwards");
            }
          }
          await kvSet(db, CURSORS_KEY, JSON.stringify(next));
          await kvSet(
            db,
            WATERMARK_KEY,
            String(Math.max(watermark, delta.maxRevision)),
          );
          cursors = next;
        });
        // Membership changes can remove or reattribute events too.
        if (delta.events.length || membershipChanged) onChange("events");
        onChange("machines");
        if (quotasChanged) onChange("quotas");
      });
      watermark = Math.max(watermark, delta.maxRevision);
      pulledEvents += delta.events.length;
      pages++;
      if (!delta.hasMore || delta.events.length === 0) break;
    }

    return { pulledEvents, pages, watermark, hasMore };
  };
  const pullQuotas = async (): Promise<void> => {
    // Env-scoped row keys (C2): same scheme as the demo mirror, so a future
    // per-environment quota stream can't silently collide.
    const quotas = await phone.fetchQuotaLatest(signal);
    await withWriteLock(async () => {
      assertActive();
      await db.withTransactionAsync(async () => {
        const membershipRaw = await kvGet(db, MEMBERSHIP_KEY);
        const members =
          membershipRaw === null
            ? null
            : new Set<string>(JSON.parse(membershipRaw));
        const direct = await db.getAllAsync<{ id: string }>(
          "select id from direct_machines",
        );
        for (const machine of direct) members?.add(machine.id);
        for (const q of quotas) {
          if (
            members &&
            q.environmentId !== null &&
            !members.has(q.environmentId)
          )
            continue;
          await mergeQuota(
            db,
            q.environmentId,
            { ...q, sourceOffsetMinutes: null },
            q.fetchedAt,
          );
          assertActive();
        }
      });

      onChange("quotas");
    });
  };
  const results = await Promise.allSettled([pullEvents(), pullQuotas()]);
  const events = results[0];
  if (events.status === "rejected") throw events.reason;
  assertActive();
  const quotas = results[1];
  return {
    ...events.value,
    ...(quotas.status === "rejected"
      ? {
          quotaError:
            quotas.reason instanceof Error
              ? quotas.reason.message
              : String(quotas.reason),
        }
      : {}),
  };
}
