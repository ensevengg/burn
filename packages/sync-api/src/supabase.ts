import {
  object,
  identity,
  nullableString,
  integer,
  timestamp,
  nullableTimestamp,
  decimal,
  boolean,
  choice,
  nullableObject,
  nullableNumber,
} from "./validation";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  IngestEventInput,
  IngestQuotaInput,
  MobileSyncApi,
  BurnBackendConfig,
  ReporterMeta,
  ReporterSyncApi,
} from "./backend";
import type {
  DeltaCursors,
  DeltaPage,
  EnvironmentInfo,
  OsKind,
  QuotaSnapshot,
  SyncRequestInfo,
  UsageEvent,
} from "./types";

/**
 * Supabase implementation of the SyncApi (D3). This is the ONLY module in the
 * repo that may import supabase-js — the reporter and the phone go through
 * createBurnBackend().
 *
 * Wire notes: RPCs return snake_case rows (jsonb to_jsonb of the tables);
 * PostgREST serializes timestamptz as ISO strings and numeric as JSON numbers,
 * so `cost` is re-stringified on the way in and parsed leniently on the way out.
 */

export class BurnBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BurnBackendError";
  }
}

function fail(scope: string, error: { message: string } | null): never {
  throw new BurnBackendError(`${scope}: ${error?.message ?? "unknown error"}`);
}

function isoToMs(value: unknown): number {
  return Date.parse(timestamp(value, "occurred_at"));
}

function numToCostString(value: unknown): string {
  if (typeof value === "string") return decimal(value, "cost");
  if (typeof value === "number" && Number.isFinite(value))
    return decimal(value.toFixed(6), "cost");
  throw new BurnBackendError("Invalid cost");
}

function percent(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  // PostgREST may encode numeric as a number or decimal string, never coercions.
  return nullableNumber(
    typeof value === "string" ? Number(decimal(value, field)) : value,
    field,
  );
}

function orNull<T>(value: T | null | undefined): T | null {
  return value === null || value === undefined ? null : value;
}

export function parseEnvironmentRow(value: unknown): EnvironmentInfo {
  const raw = object(value, "parseEnvironmentRow");
  return {
    id: identity(raw.id, "id"),
    slug: identity(raw.slug, "slug"),
    displayName: identity(raw.display_name, "display_name"),
    hostGroup: nullableString(raw.host_group, "host_group"),
    osKind: choice(
      raw.os_kind ?? "linux",
      ["windows", "wsl", "linux", "macos"],
      "os_kind",
    ),
    reporterVersion: nullableString(raw.reporter_version, "reporter_version"),
    tokscaleVersion: nullableString(raw.tokscale_version, "tokscale_version"),
    exportSchema: nullableNumber(raw.export_schema, "export_schema"),
    reportingTimezone: nullableString(
      raw.reporting_timezone,
      "reporting_timezone",
    ),
    lastHeartbeatAt: nullableTimestamp(
      raw.last_heartbeat_at,
      "last_heartbeat_at",
    ),
    lastSuccessAt: nullableTimestamp(raw.last_success_at, "last_success_at"),
    lastError: nullableString(raw.last_error, "last_error"),
    latestRevision: integer(raw.latest_revision ?? 0, "latest_revision"),
    liveEndpoint: nullableString(raw.live_endpoint, "live_endpoint"),
  };
}

