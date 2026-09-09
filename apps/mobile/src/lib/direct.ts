/**
 * Direct mode (ADR 0002): the machines themselves are the backend. The phone
 * keeps a registry of tailnet endpoints, and `pullDirectFromMachines` probes
 * each one and merges its event tail + quotas into the mirror.
 *
 * Relationship to the cloud path: same write lock, same generation-based
 * cancellation, same event identity (`liveEventId`), same revision-0 +
 * `WHERE usage_events.revision = 0` guard — so a machine serving BOTH modes
 * (Supabase push + live server) converges instead of forking: cloud rows
 * (revision >= 1) are authoritative; direct rows are the same rows, pulled
 * earlier. Per-machine time cursors live in kv (`direct_since_v2_<envId>`),
 * never in the cloud watermark.
 */
import {
  LIVE_OVERLAP_MS,
  httpLiveApiFor,
  parseLiveEventsPage,
  parseLiveQuotasPage,
  quotaMirrorRowKey,
  LiveError,
  type LiveApi,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { upsertProvisionalEvents } from "./mirror-write";
import { invalidateEventCache } from "../data/repository";
import { withWriteLock } from "./writelock";
import { cloudGeneration, publishMirrorChange } from "./sync-state";
import { describeFailure, withTimeout } from "./live";

export interface DirectMachine {
  id: string;
  slug: string;
  baseUrl: string;
  displayName: string;
  addedAt: string;
  lastPingAt: string | null;
  lastError: string | null;
  initialSyncComplete: boolean;
}

export interface DirectPullStatus {
  environmentId: string;
  slug: string;
  endpoint: string;
  state: "live" | "offline" | "error" | "skipped";
  pulledEvents: number;
  pulledQuotas: number;
  quotaError: string | null;
  clockSkewMs: number | null;
  error: string | null;
  elapsedMs: number;
  initialSyncComplete: boolean;
}

export interface DirectPullOptions {
  pingTimeoutMs?: number;
  eventsTimeoutMs?: number;
  quotaTimeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Test seam. */
  apiFor?: (endpoint: string) => LiveApi;
  now?: () => number;
}

const inFlight = new WeakMap<SQLiteDatabase, Promise<DirectPullStatus[]>>();
const inFlightController = new WeakMap<SQLiteDatabase, AbortController>();

export function directEnvId(slug: string): string {
  return `direct-${slug}`;
}

function cursorKey(envId: string): string {
  // v1 could mark a recent-tail response as a completed initial backfill.
  // Versioning forces one corrective full pull for those installations.
  return `direct_since_v2_${envId}`;
}

function legacyCursorKey(envId: string): string {
  return `direct_since_${envId}`;
}

function generationKey(envId: string): string {
  return `direct_generation_v1_${envId}`;
}

async function kvGetNumber(db: SQLiteDatabase, key: string): Promise<number | null> {
  const row = await db.getFirstAsync<{ value: string }>("select value from kv where key = ?", [key]);
  const parsed = row === null ? NaN : Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function kvGetString(db: SQLiteDatabase, key: string): Promise<string | null> {
  return (await db.getFirstAsync<{ value: string }>("select value from kv where key = ?", [key]))?.value ?? null;
}

async function kvSetString(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync("insert or replace into kv (key, value) values (?, ?)", [key, value]);
}

async function kvDelete(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync("delete from kv where key = ?", [key]);
}

async function pullDirectQuotas(
  db: SQLiteDatabase,
  machine: DirectMachine,
  api: LiveApi,
  signal: AbortSignal,
  assertActive: () => void,
  timeoutMs: number,
): Promise<number> {
  const timeout = withTimeout(signal, timeoutMs);
  let page;
  try {
    page = parseLiveQuotasPage(await api.quotas(timeout.signal));
  } finally {
    timeout.cancel();
  }
  if (page.quotas.length === 0) return 0;

  let changed = 0;
  await withWriteLock(async () => {
    assertActive();
    await db.withTransactionAsync(async () => {
      for (const quota of page.quotas) {
        const result = await db.runAsync(
          `insert into quota_snapshots
             (row_key, environment_id, provider, account_key, account_label, plan, metric,
              used_percent, remaining_percent, remaining_label, resets_at, status, error, fetched_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (row_key) do update set
             account_label = excluded.account_label, plan = excluded.plan,
             used_percent = excluded.used_percent,
             remaining_percent = excluded.remaining_percent,
             remaining_label = excluded.remaining_label, resets_at = excluded.resets_at,
             status = excluded.status, error = excluded.error,
             fetched_at = excluded.fetched_at
           where quota_snapshots.account_label is not excluded.account_label or
             quota_snapshots.plan is not excluded.plan or
             quota_snapshots.used_percent is not excluded.used_percent or
             quota_snapshots.remaining_percent is not excluded.remaining_percent or
             quota_snapshots.remaining_label is not excluded.remaining_label or
             quota_snapshots.resets_at is not excluded.resets_at or
             quota_snapshots.status is not excluded.status or
             quota_snapshots.error is not excluded.error or
             quota_snapshots.fetched_at is not excluded.fetched_at`,
          [
            quotaMirrorRowKey(machine.id, quota.provider, quota.accountKey, quota.metric),
            machine.id,
            quota.provider,
            quota.accountKey,
            quota.accountLabel,
            quota.plan,
            quota.metric,
            quota.usedPercent,
            quota.remainingPercent,
            quota.remainingLabel,
            quota.resetsAt,
            quota.status,
            quota.error,
            page.generatedAt,
          ],
        );
        changed += result.changes;
      }
    });
  });
  if (changed > 0) publishMirrorChange(db, "quotas");
  return page.quotas.length;
}

export async function listDirectMachines(db: SQLiteDatabase): Promise<DirectMachine[]> {
  const rows = await db.getAllAsync<{
    id: string;
    slug: string;
    base_url: string;
    display_name: string;
    added_at: string;
    last_ping_at: string | null;
    last_error: string | null;
    initial_sync_complete: number;
  }>(`select d.*,
          exists(select 1 from kv where key = 'direct_since_v2_' || d.id) as initial_sync_complete
       from direct_machines d order by d.added_at`);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    baseUrl: r.base_url,
    displayName: r.display_name,
    addedAt: r.added_at,
    lastPingAt: r.last_ping_at,
    lastError: r.last_error,
    initialSyncComplete: Number(r.initial_sync_complete) === 1,
  }));
}

