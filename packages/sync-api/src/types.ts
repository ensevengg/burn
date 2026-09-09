/**
 * Domain types shared by the reporter and the phone.
 *
 * Money rule (D8): `cost` is a decimal string everywhere on the wire —
 * never a float. Postgres stores it as numeric(14,6).
 */

export type OsKind = "windows" | "wsl" | "linux" | "macos";
export type CostSource = "unknown" | "provider_reported" | "estimated";

export interface EnvironmentInfo {
  id: string;
  slug: string;
  displayName: string;
  hostGroup: string | null;
  osKind: OsKind;
  reporterVersion: string | null;
  tokscaleVersion: string | null;
  exportSchema: number | null;
  reportingTimezone: string | null;
  lastHeartbeatAt: string | null; // ISO instant
  lastSuccessAt: string | null;
  lastError: string | null;
  latestRevision: number;
  /** Tailscale live-pull base URL advertised by the machine's heartbeat (D1 v2). */
  liveEndpoint: string | null;
}

/** A normalized per-message usage row (tokscale UnifiedMessage projection). */
export interface UsageEvent {
  eventId: string;
  environmentId: string;
  client: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  sessionTitle: string | null;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  agent: string | null;
  /** Authoritative UTC instant, epoch ms. */
  occurredAtMs: number;
  sourceOffsetMinutes: number | null;
  sourceTimezone: string | null;
  /** Audit value: the calendar day the machine saw (YYYY-MM-DD). */
  sourceLocalDate: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  isTurnStart: boolean;
  durationMs: number | null;
  /** Decimal string, e.g. "0.012345". */
  cost: string;
  costSource: CostSource;
  /** false = pricing incomplete — never render as "$0/free". */
  costIsComplete: boolean;
  modelAttributionConflicted: boolean;
  parserVersion: string;
  revision: number;
}

/** Vendor-reported quota snapshot (tokscale usage --json projection). */
export interface QuotaSnapshot {
  environmentId: string | null;
  provider: string;
  /** Stable per-account identity; "no-account" when the provider has none. */
  accountKey: string;
  accountLabel: string | null;
  plan: string | null;
  /** Window label, e.g. "session_5h", "weekly", "tokens". */
  metric: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  creditStatus: Record<string, unknown> | null;
  spendControl: Record<string, unknown> | null;
  status: "ok" | "error";
  error: string | null;
  fetchedAt: string;
  sourceOffsetMinutes: number | null;
}

export interface DeltaPage {
  /** Cursor contract version. Version 2 is database-global across machines. */
  cursorVersion: number;
  environments: EnvironmentInfo[];
  events: UsageEvent[];
  /** Greatest global sync revision present in `events`; the phone's next watermark. */
  maxRevision: number;
  hasMore: boolean;
}

export interface SyncRequestInfo {
  generation: number;
  requestedAt: string;
  targetEnvironmentId: string | null;
}
