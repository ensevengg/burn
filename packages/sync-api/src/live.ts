import type { IngestEventInput, IngestQuotaInput } from "./backend";
import type { OsKind } from "./types";

/**
 * Tailscale live-pull contract (D1 v2, docs/adr/0001-tailscale-direct-pull).
 *
 * A machine running `burn-report daemon` exposes a read-only HTTP endpoint on
 * its tailnet address. Membership in the tailnet IS the authentication — no
 * tokens cross this boundary (D7 untouched; the phone's only secret remains
 * the Supabase read token).
 *
 * The machine serves exactly what its next `push` would send: the same
 * IngestEventInput rows built by the reporter's push path (dedup fallback
 * derived, cost already a decimal string), filtered to events since its own
 * push cursor minus the overlap window. The phone merges those into its
 * mirror with revision 0, so the eventual server row (revision >= 1) wins
 * the upsert by event_id and the mirror converges — the live path can never
 * fork history.
 */

export interface LivePing {
  /** Contract version — bump on breaking shape changes. */
  protocol: 1;
  slug: string;
  displayName: string;
  hostGroup: string | null;
  osKind: OsKind;
  reporterVersion: string;
  tokscaleVersion: string | null;
  exportSchema: number | null;
  reportingTimezone: string | null;
  /** Events older than this are already in Supabase (cursor minus overlap). */
  sinceMs: number | null;
  /** Machine clock (epoch ms) — lets the phone flag gross clock skew. */
  serverNowMs: number;
}

export interface LiveEventsPage {
  sinceMs: number | null;
  generatedAt: string;
  events: IngestEventInput[];
}

export interface LiveQuotasPage {
  generatedAt: string;
  quotas: IngestQuotaInput[];
}

export interface LiveApi {
  ping(signal?: AbortSignal): Promise<LivePing>;
  /**
   * Events since the given epoch ms, or the machine's own push cursor minus
   * overlap when null. Direct mode (ADR 0002) always passes the phone's
   * per-machine cursor; the cloud-mode live pull passes null and takes the
   * machine's tail.
   */
  events(sinceMs: number | null, signal?: AbortSignal): Promise<LiveEventsPage>;
  quotas(signal?: AbortSignal): Promise<LiveQuotasPage>;
}

/** Re-send window shared by push, live pull, and direct mode: a message
 * completed just after a scan is caught by the next pull's overlap. */
export const LIVE_OVERLAP_MS = 60 * 60_000;

export class LiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveError";
  }
}

export class LiveUnreachableError extends LiveError {
  constructor(message: string) {
    super(message);
    this.name = "LiveUnreachableError";
  }
}

/**
 * Default LiveApi over HTTP. Works in Bun, Node 18+, and React Native
 * (any fetch with AbortSignal support). The URL is the machine-advertised
 * `live_endpoint` — usually `http://<tailnet-ip>:8787` or a
 * `tailscale serve` HTTPS URL.
 */
export function httpLiveApiFor(baseUrl: string, fetchImpl: typeof fetch = fetch): LiveApi {
  const base = baseUrl.replace(/\/+$/, "");
  async function call<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = { headers: { accept: "application/json" } };
      if (signal !== undefined) init.signal = signal;
      response = await fetchImpl(`${base}${path}`, init);
    } catch (err) {
      throw new LiveUnreachableError(`${base}${path}: ${(err as Error).message}`);
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* the status code is the message */
      }
      throw new LiveError(`${base}${path}: ${detail}`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new LiveError(`${base}${path}: response was not valid JSON`);
    }
  }
  return {
    ping: (signal) => call<LivePing>("/ping", signal),
    events: (sinceMs, signal) =>
      call<LiveEventsPage>(sinceMs === null ? "/live/events" : `/live/events?since=${Math.floor(sinceMs)}`, signal),
    quotas: (signal) => call<LiveQuotasPage>("/live/quotas", signal),
  };
}

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new LiveError(`${where}: expected a string`);
  return value;
}

function orNullString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function expectNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LiveError(`${where}: expected a finite number`);
  }
  return value;
}

function orNullNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** D8 guard: a decimal string, never a float in disguise. */
function expectDecimalString(value: unknown, where: string): string {
  const s = expectString(value, where);
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new LiveError(`${where}: not a decimal string`);
  return s;
}

