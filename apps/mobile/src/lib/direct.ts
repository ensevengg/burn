import {
  dropSupersededEvents,
  forgetReconciliation,
  mergePeerEvents,
  mergeQuota,
  mergeMetrics,
  resetReconciledSessions,
  trackReconciledSessions,
} from "./mirror-writes";
/** Machines are the backend (ADR 0003). Each registry endpoint supplies
 * validated event pages and independent quotas. The phone stores per-machine
 * scan-start cursors, atomically commits page continuation, and periodically
 * reconciles full history to pick up old parser/pricing corrections. */
import {
  DAY_DIGESTS_CAPABILITY,
  LIVE_OVERLAP_MS,
  earliestChangedDayMs,
  httpLiveApiFor,
  validateLiveApi,
  LiveError,
  type LiveApi,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { invalidateEventCache } from "../data/repository";
import { withWriteLock } from "./writelock";
import { syncGeneration, publishMirrorChange, publishPullProgress } from "./sync-state";
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
  /** From the latest /ping; gates opt-in controls such as power mode. */
  capabilities?: string[];
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
  /** When a machine answers with an older cached quota reading (it refreshes
   * behind the response), ask once more after this delay. Off by default. */
  quotaFollowUpMs?: number;
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

/** Last advertised /ping capabilities (JSON array), so opt-in controls still
 * render — in their offline state — when a machine is unreachable at launch. */
export function capabilitiesKey(envId: string): string {
  return `direct_caps_${envId}`;
}

function legacyCursorKey(envId: string): string {
  return `direct_since_${envId}`;
}

/** Content hash of the snapshot the last completed full reconciliation
 * downloaded. Unlike the incremental hash, it proves this phone holds that
 * snapshot's whole history, so an identical snapshot needs no re-download. */
function fullHashKey(envId: string): string {
  return `direct_full_hash_${envId}`;
}

/** Per-UTC-day digests of the snapshot the last completed reconciliation
 * brought this phone level with (JSON `{[day]: digest}`); `pending` holds
 * the digests of the snapshot a reconciliation in progress is downloading. */
function digestsKey(envId: string, pending = false): string {
  return `direct_digests_${pending ? "pending_" : ""}${envId}`;
}

/** Machine clocks within this of the phone's are taken at their word. */
const QUOTA_SKEW_TOLERANCE_MS = 60_000;

/**
 * When a quota was read, as the timestamp to store. A reading the source
 * served from its own cache keeps its real collection time (never later than
 * the page). Quotas are account-level and the freshest reading across
 * machines wins, so timestamps from different machines must be comparable: a
 * machine whose clock is off by more than the tolerance (a dual-boot box that
 * booted with local-time RTC) has its reading moved onto the phone's clock,
 * or its "future" reading would outrank every correct machine's.
 */
function quotaCollectedAt(
  quota: { fetchedAt?: string | null },
  generatedAt: string,
  machineAheadMs: number,
): string {
  const source =
    quota.fetchedAt && Date.parse(quota.fetchedAt) < Date.parse(generatedAt) ? quota.fetchedAt : generatedAt;
  return Math.abs(machineAheadMs) > QUOTA_SKEW_TOLERANCE_MS
    ? new Date(Date.parse(source) - machineAheadMs).toISOString()
    : source;
}

/** Set when a machine reports a different tokscale pin; a parser change can
 * re-key or reprice old rows, so it forces full reconciliation until one
 * completes. */
function reparseKey(envId: string): string {
  return `direct_reparse_${envId}`;
}

/** Event rows name their parser `tokscale-<pin>`; /ping reports the bare pin. */
function pinParser(pin: string): string {
  return `tokscale-${pin}`;
}

/** Caller owns the transaction and runs this before storing the ping's
 * tokscale version, so the comparison sees the previously stored pin. */
async function notePinChange(
  db: SQLiteDatabase,
  envId: string,
  reported: string | null,
): Promise<void> {
  if (reported === null) return;
  const previous = await db.getFirstAsync<{ v: string | null }>(
    "select tokscale_version as v from environments where id=?",
    [envId],
  );
  if (previous !== null && previous.v !== reported)
    await kvSetString(db, reparseKey(envId), reported);
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

/** The reporter's default port; `burn-report daemon --port` overrides it. */
export const DEFAULT_REPORTER_PORT = 8787;

/**
 * What people type is a machine name or a tailnet address, not a URL:
 * `cachyos` and `100.101.102.103` mean plain HTTP on the reporter port, and
 * `cachyos:9000` plain HTTP on that one. Anything with a scheme is a full URL
 * and is kept exactly as written.
 */
export function normalizeMachineUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new LiveError("enter the machine's name or address");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed))
    throw new LiveError("machine URL must start with http:// or https://");
  const url = hasScheme ? trimmed : `http://${trimmed}`;
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#\s]+)(:\d+)?([/?#].*)?$/i.exec(url);
  if (!match) throw new LiveError(`"${raw.trim()}" is not a machine name, address or URL`);
  const [, scheme, host, port, rest] = match;
  void scheme;
  if (!hasScheme && !port && !rest) return `http://${host}:${DEFAULT_REPORTER_PORT}`;
  return url;
}

