import { mergeQuota } from "./mirror-writes";
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
}
const WATERMARK_KEY = "watermark_revision";
const MAX_PAGES = 8;
const CURSORS_KEY = "cloud_cursors_v2";
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
        await db.withTransactionAsync(async () => {
          const direct = await db.getAllAsync<{ id: string; slug: string }>(
            "select id,slug from direct_machines",
          );
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
            await db.runAsync(
              "delete from quota_snapshots where environment_id=?",
              [env.id],
            );
            await db.runAsync("delete from environments where id=?", [env.id]);
            delete cursors[env.id];
            membershipChanged = true;
          }
          // 32 rows × 28 bindings = 896 parameters, deliberately under the
          // classic 999 SQLITE_MAX_VARIABLE_NUMBER cap of older system SQLite
          // builds (expo-sqlite's bundled build allows far more). If a column
          // is added, recheck the product or shrink the chunk.
          for (let i = 0; i < delta.events.length; i += 32) {
            assertActive();
            const chunk = delta.events.slice(i, i + 32);
            await db.runAsync(
              `insert or replace into usage_events
             (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
              workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
              source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
              cost_is_complete, model_attribution_conflicted, parser_version, revision)
           values ${chunk.map(() => "(" + Array(28).fill("?").join(",") + ")").join(",")}`,
              chunk.flatMap((e) => [
                e.eventId,
                e.environmentId,
                e.client,
                e.providerId,
                e.modelId,
                e.sessionId,
                e.sessionTitle,
                e.workspaceKey,
                e.workspaceLabel,
                e.agent,
                e.occurredAtMs,
                e.sourceOffsetMinutes,
                e.sourceTimezone,
                e.sourceLocalDate,
                e.inputTokens,
                e.outputTokens,
                e.cacheReadTokens,
                e.cacheWriteTokens,
                e.reasoningTokens,
                e.messageCount,
                e.isTurnStart ? 1 : 0,
                e.durationMs,
                e.cost,
                e.costSource,
                e.costIsComplete ? 1 : 0,
                e.modelAttributionConflicted ? 1 : 0,
                e.parserVersion,
                e.revision,
              ]),
            );
          }
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
          for (const [envId, cursor] of Object.entries(cursors)) {
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
        for (const q of quotas) {
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
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  const events = results[0];
  if (events.status !== "fulfilled") throw new Error("Event sync failed");
  return events.value;
}
