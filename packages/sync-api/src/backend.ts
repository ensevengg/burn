import type { DeltaPage, QuotaSnapshot, SyncRequestInfo } from "./types";

/**
 * The backend contract (D3). The reporter and the phone depend on these
 * interfaces only — never on supabase-js directly. The Supabase implementation
 * lives in supabase.ts; a PocketBase/self-hosted backend means a second
 * implementation of this file, nothing else.
 */

export interface BurnBackendConfig {
  /** Supabase project URL, e.g. https://xyz.supabase.co */
  url: string;
  /** Publishable (anon) key — public by design; scoping comes from tokens. */
  publishableKey: string;
}

export interface ReporterMeta {
  reporterVersion: string;
  tokscaleVersion: string | null;
  exportSchema: number | null;
  reportingTimezone: string | null;
  /**
   * Tailscale live-pull base URL (D1 v2). Omitted (undefined) preserves
   * whatever the environment last advertised; explicit null CLEARS it (the
   * machine stopped serving live). Only a process actually running the live
   * server may set a URL, so a parallel `push` can't wipe another's.
   */
  liveEndpoint?: string | null;
}

/** What the reporter sends for one usage row (pre-identity; server computes event_id). */
export interface IngestEventInput {
  client: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  sessionTitle: string | null;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  agent: string | null;
  occurredAtMs: number;
  sourceOffsetMinutes: number | null;
  sourceTimezone: string | null;
  sourceLocalDate: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  isTurnStart: boolean;
  durationMs: number | null;
  /** Decimal string — never a float on the wire. */
  cost: string;
  costSource: "unknown" | "provider_reported" | "estimated";
  costIsComplete: boolean;
  modelAttributionConflicted: boolean;
  parserVersion: string;
  dedupKey: string;
}

export interface IngestQuotaInput {
  provider: string;
  accountKey: string;
  accountLabel: string | null;
  plan: string | null;
  metric: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  creditStatus: Record<string, unknown> | null;
  spendControl: Record<string, unknown> | null;
  status: "ok" | "error";
  error: string | null;
  sourceOffsetMinutes: number | null;
}

export interface ReporterSyncApi {
  /** Prove the token + config work; refresh versions/heartbeat. */
  heartbeat(meta: ReporterMeta): Promise<{ environmentId: string; slug: string }>;
  /** Record a failure for the machine card. Never throws. */
  reportError(error: string): Promise<void>;
  ingestEvents(events: IngestEventInput[]): Promise<{ revision: number; changed: number }>;
  pushQuotaSnapshots(snapshots: IngestQuotaInput[]): Promise<{ snapshots: number }>;
  /** Resident daemon poll (D1): pending phone-requested syncs. */
  pollSyncRequests(): Promise<{ requests: SyncRequestInfo[]; latestRevision: number }>;
}

export interface MobileSyncApi {
  /** Database-global revision delta: corrected old events and every machine propagate (D5). */
  fetchDelta(sinceRevision: number, limit?: number): Promise<DeltaPage>;
  fetchQuotaLatest(): Promise<QuotaSnapshot[]>;
  /** Flip the rendezvous flag (D1); targets one environment or all. */
  requestSync(environmentId?: string): Promise<{ generation: number }>;
  /**
   * Stop managing a machine: deletes the environment row (cascading its
   * events + quotas). UI must confirm first — destructive and irreversible;
   * a machine that still exists must re-run `burn-report init` to re-pair.
   */
  removeEnvironment(environmentId: string): Promise<{ removedSlug: string }>;
}