/**
 * Structural validation for a /live/events payload. The machine is a peer,
 * not the server — the phone checks shape before anything touches the mirror.
 * Rows arrive in the reporter's IngestEventInput form; anything malformed is
 * rejected wholesale (the caller discards the page), never coerced.
 */
export function parseLiveEventsPage(raw: unknown): LiveEventsPage {
  const page = expectObject(raw, "events page");
  if (!Array.isArray(page.events)) throw new LiveError("events: expected an array");
  const events = page.events.map((row, index) => {
    const where = (field: string): string => `events[${index}].${field}`;
    const e = expectObject(row, `events[${index}]`);
    return {
      client: expectString(e.client, where("client")),
      providerId: expectString(e.providerId, where("providerId")),
      modelId: expectString(e.modelId, where("modelId")),
      sessionId: expectString(e.sessionId, where("sessionId")),
      sessionTitle: orNullString(e.sessionTitle),
      workspaceKey: orNullString(e.workspaceKey),
      workspaceLabel: orNullString(e.workspaceLabel),
      agent: orNullString(e.agent),
      occurredAtMs: expectNumber(e.occurredAtMs, where("occurredAtMs")),
      sourceOffsetMinutes: orNullNumber(e.sourceOffsetMinutes),
      sourceTimezone: orNullString(e.sourceTimezone),
      sourceLocalDate: orNullString(e.sourceLocalDate),
      inputTokens: expectNumber(e.inputTokens, where("inputTokens")),
      outputTokens: expectNumber(e.outputTokens, where("outputTokens")),
      cacheReadTokens: expectNumber(e.cacheReadTokens, where("cacheReadTokens")),
      cacheWriteTokens: expectNumber(e.cacheWriteTokens, where("cacheWriteTokens")),
      reasoningTokens: expectNumber(e.reasoningTokens, where("reasoningTokens")),
      messageCount: orNullNumber(e.messageCount) ?? 1,
      isTurnStart: e.isTurnStart === true,
      durationMs: orNullNumber(e.durationMs),
      cost: expectDecimalString(e.cost, where("cost")),
      costSource: (e.costSource ?? "unknown") as IngestEventInput["costSource"],
      costIsComplete: e.costIsComplete === true,
      modelAttributionConflicted: e.modelAttributionConflicted === true,
      parserVersion: expectString(e.parserVersion, where("parserVersion")),
      dedupKey: expectString(e.dedupKey, where("dedupKey")),
    } satisfies IngestEventInput;
  });
  return {
    sinceMs: orNullNumber(page.sinceMs),
    generatedAt: expectString(page.generatedAt, "generatedAt"),
    events,
  };
}

/**
 * Structural validation for a /live/quotas payload. Merging live quotas is a
 * documented deferral (ADR 0001) — the phone does not call this yet.
 */
export function parseLiveQuotasPage(raw: unknown): LiveQuotasPage {
  const page = expectObject(raw, "quotas page");
  if (!Array.isArray(page.quotas)) throw new LiveError("quotas: expected an array");
  const quotas: IngestQuotaInput[] = page.quotas.map((row, index) => {
    const where = (field: string): string => `quotas[${index}].${field}`;
    const q = expectObject(row, `quotas[${index}]`);
    return {
      provider: expectString(q.provider, where("provider")),
      accountKey: expectString(q.accountKey ?? "no-account", where("accountKey")),
      accountLabel: orNullString(q.accountLabel),
      plan: orNullString(q.plan),
      metric: expectString(q.metric, where("metric")),
      usedPercent: orNullNumber(q.usedPercent),
      remainingPercent: orNullNumber(q.remainingPercent),
      remainingLabel: orNullString(q.remainingLabel),
      resetsAt: orNullString(q.resetsAt),
      creditStatus: null,
      spendControl: null,
      status: q.status === "error" ? "error" : "ok",
      error: orNullString(q.error),
      sourceOffsetMinutes: orNullNumber(q.sourceOffsetMinutes),
    };
  });
  return { generatedAt: expectString(page.generatedAt, "generatedAt"), quotas };
}