export interface DiscoveredMachine {
  url: string;
  slug: string;
  displayName: string;
  osKind: string;
}

/**
 * Other reporters on the tailnet that are not registered yet, as reported by
 * the machines that are (ADR 0005). Best effort and read-only: unreachable
 * machines and reporters without the endpoint simply contribute nothing.
 */
export async function discoverPeerMachines(
  db: SQLiteDatabase,
  options: { timeoutMs?: number; apiFor?: (endpoint: string) => LiveApi } = {},
): Promise<DiscoveredMachine[]> {
  const registered = await listDirectMachines(db);
  const known = new Set(registered.map((machine) => machine.slug));
  const lists = await Promise.all(
    registered.map(async (machine) => {
      const api = validateLiveApi(
        options.apiFor ? options.apiFor(machine.baseUrl) : httpLiveApiFor(machine.baseUrl, fetch),
      );
      if (!api.peers) return [];
      const timeout = withTimeout(undefined, options.timeoutMs ?? 4_000);
      try {
        return (await api.peers(timeout.signal)).peers;
      } catch {
        return [];
      } finally {
        timeout.cancel();
      }
    }),
  );
  const found = new Map<string, DiscoveredMachine>();
  for (const peer of lists.flat()) if (!known.has(peer.slug) && !found.has(peer.slug)) found.set(peer.slug, peer);
  return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
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
  const base = normalizeMachineUrl(rawUrl);
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
      // Re-adding a cached machine must not absorb a pin change silently.
      await notePinChange(db, id, ping.tokscaleVersion);
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
        fullHashKey(environmentId),
        digestsKey(environmentId),
        digestsKey(environmentId, true),
        reparseKey(environmentId),
        capabilitiesKey(environmentId),
      ])
        await kvDelete(db, key);
      await forgetReconciliation(db, environmentId);
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

