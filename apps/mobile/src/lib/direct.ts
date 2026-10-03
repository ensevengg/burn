import { mergePeerEvents, mergeQuota, mergeMetrics } from "./mirror-writes";
/** Machines are the backend (ADR 0003). Each registry endpoint supplies
 * validated event pages and independent quotas. The phone stores per-machine
 * scan-start cursors, atomically commits page continuation, and periodically
 * reconciles full history to pick up old parser/pricing corrections. */
import {
  LIVE_OVERLAP_MS,
  httpLiveApiFor,
  validateLiveApi,
  LiveError,
  type LiveApi,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { invalidateEventCache } from "../data/repository";
import { withWriteLock } from "./writelock";
import { syncGeneration, publishMirrorChange } from "./sync-state";
import { describeFailure, withTimeout } from "./transport";

export interface DirectMachine {
  id: string;
  slug: string;
  baseUrl: string;
  displayName: string;
  addedAt: string;
  lastPingAt: string | null;
  lastError: string | null;
}

export interface DirectPullStatus {
  environmentId: string;
  slug: string;
  endpoint: string;
  state: "live" | "offline" | "error" | "skipped";
  pulledEvents: number;
  pulledQuotas: number;
  clockSkewMs: number | null;
  error: string | null;
  elapsedMs: number;
  quotaError?: string | null;
  metricsError?: string | null;
  pulledMetrics?: number;
  initialSyncComplete?: boolean;
  scanMs?: number | null;
  hasMore?: boolean;
}

export interface DirectPullOptions {
  pingTimeoutMs?: number;
  quotaTimeoutMs?: number;
  metricsTimeoutMs?: number;
  full?: boolean;
  environmentId?: string;
  eventsTimeoutMs?: number;
  maxPages?: number;
  /** Resume persisted event backfills only. Quota and health results from the
   * preceding pass are reported again instead of being re-requested. */
  continuation?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Test seam. */
  apiFor?: (endpoint: string) => LiveApi;
  now?: () => number;
}

const inFlight = new WeakMap<SQLiteDatabase, Promise<DirectPullStatus[]>>();
const inFlightController = new WeakMap<SQLiteDatabase, AbortController>();
const inFlightOptions = new WeakMap<SQLiteDatabase, DirectPullOptions>();
const cancellationEpochs = new WeakMap<SQLiteDatabase, number>();

type ChannelResult = { count: number; error: string | null };
const lastChannels = new WeakMap<
  SQLiteDatabase,
  Map<string, { quotas?: ChannelResult; metrics?: ChannelResult }>
>();
function channelMemo(db: SQLiteDatabase, environmentId: string) {
  let machines = lastChannels.get(db);
  if (!machines) lastChannels.set(db, (machines = new Map()));
  let memo = machines.get(environmentId);
  if (!memo) machines.set(environmentId, (memo = {}));
  return memo;
}

export function directEnvId(slug: string): string {
  return `direct-${slug}`;
}

function cursorKey(envId: string): string {
  // Old cursors used phone time and could advance beyond the machine scan.
  // Replay once using the server scan boundary, including the original tail-only bug.
  return `direct_since_v3_${envId}`;
}

function legacyCursorKey(envId: string): string {
  return `direct_since_${envId}`;
}

async function kvGetNumber(
  db: SQLiteDatabase,
  key: string,
): Promise<number | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    "select value from kv where key = ?",
    [key],
  );
  const parsed = row === null ? NaN : Number(row.value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function kvSetString(
  db: SQLiteDatabase,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync("insert or replace into kv (key, value) values (?, ?)", [
    key,
    value,
  ]);
}

async function kvDelete(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync("delete from kv where key = ?", [key]);
}

export async function listDirectMachines(
  db: SQLiteDatabase,
): Promise<DirectMachine[]> {
  const rows = await db.getAllAsync<{
    id: string;
    slug: string;
    base_url: string;
    display_name: string;
    added_at: string;
    last_ping_at: string | null;
    last_error: string | null;
  }>("select * from direct_machines order by added_at");
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    baseUrl: r.base_url,
    displayName: r.display_name,
    addedAt: r.added_at,
    lastPingAt: r.last_ping_at,
    lastError: r.last_error,
  }));
}