/**
 * Validate an endpoint with /ping and register it. The environment id reuses
 * an existing cloud environment row with the same slug when one exists, so
 * running both modes for one machine attributes events to a single machine
 * card instead of duplicating it.
 */
export async function addDirectMachine(
  db: SQLiteDatabase,
  rawUrl: string,
  options: { pingTimeoutMs?: number; apiFor?: (endpoint: string) => LiveApi; now?: () => number } = {},
): Promise<{ id: string; slug: string; displayName: string }> {
  const base = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new LiveError("machine URL must start with http:// or https://");
  const now = options.now ?? Date.now;
  const pingTimeout = withTimeout(undefined, options.pingTimeoutMs ?? 3_000);
  const api = options.apiFor ? options.apiFor(base) : httpLiveApiFor(base, fetch);
  let ping;
  try {
    ping = await api.ping(pingTimeout.signal);
  } catch (err) {
    throw new LiveError(`no answer from ${base}: ${(err as Error).message}`);
  } finally {
    pingTimeout.cancel();
  }
  if (ping.slug.trim().length === 0) throw new LiveError("machine reported an empty slug");

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
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `insert into direct_machines (id, slug, base_url, display_name, added_at, last_ping_at, last_error)
         values (?, ?, ?, ?, ?, ?, null)
         on conflict (id) do update set
           base_url = excluded.base_url, display_name = excluded.display_name,
           last_ping_at = excluded.last_ping_at, last_error = null`,
        [id, ping.slug, base, ping.displayName, new Date(now()).toISOString(), new Date(now()).toISOString()],
      );
      // The card exists immediately, even before the first pull.
      await db.runAsync(
        `insert into environments
           (id, slug, display_name, host_group, os_kind, reporter_version, tokscale_version,
            export_schema, reporting_timezone, last_heartbeat_at, last_success_at, last_error, latest_revision, live_endpoint)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, 0, ?)
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
    });
    invalidateEventCache(db);
  });
  publishMirrorChange(db, "machines");
  return { id, slug: ping.slug, displayName: ping.displayName };
}

/** Registry removal + local data cascade (nothing server-side exists here). */
export async function removeDirectMachine(db: SQLiteDatabase, environmentId: string): Promise<void> {
  await withWriteLock(async () => {
    await db.withTransactionAsync(async () => {
      await db.runAsync("delete from direct_machines where id = ?", [environmentId]);
      await db.runAsync("delete from usage_events where environment_id = ?", [environmentId]);
      await db.runAsync("delete from quota_snapshots where environment_id = ?", [environmentId]);
      await db.runAsync("delete from environments where id = ?", [environmentId]);
      await db.runAsync("delete from kv where key = ?", [cursorKey(environmentId)]);
      await db.runAsync("delete from kv where key = ?", [legacyCursorKey(environmentId)]);
      await db.runAsync("delete from kv where key = ?", [generationKey(environmentId)]);
    });
    invalidateEventCache(db);
  });
  publishMirrorChange(db, "machines");
}

/**
 * Probe every registered machine and merge its tail. Same concurrency and
 * cancellation contract as the cloud-path live pull: concurrent calls share
 * the active probe, and reset/disconnect invalidates it before any commit.
 */
export function pullDirectFromMachines(
  db: SQLiteDatabase,
  options: DirectPullOptions = {},
): Promise<DirectPullStatus[]> {
  const existing = inFlight.get(db);
  if (existing !== undefined) return existing;
  const generation = cloudGeneration(db);
  const internal = new AbortController();
  inFlightController.set(db, internal);
  const relayCaller = () => internal.abort(new Error("cancelled"));
  const callerSignal = options.signal;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) relayCaller();
    else callerSignal.addEventListener("abort", relayCaller, { once: true });
  }
  const assertActive = (): void => {
    if (cloudGeneration(db) !== generation) throw new LiveError("direct pull cancelled");
  };
  const pending = pullDirectUnlocked(db, options, internal.signal, assertActive)
    .finally(() => {
      callerSignal?.removeEventListener("abort", relayCaller);
      if (inFlight.get(db) === pending) {
        inFlight.delete(db);
        inFlightController.delete(db);
      }
    });
  inFlight.set(db, pending);
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
  const machines = await listDirectMachines(db);
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
        quotaError: null,
        clockSkewMs: null,
        error: null,
        elapsedMs: 0,
        initialSyncComplete: machine.initialSyncComplete,
      };
      const api = options.apiFor
        ? options.apiFor(machine.baseUrl)
        : httpLiveApiFor(machine.baseUrl, options.fetchImpl ?? fetch);
      let quotaPromise: Promise<{ count: number; error: string | null }> = Promise.resolve({ count: 0, error: null });
      try {
        const pingTimeout = withTimeout(probeSignal, options.pingTimeoutMs ?? 2_500);
        let ping;
        try {
          ping = await api.ping(pingTimeout.signal);
        } finally {
          pingTimeout.cancel();
        }
        assertActive();
        if (ping.slug !== machine.slug) {
          return {
            ...base,
            state: "skipped",
            error: `endpoint answered as "${ping.slug}", expected "${machine.slug}"`,
            elapsedMs: now() - started,
          };
        }
        const clockSkewMs = Math.abs(ping.serverNowMs - now());

        // Per-machine time cursor; the machine applies its own overlap. Direct
        // mode explicitly sends epoch zero on the first pull: null omits the
        // query parameter and means "use the reporter push cursor", which is
        // only the recent cloud-live tail.
        const [storedCursor, knownGeneration] = await Promise.all([
          kvGetNumber(db, cursorKey(machine.id)),
          kvGetString(db, generationKey(machine.id)),
        ]);
        const since = storedCursor === null ? 0 : Math.max(0, storedCursor - LIVE_OVERLAP_MS);

        // Quotas are independent of event export. Start the vendor request
        // before the scan so its latency is hidden behind the slower path;
        // either result can commit even when the other path fails.
        quotaPromise = pullDirectQuotas(
          db,
          machine,
          api,
          probeSignal,
          assertActive,
          options.quotaTimeoutMs ?? 15_000,
        ).then((count) => ({ count, error: null }), (err: unknown) => ({ count: 0, error: (err as Error).message }));
        const eventsTimeout = withTimeout(probeSignal, options.eventsTimeoutMs ?? 60_000);
        let eventsPage;
        try {
          eventsPage = parseLiveEventsPage(
            await api.events(since, eventsTimeout.signal, knownGeneration),
          );
        } finally {
          eventsTimeout.cancel();
        }
        assertActive();

        let changedEvents = 0;
        await withWriteLock(async () => {
          assertActive();
          await db.withTransactionAsync(async () => {
            // The machine card reflects the live ping even between pulls.
            await db.runAsync(
              `update environments set
                 reporter_version = ?, tokscale_version = ?, export_schema = ?,
                 reporting_timezone = ?, host_group = coalesce(?, host_group),
                 last_heartbeat_at = ?
               where id = ?`,
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
            changedEvents = await upsertProvisionalEvents(
              db,
              { id: machine.id, slug: machine.slug },
              eventsPage.events,
            );
            // Cursor advances only after the merge commits inside this
            // transaction — a crashed pull re-pulls its window (idempotent).
            await kvSetString(db, cursorKey(machine.id), String(now()));
            if (eventsPage.generation !== null && eventsPage.generation !== undefined) {
              await kvSetString(db, generationKey(machine.id), eventsPage.generation);
            }
          });
          if (changedEvents > 0) invalidateEventCache(db);
        });
        if (changedEvents > 0) publishMirrorChange(db, "events");

        const quotaResult = await quotaPromise;
        assertActive();

        return {
          ...base,
          pulledEvents: eventsPage.events.length,
          pulledQuotas: quotaResult.count,
          quotaError: quotaResult.error,
          clockSkewMs,
          elapsedMs: now() - started,
          initialSyncComplete: true,
        };
      } catch (err) {
        await quotaPromise;
        assertActive();
        const failure = describeFailure(err);
        return { ...base, ...failure, elapsedMs: now() - started };
      }
    }),
  );
  assertActive();
  await withWriteLock(async () => {
    await db.withTransactionAsync(async () => {
      for (const status of statuses) {
        const checkedAt = new Date(now()).toISOString();
        const error = status.state === "live" ? status.quotaError : status.error;
        await db.runAsync(
          "update direct_machines set last_ping_at = ?, last_error = ? where id = ?",
          [checkedAt, error, status.environmentId],
        );
        await db.runAsync(
          `update environments set last_heartbeat_at = ?,
             last_success_at = case when ? = 'live' then ? else last_success_at end,
             last_error = ? where id = ?`,
          [checkedAt, status.state, checkedAt, error, status.environmentId],
        );
      }
    });
  });
  publishMirrorChange(db, "machines");
  return statuses;
}