export function parseEventRow(value: unknown): UsageEvent {
  const raw = object(value, "parseEventRow");
  return {
    eventId: identity(raw.event_id, "event_id"),
    environmentId: identity(raw.environment_id, "environment_id"),
    client: identity(raw.client, "client"),
    providerId: identity(raw.provider_id, "provider_id"),
    modelId: identity(raw.model_id, "model_id"),
    sessionId: identity(raw.session_id, "session_id"),
    sessionTitle: nullableString(raw.session_title, "session_title"),
    workspaceKey: nullableString(raw.workspace_key, "workspace_key"),
    workspaceLabel: nullableString(raw.workspace_label, "workspace_label"),
    agent: nullableString(raw.agent, "agent"),
    occurredAtMs: isoToMs(raw.occurred_at),
    sourceOffsetMinutes: nullableNumber(
      raw.source_offset_minutes,
      "source_offset_minutes",
    ),
    sourceTimezone: nullableString(raw.source_timezone, "source_timezone"),
    sourceLocalDate: nullableString(raw.source_local_date, "source_local_date"),
    inputTokens: integer(raw.input_tokens, "input_tokens"),
    outputTokens: integer(raw.output_tokens, "output_tokens"),
    cacheReadTokens: integer(raw.cache_read_tokens, "cache_read_tokens"),
    cacheWriteTokens: integer(raw.cache_write_tokens, "cache_write_tokens"),
    reasoningTokens: integer(raw.reasoning_tokens, "reasoning_tokens"),
    messageCount: integer(raw.message_count ?? 1, "message_count"),
    isTurnStart: boolean(raw.is_turn_start, "is_turn_start"),
    durationMs:
      orNull(raw.duration_ms) === null
        ? null
        : integer(raw.duration_ms, "duration_ms"),
    cost: numToCostString(raw.cost),
    costSource: choice(
      raw.cost_source ?? "unknown",
      ["unknown", "provider_reported", "estimated"],
      "cost_source",
    ),
    costIsComplete: boolean(raw.cost_is_complete, "cost_is_complete"),
    modelAttributionConflicted: boolean(
      raw.model_attribution_conflicted,
      "model_attribution_conflicted",
    ),
    parserVersion: identity(raw.parser_version, "parser_version"),
    revision: integer(raw.revision, "revision"),
  };
}

export function parseQuotaRow(value: unknown): QuotaSnapshot {
  const raw = object(value, "parseQuotaRow");
  return {
    environmentId: nullableString(raw.environment_id, "environment_id"),
    provider: identity(raw.provider, "provider"),
    accountKey: identity(raw.account_key ?? "no-account", "account_key"),
    accountLabel: nullableString(raw.account_label, "account_label"),
    plan: nullableString(raw.plan, "plan"),
    metric: identity(raw.metric, "metric"),
    usedPercent: percent(raw.used_percent, "used_percent"),
    remainingPercent: percent(raw.remaining_percent, "remaining_percent"),
    remainingLabel: nullableString(raw.remaining_label, "remaining_label"),
    resetsAt: nullableTimestamp(raw.resets_at, "resets_at"),
    creditStatus: nullableObject(raw.credit_status, "credit_status"),
    spendControl: nullableObject(raw.spend_control, "spend_control"),
    status: choice(raw.status ?? "ok", ["ok", "error"], "status"),
    error: nullableString(raw.error, "error"),
    fetchedAt: timestamp(raw.fetched_at, "fetched_at"),
    sourceOffsetMinutes: nullableNumber(
      raw.source_offset_minutes,
      "source_offset_minutes",
    ),
  };
}

function eventToWire(e: IngestEventInput): Record<string, unknown> {
  return {
    client: e.client,
    provider_id: e.providerId,
    model_id: e.modelId,
    session_id: e.sessionId,
    session_title: e.sessionTitle,
    workspace_key: e.workspaceKey,
    workspace_label: e.workspaceLabel,
    agent: e.agent,
    occurred_at_ms: e.occurredAtMs,
    source_offset_minutes: e.sourceOffsetMinutes,
    source_timezone: e.sourceTimezone,
    source_local_date: e.sourceLocalDate,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    cache_read_tokens: e.cacheReadTokens,
    cache_write_tokens: e.cacheWriteTokens,
    reasoning_tokens: e.reasoningTokens,
    message_count: e.messageCount,
    is_turn_start: e.isTurnStart,
    duration_ms: e.durationMs,
    cost: e.cost,
    cost_source: e.costSource,
    cost_is_complete: e.costIsComplete,
    model_attribution_conflicted: e.modelAttributionConflicted,
    parser_version: e.parserVersion,
    dedup_key: e.dedupKey,
  };
}