/**
 * Validate an endpoint with /ping and register it. The environment id reuses
 * an existing environment row with the same slug when one exists, preserving
 * cached history across upgrades and endpoint changes.
 */
export async function addDirectMachine(
  db: SQLiteDatabase,
  rawUrl: string,
  options: {
    pingTimeoutMs?: number;
    apiFor?: (endpoint: string) => LiveApi;
    now?: () => number;
  } = {},
): Promise<{ id: string; slug: string; displayName: string }> {
  const generation = syncGeneration(db);
  const assertActive = () => {
    if (syncGeneration(db) !== generation)
      throw new LiveError("add machine cancelled");
  };
  const base = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base))
    throw new LiveError("machine URL must start with http:// or https://");
  const now = options.now ?? Date.now;
  const pingTimeout = withTimeout(undefined, options.pingTimeoutMs ?? 3_000);
  const api = validateLiveApi(
    options.apiFor ? options.apiFor(base) : httpLiveApiFor(base, fetch),
  );
  let ping;
  try {
    ping = await api.ping(pingTimeout.signal);
  } catch (err) {
    throw new LiveError(`no answer from ${base}: ${(err as Error).message}`);
  } finally {
    pingTimeout.cancel();
  }
  assertActive();
  if (ping.slug.trim().length === 0)
    throw new LiveError("machine reported an empty slug");

  const existing = await db.getFirstAsync<{ id: string }>(
    "select id from environments where slug = ? limit 1",
    [ping.slug],
  );
  const id = existing?.id ?? directEnvId(ping.slug);
  const registered = await db.getFirstAsync<{ id: string }>(
    "select id from direct_machines where slug = ?",
    [ping.slug],
  );
  if (registered !== null && registered.id !== id) {
    throw new LiveError(`machine "${ping.slug}" is already registered`);
  }

  await withWriteLock(async () => {
    assertActive();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `insert into direct_machines (id, slug, base_url, display_name, added_at, last_ping_at, last_error)
         values (?, ?, ?, ?, ?, ?, null)
         on conflict (id) do update set
           base_url = excluded.base_url, display_name = excluded.display_name,
           last_ping_at = excluded.last_ping_at, last_error = null`,
        [
          id,
          ping.slug,
          base,
          ping.displayName,
          new Date(now()).toISOString(),
          new Date(now()).toISOString(),
        ],
      );
      assertActive();
      // The card exists immediately, even before the first pull.
      await db.runAsync(
        `insert into environments
           (id, slug, display_name, host_group, os_kind, reporter_version, tokscale_version,
            export_schema, reporting_timezone, last_heartbeat_at, last_success_at, last_error, live_endpoint)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?)
         on conflict (id) do update set
           display_name = excluded.display_name, host_group = excluded.host_group,
           os_kind = excluded.os_kind, reporter_version = excluded.reporter_version,
           tokscale_version = excluded.tokscale_version, export_schema = excluded.export_schema,
           reporting_timezone = excluded.reporting_timezone, live_endpoint = excluded.live_endpoint`,
        [
          id,
          ping.slug,
          ping.displayName,
          ping.hostGroup,
          ping.osKind,
          ping.reporterVersion,
          ping.tokscaleVersion,
          ping.exportSchema,
          ping.reportingTimezone,
          base,
        ],
      );
      assertActive();
    });
    invalidateEventCache(db);
  });
  publishMirrorChange(db, "machines");
  return { id, slug: ping.slug, displayName: ping.displayName };
}

