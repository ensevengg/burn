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
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function numToCostString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(6);
  return "0.000000";
}

function orNull<T>(value: T | null | undefined): T | null {
  return value === null || value === undefined ? null : value;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseEnvironmentRow(raw: any): EnvironmentInfo {
  return {
    id: String(raw.id),
    slug: String(raw.slug),
    displayName: String(raw.display_name),
    hostGroup: orNull(raw.host_group),
    osKind: (raw.os_kind ?? "linux") as OsKind,
    reporterVersion: orNull(raw.reporter_version),
    tokscaleVersion: orNull(raw.tokscale_version),
    exportSchema: orNull(raw.export_schema),
    reportingTimezone: orNull(raw.reporting_timezone),
    lastHeartbeatAt: orNull(raw.last_heartbeat_at),
    lastSuccessAt: orNull(raw.last_success_at),
    lastError: orNull(raw.last_error),
    latestRevision: Number(raw.latest_revision ?? 0),
    liveEndpoint: orNull(raw.live_endpoint),
  };
}

export function parseEventRow(raw: any): UsageEvent {
  return {
    eventId: String(raw.event_id),
    environmentId: String(raw.environment_id),
    client: String(raw.client),
    providerId: String(raw.provider_id),
    modelId: String(raw.model_id),
    sessionId: String(raw.session_id),
    sessionTitle: orNull(raw.session_title),
    workspaceKey: orNull(raw.workspace_key),
    workspaceLabel: orNull(raw.workspace_label),
    agent: orNull(raw.agent),
    occurredAtMs: isoToMs(raw.occurred_at),
    sourceOffsetMinutes: orNull(raw.source_offset_minutes),
    sourceTimezone: orNull(raw.source_timezone),
    sourceLocalDate: orNull(raw.source_local_date),
    inputTokens: Number(raw.input_tokens ?? 0),
    outputTokens: Number(raw.output_tokens ?? 0),
    cacheReadTokens: Number(raw.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(raw.cache_write_tokens ?? 0),
    reasoningTokens: Number(raw.reasoning_tokens ?? 0),
    messageCount: Number(raw.message_count ?? 1),
    isTurnStart: Boolean(raw.is_turn_start),
    durationMs: orNull(raw.duration_ms) === null ? null : Number(raw.duration_ms),
    cost: numToCostString(raw.cost),
    costSource: (raw.cost_source ?? "unknown") as UsageEvent["costSource"],
    costIsComplete: Boolean(raw.cost_is_complete),
    modelAttributionConflicted: Boolean(raw.model_attribution_conflicted),
    parserVersion: String(raw.parser_version ?? "unknown"),
    revision: Number(raw.revision ?? 0),
  };
}

export function parseQuotaRow(raw: any): QuotaSnapshot {
  return {
    environmentId: orNull(raw.environment_id),
    provider: String(raw.provider),
    accountKey: String(raw.account_key ?? "no-account"),
    accountLabel: orNull(raw.account_label),
    plan: orNull(raw.plan),
    metric: String(raw.metric),
    usedPercent: raw.used_percent === null || raw.used_percent === undefined ? null : Number(raw.used_percent),
    remainingPercent:
      raw.remaining_percent === null || raw.remaining_percent === undefined
        ? null
        : Number(raw.remaining_percent),
    remainingLabel: orNull(raw.remaining_label),
    resetsAt: orNull(raw.resets_at),
    creditStatus: orNull(raw.credit_status),
    spendControl: orNull(raw.spend_control),
    status: raw.status === "error" ? "error" : "ok",
    error: orNull(raw.error),
    fetchedAt: String(raw.fetched_at),
    sourceOffsetMinutes: orNull(raw.source_offset_minutes),
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
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BurnBackend {
  reporter(ingestToken: string): ReporterSyncApi;
  phone(readToken: string): MobileSyncApi;
}

export function createBurnBackend(config: BurnBackendConfig): BurnBackend {
  const client: SupabaseClient = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-burn-schema": "1" } },
  });

  async function rpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, params);
    if (error !== null) fail(fn, error);
    return data as T;
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
          if (meta.liveEndpoint !== undefined) meta_wire.live_endpoint = meta.liveEndpoint;
          const out = await rpc<{ environment_id: string; slug: string }>("burn_heartbeat", {
            p_ingest_token: token,
            p_meta: meta_wire,
          });
          return { environmentId: out.environment_id, slug: out.slug };
        },

        async reportError(error: string) {
          await rpc("burn_report_error", { p_ingest_token: token, p_error: error });
        },

        async ingestEvents(events: IngestEventInput[]) {
          if (events.length === 0) return { revision: 0, changed: 0 };
          const out = await rpc<{ revision: number; changed: number }>("burn_ingest_events", {
            p_ingest_token: token,
            p_events: events.map(eventToWire),
          });
          return { revision: Number(out.revision), changed: Number(out.changed) };
        },

        async pushQuotaSnapshots(snapshots: IngestQuotaInput[]) {
          if (snapshots.length === 0) return { snapshots: 0 };
          const out = await rpc<{ snapshots: number }>("burn_push_quota_snapshot", {
            p_ingest_token: token,
            p_snapshots: snapshots.map(quotaToWire),
          });
          return { snapshots: Number(out.snapshots) };
        },

        async pollSyncRequests() {
          const out = await rpc<{ requests: unknown[]; latest_revision: number }>(
            "burn_poll_sync_requests",
            { p_ingest_token: token },
          );
          const requests: SyncRequestInfo[] = (out.requests ?? []).map((r: any) => ({
            generation: Number(r.generation),
            requestedAt: String(r.requested_at),
            targetEnvironmentId: orNull(r.target_environment),
          }));
          return { requests, latestRevision: Number(out.latest_revision ?? 0) };
        },
      };
    },

    phone(readToken: string): MobileSyncApi {
      const token = readToken;
      return {
        async fetchDelta(sinceRevision: number, limit?: number): Promise<DeltaPage> {
          const out = await rpc<{
            environments: unknown[];
            events: unknown[];
            max_revision: number;
            has_more: boolean;
          }>("burn_fetch_delta", {
            p_read_token: token,
            p_since_revision: sinceRevision,
            p_limit: limit ?? 5000,
          });
          return {
            environments: (out.environments ?? []).map(parseEnvironmentRow),
            events: (out.events ?? []).map(parseEventRow),
            maxRevision: Number(out.max_revision ?? 0),
            hasMore: Boolean(out.has_more),
          };
        },

        async fetchQuotaLatest(): Promise<QuotaSnapshot[]> {
          const out = await rpc<unknown[]>("burn_fetch_quota_latest", { p_read_token: token });
          return (out ?? []).map(parseQuotaRow);
        },

        async requestSync(environmentId?: string) {
          const out = await rpc<{ generation: number }>("burn_request_sync", {
            p_read_token: token,
            p_environment: environmentId ?? null,
          });
          return { generation: Number(out.generation) };
        },

        async removeEnvironment(environmentId: string) {
          const out = await rpc<{ removed: string }>("burn_remove_environment", {
            p_read_token: token,
            p_environment: environmentId,
          });
          return { removedSlug: String(out.removed) };
        },
      };
    },
  };
}