function quotaToWire(q: IngestQuotaInput): Record<string, unknown> {
  return {
    provider: q.provider,
    account_key: q.accountKey,
    account_label: q.accountLabel,
    plan: q.plan,
    metric: q.metric,
    used_percent: q.usedPercent,
    remaining_percent: q.remainingPercent,
    remaining_label: q.remainingLabel,
    resets_at: q.resetsAt,
    credit_status: q.creditStatus,
    spend_control: q.spendControl,
    status: q.status,
    error: q.error,
    source_offset_minutes: q.sourceOffsetMinutes,
    export_schema: 1,
    fetched_at: q.fetchedAt ?? new Date().toISOString(),
  };
}

export interface BurnBackend {
  reporter(ingestToken: string): ReporterSyncApi;
  phone(readToken: string): MobileSyncApi;
}

export function createBurnBackend(config: BurnBackendConfig): BurnBackend {
  const client: SupabaseClient = createClient(
    config.url,
    config.publishableKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { "x-burn-schema": "1" },
        ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
      },
    },
  );

  async function rpc<T>(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, config.requestTimeoutMs ?? 30_000);
    try {
      const retryable =
        fn.startsWith("burn_fetch_") ||
        [
          "burn_heartbeat",
          "burn_ingest_events",
          "burn_complete_sync_requests",
          "burn_push_quota_snapshot",
        ].includes(fn);
      for (let attempt = 0; ; attempt++) {
        const { data, error, status } = await client
          .rpc(fn, params)
          .abortSignal(controller.signal);
        if (error === null) return data as T;
        if (
          !retryable ||
          attempt >= 2 ||
          controller.signal.aborted ||
          !(status === 0 || status === 429 || status >= 500)
        )
          fail(fn, error);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 50),
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    reporter(ingestToken: string): ReporterSyncApi {
      const token = ingestToken;
      return {
        async heartbeat(meta: ReporterMeta) {
          const meta_wire: Record<string, unknown> = {
            reporter_version: meta.reporterVersion,
            tokscale_version: meta.tokscaleVersion,
            export_schema: meta.exportSchema,
            reporting_timezone: meta.reportingTimezone,
          };
          // Undefined = "not my concern" — the server coalesce keeps whatever
          // the live-serving process last advertised.
          if (meta.liveEndpoint !== undefined)
            meta_wire.live_endpoint = meta.liveEndpoint;
          const out = await rpc<{ environment_id: string; slug: string }>(
            "burn_heartbeat",
            {
              p_ingest_token: token,
              p_meta: meta_wire,
            },
          );
          return { environmentId: out.environment_id, slug: out.slug };
        },

        async reportError(
          error: string,
          channel?: "events" | "quotas" | "heartbeat",
        ) {
          await rpc(
            channel ? "burn_report_channel_error" : "burn_report_error",
            {
              p_ingest_token: token,
              p_error: error,
              ...(channel ? { p_channel: channel } : {}),
            },
          );
        },

        async ingestEvents(events: IngestEventInput[]) {
          const out = await rpc<{ revision: number; changed: number }>(
            "burn_ingest_events",
            {
              p_ingest_token: token,
              p_events: events.map(eventToWire),
            },
          );
          return {
            revision: integer(out.revision, "revision"),
            changed: integer(out.changed, "changed"),
          };
        },

        async pushQuotaSnapshots(snapshots: IngestQuotaInput[]) {
          if (snapshots.length === 0) return { snapshots: 0 };
          const out = await rpc<{ snapshots: number }>(
            "burn_push_quota_snapshot",
            {
              p_ingest_token: token,
              p_snapshots: snapshots.map(quotaToWire),
            },
          );
          return { snapshots: integer(out.snapshots, "snapshots") };
        },

        async completeSyncRequests(generations: number[], success: boolean) {
          await rpc("burn_complete_sync_requests", {
            p_ingest_token: token,
            p_generations: generations,
            p_success: success,
          });
        },

        async pollSyncRequests() {
          const out = await rpc<{
            requests: unknown[];
            latest_revision: number;
          }>("burn_poll_sync_requests", { p_ingest_token: token });
          const requests: SyncRequestInfo[] = (out.requests ?? []).map(
            (value) => {
              const r = object(value, "sync request");
              return {
                generation: integer(r.generation, "generation"),
                requestedAt: timestamp(r.requested_at, "requested_at"),
                targetEnvironmentId: nullableString(r.target_environment),
              };
            },
          );
          return {
            requests,
            latestRevision: integer(out.latest_revision, "latest_revision"),
          };
        },
      };
    },

    phone(readToken: string): MobileSyncApi {
      const token = readToken;
      return {
        async fetchDelta(
          sinceRevision: number | DeltaCursors,
          limit?: number,
          signal?: AbortSignal,
        ): Promise<DeltaPage> {
          const modern = typeof sinceRevision !== "number";
          const out = await rpc<{
            protocol?: number;
            environments: unknown[];
            events: unknown[];
            cursors?: DeltaCursors;
            max_revision?: number;
            has_more: boolean;
          }>(
            modern ? "burn_fetch_delta_v2" : "burn_fetch_delta",
            {
              p_read_token: token,
              ...(modern
                ? { p_cursors: sinceRevision }
                : { p_since_revision: sinceRevision }),
              p_limit: limit ?? 1000,
            },
            signal,
          );
          if (modern && (out.protocol !== 2 || out.cursors === undefined)) {
            throw new BurnBackendError(
              "Invalid delta protocol; apply Supabase migrations through 0008",
            );
          }
          const cursors = modern ? parseDeltaCursors(out.cursors) : undefined;
          if (
            !Array.isArray(out.environments) ||
            !Array.isArray(out.events) ||
            typeof out.has_more !== "boolean"
          ) {
            throw new BurnBackendError("Invalid delta envelope");
          }
          return {
            environments: out.environments.map(parseEnvironmentRow),
            events: out.events.map(parseEventRow),
            ...(cursors ? { cursors } : {}),
            maxRevision: modern
              ? Math.max(0, ...Object.values(cursors!).map((c) => c.revision))
              : Number(out.max_revision ?? 0),
            hasMore: out.has_more,
          };
        },

        async fetchQuotaLatest(signal?: AbortSignal): Promise<QuotaSnapshot[]> {
          const out = await rpc<unknown[]>(
            "burn_fetch_quota_latest",
            { p_read_token: token },
            signal,
          );
          return (out ?? []).map(parseQuotaRow);
        },

        async requestSync(environmentId?: string) {
          const out = await rpc<{ generation: number }>("burn_request_sync", {
            p_read_token: token,
            p_environment: environmentId ?? null,
          });
          return { generation: integer(out.generation, "generation") };
        },

        async removeEnvironment(environmentId: string) {
          const out = await rpc<{ removed: string }>(
            "burn_remove_environment",
            {
              p_read_token: token,
              p_environment: environmentId,
            },
          );
          return { removedSlug: String(out.removed) };
        },
      };
    },
  };
}

export function parseDeltaCursors(value: unknown): DeltaCursors {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BurnBackendError("Invalid cursors");
  const cursors: DeltaCursors = {};
  for (const [envId, cursor] of Object.entries(value)) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      !("revision" in cursor) ||
      !("eventId" in cursor) ||
      !Number.isSafeInteger(cursor.revision) ||
      Number(cursor.revision) < 0 ||
      typeof cursor.eventId !== "string"
    ) {
      throw new BurnBackendError("Invalid environment cursor");
    }
    Object.defineProperty(cursors, envId, {
      value: { revision: Number(cursor.revision), eventId: cursor.eventId },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return cursors;
}