/** Registry removal + local data cascade (nothing server-side exists here). */
export async function removeDirectMachine(
  db: SQLiteDatabase,
  environmentId: string,
): Promise<void> {
  await withWriteLock(async () => {
    await db.withTransactionAsync(async () => {
      await db.runAsync("delete from direct_machines where id = ?", [
        environmentId,
      ]);
      await db.runAsync("delete from usage_events where environment_id = ?", [
        environmentId,
      ]);
      await db.runAsync(
        "delete from quota_snapshots where environment_id = ?",
        [environmentId],
      );
      await db.runAsync("delete from machine_metrics where environment_id = ?", [environmentId]);
      await db.runAsync("delete from environments where id = ?", [
        environmentId,
      ]);
      await db.runAsync("delete from kv where key = ?", [
        cursorKey(environmentId),
      ]);
      await db.runAsync("delete from kv where key = ?", [
        legacyCursorKey(environmentId),
      ]);
      for (const key of [
        `direct_since_v2_${environmentId}`,
        `direct_hash_${environmentId}`,
        `direct_backfill_${environmentId}`,
        `direct_full_at_${environmentId}`,
      ])
        await kvDelete(db, key);
    });
    invalidateEventCache(db);
  });
  lastChannels.get(db)?.delete(environmentId);
  publishMirrorChange(db, "machines");
}

/**
 * Probe every registered machine and merge its tail. Same concurrency and
 * cancellation contract as all mirror writers: compatible calls share the
 * pending result, and reset/disconnect aborts before any commit.
 */
export function pullDirectFromMachines(
  db: SQLiteDatabase,
  options: DirectPullOptions = {},
): Promise<DirectPullStatus[]> {
  if (options.signal?.aborted)
    return Promise.reject(new LiveError("direct pull cancelled"));
  const generation = syncGeneration(db);
  const epoch = cancellationEpochs.get(db) ?? 0;
  const existing = inFlight.get(db);
  if (existing) {
    const running = inFlightOptions.get(db)!;
    // Any pass resumes pending backfills, but a continuation skips quota and
    // health requests, so it cannot stand in for a regular refresh.
    if (
      running.environmentId === options.environmentId &&
      Boolean(running.full) === Boolean(options.full) &&
      (!running.continuation || options.continuation === true)
    )
      return existing;
    // A different target/full replay must run after the current pass. Even an
    // all-machine pass may have captured membership before this target was added.
    return existing
      .catch(() => {})
      .then(() => {
        if (
          syncGeneration(db) !== generation ||
          (cancellationEpochs.get(db) ?? 0) !== epoch ||
          options.signal?.aborted
        )
          throw new LiveError("direct pull cancelled");
        return pullDirectFromMachines(db, options);
      });
  }
  const internal = new AbortController();
  inFlightController.set(db, internal);
  const relayCaller = () => internal.abort(new Error("cancelled"));
  const callerSignal = options.signal;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) relayCaller();
    else callerSignal.addEventListener("abort", relayCaller, { once: true });
  }
  const assertActive = (): void => {
    if (syncGeneration(db) !== generation || internal.signal.aborted)
      throw new LiveError("direct pull cancelled");
  };
  const pending = pullDirectUnlocked(db, options, internal.signal, assertActive)
    .finally(() => {
      callerSignal?.removeEventListener("abort", relayCaller);
      if (inFlight.get(db) === pending) {
        inFlight.delete(db);
        inFlightController.delete(db);
        inFlightOptions.delete(db);
      }
    })
    .catch((err: unknown) => {
      if (err instanceof LiveError && err.message === "direct pull cancelled")
        throw err;
      throw err;
    });
  inFlight.set(db, pending);
  inFlightOptions.set(db, options);
  return pending;
}

