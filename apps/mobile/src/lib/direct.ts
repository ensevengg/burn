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
 * earlier. Per-machine time cursors live in kv (`direct_since_<envId>`),
 * never in the cloud watermark.
 */
import {
  LIVE_OVERLAP_MS,
  httpLiveApiFor,
  liveEventId,
  parseLiveEventsPage,
  parseLiveQuotasPage,
  LiveError,
  type LiveApi,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { EVENT_WRITE_BATCH_SIZE } from "./mirror-write";
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
}

export interface DirectPullOptions {
  pingTimeoutMs?: number;
  eventsTimeoutMs?: number;
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
  return `direct_since_${envId}`;
}

async function kvGetNumber(db: SQLiteDatabase, key: string): Promise<number | null> {
  const row = await db.getFirstAsync<{ value: string }>("select value from kv where key = ?", [key]);
  const parsed = row === null ? NaN : Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function kvSetString(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync("insert or replace into kv (key, value) values (?, ?)", [key, value]);
}

async function kvDelete(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync("delete from kv where key = ?", [key]);
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
    });
    invalidateEventCache(db);
  });
  publishMirrorChange(db, "machines");
}

/**
 * Probe every registered machine and merge its tail. Same concurrency and
 * cancellation contract as the cloud-path live pull: a superseding call
 * abandons the dying one, and reset/disconnect aborts before any commit.
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
    })
    .catch((err: unknown) => {
      if (err instanceof LiveError && err.message === "direct pull cancelled") throw err;
      return [] as DirectPullStatus[];
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
        clockSkewMs: null,
        error: null,
        elapsedMs: 0,
      };
      const api = options.apiFor
        ? options.apiFor(machine.baseUrl)
        : httpLiveApiFor(machine.baseUrl, options.fetchImpl ?? fetch);
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

        // Per-machine time cursor; the machine applies its own overlap. The
        // very first pull passes null and takes the machine's full history.
        const storedCursor = await kvGetNumber(db, cursorKey(machine.id));
        const since = storedCursor === null ? null : Math.max(0, storedCursor - LIVE_OVERLAP_MS);

        // Quotas are independent of event export. Start the vendor request
        // before the scan so its latency is hidden behind the slower path;
        // failure remains best-effort and cannot discard event data.
        const quotaPromise = (async () => {
          const quotaTimeout = withTimeout(probeSignal, options.pingTimeoutMs ?? 15_000);
          try {
            return parseLiveQuotasPage(await api.quotas(quotaTimeout.signal));
          } catch {
            return null;
          } finally {
            quotaTimeout.cancel();
          }
        })();
        const eventsTimeout = withTimeout(probeSignal, options.eventsTimeoutMs ?? 60_000);
        let eventsPage;
        try {
          eventsPage = parseLiveEventsPage(await api.events(since, eventsTimeout.signal));
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
            for (let i = 0; i < eventsPage.events.length; i += EVENT_WRITE_BATCH_SIZE) {
              const chunk = eventsPage.events.slice(i, i + EVENT_WRITE_BATCH_SIZE);
              const result = await db.runAsync(
                `insert into usage_events
               (event_id, environment_id, client, provider_id, model_id, session_id, session_title,
                workspace_key, workspace_label, agent, occurred_at_ms, source_offset_minutes, source_timezone,
                source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source,
                cost_is_complete, model_attribution_conflicted, parser_version, revision)
             values ${chunk.map(() => "(" + Array(28).fill("?").join(",") + ")").join(",")}
             on conflict (event_id) do update set
               client = excluded.client, provider_id = excluded.provider_id,
               model_id = excluded.model_id, session_id = excluded.session_id,
               session_title = excluded.session_title, workspace_key = excluded.workspace_key,
               workspace_label = excluded.workspace_label, agent = excluded.agent,
               occurred_at_ms = excluded.occurred_at_ms,
               source_offset_minutes = excluded.source_offset_minutes,
               source_timezone = excluded.source_timezone,
               source_local_date = excluded.source_local_date,
               input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
               cache_read_tokens = excluded.cache_read_tokens,
               cache_write_tokens = excluded.cache_write_tokens,
               reasoning_tokens = excluded.reasoning_tokens,
               message_count = excluded.message_count, is_turn_start = excluded.is_turn_start,
               duration_ms = excluded.duration_ms, cost = excluded.cost,
               cost_source = excluded.cost_source, cost_is_complete = excluded.cost_is_complete,
               model_attribution_conflicted = excluded.model_attribution_conflicted,
               parser_version = excluded.parser_version, revision = excluded.revision
             where usage_events.revision = 0 and (
               usage_events.client is not excluded.client or
               usage_events.provider_id is not excluded.provider_id or
               usage_events.model_id is not excluded.model_id or
               usage_events.session_id is not excluded.session_id or
               usage_events.session_title is not excluded.session_title or
               usage_events.workspace_key is not excluded.workspace_key or
               usage_events.workspace_label is not excluded.workspace_label or
               usage_events.agent is not excluded.agent or
               usage_events.occurred_at_ms is not excluded.occurred_at_ms or
               usage_events.source_offset_minutes is not excluded.source_offset_minutes or
               usage_events.source_timezone is not excluded.source_timezone or
               usage_events.source_local_date is not excluded.source_local_date or
               usage_events.input_tokens is not excluded.input_tokens or
               usage_events.output_tokens is not excluded.output_tokens or
               usage_events.cache_read_tokens is not excluded.cache_read_tokens or
               usage_events.cache_write_tokens is not excluded.cache_write_tokens or
               usage_events.reasoning_tokens is not excluded.reasoning_tokens or
               usage_events.message_count is not excluded.message_count or
               usage_events.is_turn_start is not excluded.is_turn_start or
               usage_events.duration_ms is not excluded.duration_ms or
               usage_events.cost is not excluded.cost or
               usage_events.cost_source is not excluded.cost_source or
               usage_events.cost_is_complete is not excluded.cost_is_complete or
               usage_events.model_attribution_conflicted is not excluded.model_attribution_conflicted or
               usage_events.parser_version is not excluded.parser_version
             )`,
                chunk.flatMap((e) => [
                  liveEventId(machine.slug, e.client, e.dedupKey),
                  machine.id,
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
                  0,
                ]),
              );
              changedEvents += result.changes;
            }
            // Cursor advances only after the merge commits inside this
            // transaction — a crashed pull re-pulls its window (idempotent).
            await kvSetString(db, cursorKey(machine.id), String(now()));
          });
          if (changedEvents > 0) invalidateEventCache(db);
        });
        if (changedEvents > 0) publishMirrorChange(db, "events");

        // Quotas: env-scoped upsert only — never touches other machines'
        // rows, so the cloud path's wholesale replace stays impossible here.
        let pulledQuotas = 0;
        const quotaPage = await quotaPromise;
        if (quotaPage !== null && quotaPage.quotas.length > 0) {
          let changedQuotas = 0;
          await withWriteLock(async () => {
            assertActive();
            await db.withTransactionAsync(async () => {
              for (const q of quotaPage.quotas) {
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
                    `${machine.id}|${q.provider}|${q.accountKey}|${q.metric}`,
                    machine.id,
                    q.provider,
                    q.accountKey,
                    q.accountLabel,
                    q.plan,
                    q.metric,
                    q.usedPercent,
                    q.remainingPercent,
                    q.remainingLabel,
                    q.resetsAt,
                    q.status,
                    q.error,
                    quotaPage.generatedAt,
                  ],
                );
                changedQuotas += result.changes;
              }
            });
          });
          pulledQuotas = quotaPage.quotas.length;
          if (changedQuotas > 0) publishMirrorChange(db, "quotas");
        }

        return {
          ...base,
          pulledEvents: eventsPage.events.length,
          pulledQuotas,
          clockSkewMs,
          elapsedMs: now() - started,
        };
      } catch (err) {
        assertActive();
        const failure = describeFailure(err);
        return { ...base, ...failure, elapsedMs: now() - started };
      }
    }),
  );
  return statuses;
}