/** One pass over the registered machines (or the continuation's pending
 * ones): ping, then quotas, health and paged events in parallel per machine.
 * Event windows pick incremental or full reconciliation (pin change, first
 * sync, clock rollback, daily) and checkpoint progress page by page. */
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

  publishPullProgress(db, { kind: "begin", machines: machines.map((machine) => machine.id) });
  const statuses = await Promise.all(
    machines.map((machine) => (async (): Promise<DirectPullStatus> => {
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
        const skewMs = ping.serverNowMs - now();
        const clockSkewMs = Math.abs(skewMs);
        base.capabilities = ping.capabilities ?? [];
        base.initialSyncComplete = (await kvGetNumber(db, cursorKey(machine.id))) !== null;

        await withWriteLock(async () => {
          assertActive();
          await db.withTransactionAsync(async () => {
            await db.runAsync(
              "update direct_machines set last_ping_at=?,last_error=null where id=?",
              [new Date(now()).toISOString(), machine.id],
            );
            await notePinChange(db, machine.id, ping.tokscaleVersion);
            await kvSetString(db, capabilitiesKey(machine.id), JSON.stringify(ping.capabilities ?? []));
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
            // The reporter may answer with its last reading and refresh behind
            // the response; collect the fresh one without holding this pass.
            const followUpMs = options.quotaFollowUpMs;
            if (followUpMs !== undefined && ping.serverNowMs - Date.parse(page.generatedAt) > 60_000)
              void (async () => {
                await new Promise((resolve) => setTimeout(resolve, followUpMs));
                assertActive();
                const again = withTimeout(probeSignal, options.quotaTimeoutMs ?? 45_000);
                try {
                  const fresh = await api.quotas(again.signal);
                  await withWriteLock(async () => {
                    assertActive();
                    await db.withTransactionAsync(async () => {
                      for (const quota of fresh.quotas) {
                        await mergeQuota(
                          db, machine.id, quota,
                          quotaCollectedAt(quota, fresh.generatedAt, skewMs),
                          now() + QUOTA_SKEW_TOLERANCE_MS,
                        );
                        assertActive();
                      }
                    });
                  });
                  publishMirrorChange(db, "quotas");
                } finally {
                  again.cancel();
                }
              })().catch(() => {});
            let quotaError: string | null = null;
            await withWriteLock(async () => {
              assertActive();
              await db.withTransactionAsync(async () => {
                for (const quota of page.quotas) {
                  await mergeQuota(
                    db, machine.id, quota,
                    quotaCollectedAt(quota, page.generatedAt, skewMs),
                    now() + QUOTA_SKEW_TOLERANCE_MS,
                  );
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
            // Samples are immutable per capture instant, so request only the
            // newest stored sample onward. A machine clock rollback reloads the day.
            const windowStart = Math.max(0, now() - 86_400_000);
            const newest =
              (
                await db.getFirstAsync<{ at: number | null }>(
                  "select max(captured_at_ms) as at from machine_metrics where environment_id=?",
                  [machine.id],
                )
              )?.at ?? null;
            const rolledBack = newest !== null && newest > ping.serverNowMs;
            const since =
              newest !== null && newest > windowStart && !rolledBack
                ? newest
                : windowStart;
            const page = await api.metrics(since, timeout.signal);
            const count = await withWriteLock(async () => {
              assertActive();
              let changed = 0;
              await db.withTransactionAsync(async () => {
                changed = await mergeMetrics(
                  db, machine.id, page.metrics, now(), assertActive,
                  rolledBack ? ping.serverNowMs : null,
                );
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
          const pendingPin =
            (await db.getFirstAsync<{ value: string }>(
              "select value from kv where key=?",
              [reparseKey(machine.id)],
            ))?.value ?? null;
          const reparse = pendingPin !== null;
          const saved: {
            since: number;
            cursor: string;
            scanStartedAtMs: number;
            snapshotId?: string;
            contentHash?: string;
            reconciliation: boolean;
            parserVersion?: string;
          } | null = progressRaw ? JSON.parse(progressRaw) : null;
          // After a pin change only a completed reconciliation retires re-keyed
          // rows. Full history covers any unfinished incremental window, so
          // that window restarts as the reconciliation instead of finishing
          // first; so does a reconciliation that was parsing an older pin.
          // A machine clock set back below the checkpoint invalidates a saved
          // incremental window too: its `since` was taken on the wrong clock,
          // so resuming it would skip everything recorded since the correction.
          const rolledBack = stored !== null && ping.serverNowMs < stored;
          const progress =
            (reparse &&
              (saved?.reconciliation === false ||
                (saved?.parserVersion !== undefined && saved.parserVersion !== pinParser(pendingPin)))) ||
            (rolledBack && saved?.reconciliation === false)
              ? null
              : saved;
          const lastFull = await kvGetNumber(
            db,
            `direct_full_at_${machine.id}`,
          );
          const reconciliation =
            progress?.reconciliation ??
            (options.full === true ||
              reparse ||
              rolledBack ||
              stored === null ||
              lastFull === null ||
              now() < lastFull ||
              now() - lastFull >= 86_400_000);
          // A reconciliation need not re-download days the machine has not
          // touched. The machine lists a digest per UTC day; the days this
          // phone already holds at the same digest are skipped by starting
          // the window at the earliest day that differs. An explicit full
          // refresh, a parser change, a clock rollback and a first sync still
          // start from zero. The digests are fetched either way, to be kept
          // once this reconciliation completes.
          let digestSince: number | null = null;
          if (
            reconciliation &&
            !progress &&
            api.digests &&
            ping.capabilities?.includes(DAY_DIGESTS_CAPABILITY)
          ) {
            const timeout = withTimeout(probeSignal, options.eventsTimeoutMs ?? 120_000);
            try {
              const listed = await api.digests(timeout.signal);
              assertActive();
              const heldRaw = (
                await db.getFirstAsync<{ value: string }>("select value from kv where key=?", [
                  digestsKey(machine.id),
                ])
              )?.value;
              const held: Record<string, string> | null = heldRaw ? JSON.parse(heldRaw) : null;
              if (!options.full && !reparse && !rolledBack && stored !== null && held !== null)
                digestSince = earliestChangedDayMs(held, listed.days);
              await withWriteLock(async () => {
                assertActive();
                await kvSetString(
                  db,
                  digestsKey(machine.id, true),
                  JSON.stringify({ snapshotId: listed.snapshotId, days: Object.fromEntries(listed.days) }),
                );
              });
            } catch (err) {
              assertActive();
              // Digests only save work; without them the window is the whole history.
              digestSince = null;
              await withWriteLock(async () => {
                assertActive();
                await kvDelete(db, digestsKey(machine.id, true));
              });
              if (!(err instanceof LiveError)) throw err;
            } finally {
              timeout.cancel();
            }
          }
          const since =
            progress?.since ??
            (reconciliation ? (digestSince ?? 0) : Math.max(0, stored! - LIVE_OVERLAP_MS));
          const hashKey = `direct_hash_${machine.id}`;
          const oldHash = options.full
            ? null
            : (
                await db.getFirstAsync<{ value: string }>(
                  "select value from kv where key=?",
                  [hashKey],
                )
              )?.value;
          const fullHash =
            reconciliation && !options.full && !reparse && !progress
              ? (
                  await db.getFirstAsync<{ value: string }>(
                    "select value from kv where key=?",
                    [fullHashKey(machine.id)],
                  )
                )?.value
              : undefined;
          let cursor = progress?.cursor;
          let scanStartedAtMs: number | null =
            progress?.scanStartedAtMs ?? null;
          let snapshotId = progress?.snapshotId;
          let contentHash = progress?.contentHash;
          // One snapshot serves the whole pass, so its rows share one parser.
          let parserVersion = progress?.parserVersion;
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
                // A reconciliation may only be skipped against the snapshot a
                // completed reconciliation already downloaded in full.
                ...(fullHash && !cursor && !restarted ? { knownHash: fullHash } : {}),
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
                // The replacement snapshot alone decides what is superseded.
                parserVersion = undefined;
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
            parserVersion = page.events[0]?.parserVersion ?? parserVersion;
            const done = !page.nextCursor;
            const firstSnapshotPage = cursor === undefined;
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
                  reconciliation,
                );
                if (reconciliation) {
                  if (firstSnapshotPage) await resetReconciledSessions(db, machine.id);
                  await trackReconciledSessions(db, machine.id, page.events);
                }
                if (done) {
                  await kvSetString(
                    db,
                    cursorKey(machine.id),
                    String(
                      rolledBack
                        ? scanStartedAtMs!
                        : Math.max(stored ?? 0, scanStartedAtMs!),
                    ),
                  );
                  if (contentHash) await kvSetString(db, hashKey, contentHash);
                  // An empty snapshot (sources unreadable, not yet scanned) proves
                  // nothing and deletes nothing: reconciliation stays pending so
                  // it reruns from full history once rows return.
                  // The machine's snapshot is byte-identical to the one this
                  // phone last reconciled: nothing to download or retire.
                  if (reconciliation && page.notModified)
                    await kvSetString(db, `direct_full_at_${machine.id}`, String(now()));
                  // Day digests describe one snapshot. They are kept only when
                  // the pages came from that same snapshot; a window that began
                  // after day zero proves the whole history only in that case.
                  const pendingRaw = reconciliation
                    ? (
                        await db.getFirstAsync<{ value: string }>("select value from kv where key=?", [
                          digestsKey(machine.id, true),
                        ])
                      )?.value
                    : undefined;
                  const pendingDigests: { snapshotId: string; days: Record<string, string> } | null =
                    pendingRaw ? JSON.parse(pendingRaw) : null;
                  const sameSnapshot = pendingDigests !== null && pendingDigests.snapshotId === snapshotId;
                  const wholeHistory = since === 0 || sameSnapshot;
                  // A window that began after day zero can be empty (a day's
                  // rows disappeared and nothing newer exists) and still be a
                  // completed reconciliation: the earlier days were verified
                  // by digest against this very snapshot.
                  const verifiedEmptyWindow = parserVersion === undefined && since > 0 && sameSnapshot;
                  if (reconciliation && verifiedEmptyWindow) await forgetReconciliation(db, machine.id);
                  if (reconciliation && (parserVersion !== undefined || verifiedEmptyWindow)) {
                    if (parserVersion !== undefined)
                      changed += await dropSupersededEvents(db, machine.id, parserVersion);
                    await kvSetString(
                      db,
                      `direct_full_at_${machine.id}`,
                      String(now()),
                    );
                    if (contentHash && wholeHistory) await kvSetString(db, fullHashKey(machine.id), contentHash);
                    else if (!wholeHistory) await kvDelete(db, fullHashKey(machine.id));
                    if (sameSnapshot)
                      await kvSetString(db, digestsKey(machine.id), JSON.stringify(pendingDigests!.days));
                    // A re-registration may have recorded a newer pin while this
                    // pass ran; only the pin this snapshot parsed is satisfied.
                    const pending = await db.getFirstAsync<{ value: string }>(
                      "select value from kv where key=?",
                      [reparseKey(machine.id)],
                    );
                    if (
                      parserVersion !== undefined &&
                      (pending === null || pinParser(pending.value) === parserVersion)
                    )
                      await kvDelete(db, reparseKey(machine.id));
                  }
                  if (reconciliation) await kvDelete(db, digestsKey(machine.id, true));
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
                      parserVersion,
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
    })().then((status) => {
      // Each machine settles on its own clock; the UI shows progress without
      // waiting for the slowest (usually offline) machine.
      publishPullProgress(db, { kind: "settled", environmentId: machine.id, state: status.state });
      return status;
    })),
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