async function pullDirectUnlocked(
  db: SQLiteDatabase,
  options: DirectPullOptions,
  probeSignal: AbortSignal,
  assertActive: () => void,
): Promise<DirectPullStatus[]> {
  const now = options.now ?? Date.now;
  assertActive();
  const pending = options.continuation
    ? new Set(
        (
          await db.getAllAsync<{ key: string }>(
            "select key from kv where key glob 'direct_backfill_*'",
          )
        ).map((row) => row.key.slice("direct_backfill_".length)),
      )
    : null;
  const machines = (await listDirectMachines(db)).filter(
    (machine) =>
      (!options.environmentId || machine.id === options.environmentId) &&
      (pending === null || pending.has(machine.id)),
  );
  assertActive();
  if (machines.length === 0) return [];

  const statuses = await Promise.all(
    machines.map(async (machine): Promise<DirectPullStatus> => {
      const started = now();
      const base: DirectPullStatus = {
        environmentId: machine.id,
        slug: machine.slug,
        endpoint: machine.baseUrl,
        state: "live",
        pulledEvents: 0,
        pulledQuotas: 0,
        clockSkewMs: null,
        error: null,
        elapsedMs: 0,
      };
      const api = validateLiveApi(
        options.apiFor
          ? options.apiFor(machine.baseUrl)
          : httpLiveApiFor(machine.baseUrl, options.fetchImpl ?? fetch),
      );
      try {
        const pingTimeout = withTimeout(
          probeSignal,
          options.pingTimeoutMs ?? 2_500,
        );
        let ping;
        try {
          ping = await api.ping(pingTimeout.signal);
        } finally {
          pingTimeout.cancel();
        }
        assertActive();
        if (ping.slug !== machine.slug) {
          await persistDirectError(
            db,
            machine.id,
            `Endpoint identity changed to ${ping.slug}`,
            assertActive,
          );
          return {
            ...base,
            state: "skipped",
            error: `endpoint answered as "${ping.slug}", expected "${machine.slug}"`,
            elapsedMs: now() - started,
          };
        }
        const clockSkewMs = Math.abs(ping.serverNowMs - now());
        base.initialSyncComplete = (await kvGetNumber(db, cursorKey(machine.id))) !== null;

        await withWriteLock(async () => {
          assertActive();
          await db.withTransactionAsync(async () => {
            await db.runAsync(
              "update direct_machines set last_ping_at=?,last_error=null where id=?",
              [new Date(now()).toISOString(), machine.id],
            );
            await db.runAsync(
              `update environments set reporter_version=?,tokscale_version=?,export_schema=?,reporting_timezone=?,host_group=coalesce(?,host_group),last_heartbeat_at=? where id=?`,
              [
                ping.reporterVersion,
                ping.tokscaleVersion,
                ping.exportSchema,
                ping.reportingTimezone,
                ping.hostGroup,
                new Date(now()).toISOString(),
                machine.id,
              ],
            );
            assertActive();
          });
        });
        publishMirrorChange(db, "machines");
        const memo = channelMemo(db, machine.id);
        const quotaTask: Promise<ChannelResult> =
          options.continuation && memo.quotas
            ? Promise.resolve(memo.quotas)
            : (async (): Promise<ChannelResult> => {
          const timeout = withTimeout(
            probeSignal,
            options.quotaTimeoutMs ?? 45_000,
          );
          try {
            const page = await api.quotas(timeout.signal);
            let quotaError: string | null = null;
            await withWriteLock(async () => {
              assertActive();
              await db.withTransactionAsync(async () => {
                for (const quota of page.quotas) {
                  await mergeQuota(db, machine.id, quota, page.generatedAt);
                  if (quota.status === "error")
                    quotaError = quota.error ?? "Quota check failed";
                  assertActive();
                }
              });
            });
            publishMirrorChange(db, "quotas");
            return {
              count: page.quotas.filter((q) => q.status === "ok").length,
              error: quotaError,
            };
          } catch (err) {
            assertActive();
            return { count: 0, error: (err as Error).message };
          } finally {
            timeout.cancel();
          }
        })().then((result) => (memo.quotas = result));
        const metricsTask: Promise<ChannelResult> =
          options.continuation && memo.metrics
            ? Promise.resolve(memo.metrics)
            : (async (): Promise<ChannelResult> => {
          if (!api.metrics || ping.osKind === "wsl") return { count: 0, error: null };
          const timeout = withTimeout(probeSignal, options.metricsTimeoutMs ?? 10_000);
          try {
            const page = await api.metrics(Math.max(0, now() - 86_400_000), timeout.signal);
            const count = await withWriteLock(async () => {
              assertActive();
              let changed = 0;
              await db.withTransactionAsync(async () => {
                changed = await mergeMetrics(db, machine.id, page.metrics, now(), assertActive);
                assertActive();
              });
              return changed;
            });
            if (count) publishMirrorChange(db, "systems");
            return { count, error: null };
          } catch (err) {
            assertActive();
            // Pre-Systems reporters remain usable until they are upgraded.
            if (err instanceof LiveError && err.status === 404) return { count: 0, error: null };
            return { count: 0, error: (err as Error).message };
          } finally { timeout.cancel(); }
        })().then((result) => (memo.metrics = result));
        // Channels publish independently, including health when event scans fail.
        const eventTask = (async () => {
          const stored = options.full
            ? null
            : await kvGetNumber(db, cursorKey(machine.id));
          const progressKey = `direct_backfill_${machine.id}`;
          const progressRaw = options.full
            ? null
            : (
                await db.getFirstAsync<{ value: string }>(
                  "select value from kv where key=?",
                  [progressKey],
                )
              )?.value;
          const progress: {
            since: number;
            cursor: string;
            scanStartedAtMs: number;
            snapshotId?: string;
            contentHash?: string;
            reconciliation: boolean;
          } | null = progressRaw ? JSON.parse(progressRaw) : null;
          const lastFull = await kvGetNumber(
            db,
            `direct_full_at_${machine.id}`,
          );
          const reconciliation =
            progress?.reconciliation ??
            (options.full === true ||
              (stored !== null && ping.serverNowMs < stored) ||
              stored === null ||
              lastFull === null ||
              now() < lastFull ||
              now() - lastFull >= 86_400_000);
          const since =
            progress?.since ??
            (reconciliation ? 0 : Math.max(0, stored! - LIVE_OVERLAP_MS));
          const hashKey = `direct_hash_${machine.id}`;
          const oldHash = options.full
            ? null
            : (
                await db.getFirstAsync<{ value: string }>(
                  "select value from kv where key=?",
                  [hashKey],
                )
              )?.value;
          let cursor = progress?.cursor;
          let scanStartedAtMs: number | null =
            progress?.scanStartedAtMs ?? null;
          let snapshotId = progress?.snapshotId;
          let contentHash = progress?.contentHash;
          let pulled = 0;
          let scanMs: number | null = null;
          let restarted = false;
          const seenCursors = new Set<string>();
          for (
            let pageNumber = 0;
            pageNumber < (options.maxPages ?? 8);
            pageNumber++
          ) {
            assertActive();
            const timeout = withTimeout(
              probeSignal,
              options.eventsTimeoutMs ?? 120_000,
            );
            let page;
            try {
              page = await api.events(since, timeout.signal, {
                limit: 1000,
                // Newest rows land first, so recent usage is visible before an
                // initial backfill or daily reconciliation reaches old history.
                order: "desc",
                ...(cursor ? { cursor } : {}),
                // Incremental hashes describe the whole source snapshot, not
                // proof that this phone downloaded its historical contents.
                ...(oldHash && !cursor && !reconciliation
                  ? { knownHash: oldHash }
                  : {}),
                ...(options.full && !cursor ? { force: true } : {}),
              });
            } catch (err) {
              if (
                err instanceof LiveError &&
                err.status === 410 &&
                cursor &&
                !restarted
              ) {
                assertActive();
                restarted = true;
                cursor = undefined;
                scanStartedAtMs = null;
                snapshotId = undefined;
                seenCursors.clear();
                pageNumber--;
                continue;
              }
              throw err;
            } finally {
              timeout.cancel();
            }
            assertActive();
            if (page.slug !== undefined && page.slug !== machine.slug)
              throw new LiveError("Event page identity mismatch");
            if (snapshotId && page.snapshotId !== snapshotId)
              throw new LiveError("Event snapshot changed during backfill");
            snapshotId = page.snapshotId;
            scanStartedAtMs ??=
              page.scanStartedAtMs ??
              Math.min(ping.serverNowMs, Date.parse(page.generatedAt));
            scanMs = page.scanMs ?? null;
            contentHash = page.contentHash;
            const done = !page.nextCursor;
            if (page.nextCursor && seenCursors.has(page.nextCursor))
              throw new LiveError("Repeated event page cursor");
            let changed = 0;
            await withWriteLock(async () => {
              assertActive();
              await db.withTransactionAsync(async () => {
                changed = await mergePeerEvents(
                  db,
                  machine.id,
                  machine.slug,
                  page.events,
                  assertActive,
                );
                if (done) {
                  await kvSetString(
                    db,
                    cursorKey(machine.id),
                    String(
                      stored !== null && ping.serverNowMs < stored
                        ? scanStartedAtMs!
                        : Math.max(stored ?? 0, scanStartedAtMs!),
                    ),
                  );
                  if (contentHash) await kvSetString(db, hashKey, contentHash);
                  if (reconciliation)
                    await kvSetString(
                      db,
                      `direct_full_at_${machine.id}`,
                      String(now()),
                    );
                  await kvDelete(db, progressKey);
                } else {
                  await kvSetString(
                    db,
                    progressKey,
                    JSON.stringify({
                      since,
                      cursor: page.nextCursor,
                      scanStartedAtMs,
                      snapshotId,
                      contentHash,
                      reconciliation,
                    }),
                  );
                }
                assertActive();
              });
              // Reconciliation and overlap pages are mostly unchanged; only
              // committed changes may evict caches and refetch event screens.
              if (changed) invalidateEventCache(db);
            });
            pulled += changed;
            if (changed) publishMirrorChange(db, "events");
            if (done) {
              await withWriteLock(async () => {
                assertActive();
                await db.runAsync(
                  "update environments set last_success_at=? where id=?",
                  [new Date(now()).toISOString(), machine.id],
                );
              });
              publishMirrorChange(db, "machines");
              return { pulled, scanMs, hasMore: false };
            }
            seenCursors.add(page.nextCursor!);
            cursor = page.nextCursor!;
          }
          return { pulled, scanMs, hasMore: true };
        })();
        const [events, quotas, metrics] = await Promise.allSettled([
          eventTask,
          quotaTask,
          metricsTask,
        ]);
        assertActive();
        const metricResult = metrics.status === "fulfilled"
          ? metrics.value : { count: 0, error: (metrics.reason as Error).message };
        const quotaResult =
          quotas.status === "fulfilled"
            ? quotas.value
            : { count: 0, error: (quotas.reason as Error).message };
        if (events.status === "rejected") {
          const failure = describeFailure(events.reason);
          await persistDirectError(db, machine.id, failure.error, assertActive);
          return {
            ...base,
            ...failure,
            pulledQuotas: quotaResult.count,
            quotaError: quotaResult.error,
            pulledMetrics: metricResult.count,
            metricsError: metricResult.error,
            clockSkewMs,
            elapsedMs: now() - started,
          };
        }
        await persistDirectError(
          db,
          machine.id,
          quotaResult.error ?? metricResult.error,
          assertActive,
        );
        return {
          ...base,
          pulledEvents: events.value.pulled,
          pulledQuotas: quotaResult.count,
          quotaError: quotaResult.error,
          pulledMetrics: metricResult.count,
          metricsError: metricResult.error,
          scanMs: events.value.scanMs,
          hasMore: events.value.hasMore,
          initialSyncComplete: base.initialSyncComplete || !events.value.hasMore,
          clockSkewMs,
          elapsedMs: now() - started,
        };
      } catch (err) {
        assertActive();
        const failure = describeFailure(err);
        await persistDirectError(db, machine.id, failure.error, assertActive);
        return { ...base, ...failure, elapsedMs: now() - started };
      }
    }),
  );
  return statuses;
}

export function cancelDirectPull(db: SQLiteDatabase): void {
  cancellationEpochs.set(db, (cancellationEpochs.get(db) ?? 0) + 1);
  inFlightController.get(db)?.abort();
  inFlightController.delete(db);
  inFlight.delete(db);
  inFlightOptions.delete(db);
}
async function persistDirectError(
  db: SQLiteDatabase,
  id: string,
  error: string | null,
  assertActive: () => void,
) {
  await withWriteLock(async () => {
    assertActive();
    await db.runAsync("update direct_machines set last_error=? where id=?", [
      error,
      id,
    ]);
    await db.runAsync("update environments set last_error=? where id=?", [
      error,
      id,
    ]);
  });
  publishMirrorChange(db, "machines");
}
