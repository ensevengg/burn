import {
  object as expectObject,
  string as expectString,
  nullableString as orNullString,
  number as expectNumber,
  nullableNumber as orNullNumber,
  decimal as expectDecimalString,
  integer,
  timestamp,
  nullableTimestamp,
  nullableObject,
  boolean,
  choice,
  identity,
} from "./validation";
import type { MachineEventInput, MachineQuotaInput } from "./payloads";
import type { OsKind } from "./types";

/** Read-only machine transport over the user's tailnet. Tailscale membership
 * authorizes access. Every response is schema-validated before phone writes;
 * the phone owns scan-start cursors, paged continuation and reconciliation. */

export interface LivePing {
  capabilities?: string[];
  ready?: boolean;
  scanAgeMs?: number | null;
  eventCount?: number;
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
  /** Earliest available event window; machine backends expose full history. */
  sinceMs: number | null;
  /** Machine clock (epoch ms) — lets the phone flag gross clock skew. */
  serverNowMs: number;
}

export interface LiveEventsPage {
  slug?: string;
  scanStartedAtMs?: number;
  scanMs?: number;
  snapshotId?: string;
  contentHash?: string;
  nextCursor?: string | null;
  notModified?: boolean;
  sinceMs: number | null;
  generatedAt: string;
  events: MachineEventInput[];
}

export interface LiveQuotasPage {
  generatedAt: string;
  quotas: MachineQuotaInput[];
}

export interface LivePageRequest {
  limit?: number;
  cursor?: string;
  knownHash?: string;
  force?: boolean;
}

export interface LiveApi {
  ping(signal?: AbortSignal): Promise<LivePing>;
  /** Events since epoch ms; null starts at full history. */
  events(
    sinceMs: number | null,
    signal?: AbortSignal,
    page?: LivePageRequest,
  ): Promise<LiveEventsPage>;
  quotas(signal?: AbortSignal): Promise<LiveQuotasPage>;
}

type LiveTransport = {
  [K in keyof LiveApi]: (...args: Parameters<LiveApi[K]>) => Promise<unknown>;
};
const validatedApis = new WeakSet<LiveApi>();
/** One schema gate per transport response, including injected adapters. An
 * HTTP adapter already wrapped here is reused by the mobile drivers. */
export function validateLiveApi(transport: LiveTransport): LiveApi {
  if (validatedApis.has(transport as LiveApi)) return transport as LiveApi;
  const api: LiveApi = {
    ping: async (...args) => parseLivePing(await transport.ping(...args)),
    events: async (...args) =>
      parseLiveEventsPage(await transport.events(...args)),
    quotas: async (...args) =>
      parseLiveQuotasPage(await transport.quotas(...args)),
  };
  validatedApis.add(api);
  return api;
}

/** Re-send window: a message
 * completed just after a scan is caught by the next pull's overlap. */
export const LIVE_OVERLAP_MS = 60 * 60_000;

export class LiveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
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
export function httpLiveApiFor(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): LiveApi {
  const base = baseUrl.replace(/\/+$/, "");
  async function call(
    path: string,
    signal?: AbortSignal,
    knownHash?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "accept-encoding": "gzip",
      };
      if (knownHash) headers["if-none-match"] = `"${knownHash}"`;
      response = await fetchImpl(`${base}${path}`, {
        headers,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new LiveUnreachableError(
        `${base}${path}: ${(err as Error).message}`,
      );
    }
    if (response.status === 304) {
      return {
        events: [],
        sinceMs: null,
        generatedAt: response.headers.get("x-generated-at"),
        scanStartedAtMs: Number(response.headers.get("x-scan-started-at-ms")),
        slug: response.headers.get("x-burn-slug"),
        contentHash: response.headers
          .get("etag")
          ?.replace(/^W\//, "")
          .replaceAll('"', ""),
        notModified: true,
      };
    }
    const length = Number(response.headers.get("content-length"));
    if (length > 16_000_000)
      throw new LiveError("Live response exceeds the size limit");
    const text = await response.text();
    if (text.length > 16_000_000)
      throw new LiveError("Decoded live response exceeds the size limit");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LiveError(`${base}${path}: response was not valid JSON`);
    }
    if (!response.ok) {
      const error = expectObject(body, "error");
      throw new LiveError(
        `${base}${path}: ${typeof error.error === "string" ? error.error : `HTTP ${response.status}`}`,
        response.status,
      );
    }
    return body;
  }
  return validateLiveApi({
    ping: async (signal) => call("/ping", signal),
    events: async (sinceMs, signal, page = {}) => {
      const params = new URLSearchParams();
      if (sinceMs !== null) params.set("since", String(Math.floor(sinceMs)));
      if (page.limit !== undefined) params.set("limit", String(page.limit));
      if (page.cursor) params.set("cursor", page.cursor);
      if (page.force) params.set("force", "1");
      return call(
        `/live/events${params.size ? `?${params}` : ""}`,
        signal,
        page.knownHash,
      );
    },
    quotas: async (signal) => call("/live/quotas", signal),
  });
}

/**
 * Structural validation for a /live/events payload. The phone checks shape
 * before anything touches the mirror.
 * Rows arrive in the reporter's MachineEventInput form; anything malformed is
 * rejected wholesale (the caller discards the page), never coerced.
 */
export function parseLiveEventsPage(raw: unknown): LiveEventsPage {
  const page = expectObject(raw, "events page");
  if (!Array.isArray(page.events))
    throw new LiveError("events: expected an array");
  const events = page.events.map((row, index) => {
    const where = (field: string): string => `events[${index}].${field}`;
    const e = expectObject(row, `events[${index}]`);
    return {
      client: identity(e.client, where("client")),
      providerId: identity(e.providerId, where("providerId")),
      modelId: identity(e.modelId, where("modelId")),
      sessionId: identity(e.sessionId, where("sessionId")),
      sessionTitle: orNullString(e.sessionTitle),
      workspaceKey: orNullString(e.workspaceKey),
      workspaceLabel: orNullString(e.workspaceLabel),
      agent: orNullString(e.agent),
      occurredAtMs: integer(e.occurredAtMs, where("occurredAtMs")),
      sourceOffsetMinutes: orNullNumber(e.sourceOffsetMinutes),
      sourceTimezone: orNullString(e.sourceTimezone),
      sourceLocalDate: orNullString(e.sourceLocalDate),
      inputTokens: integer(e.inputTokens, where("inputTokens")),
      outputTokens: integer(e.outputTokens, where("outputTokens")),
      cacheReadTokens: integer(e.cacheReadTokens, where("cacheReadTokens")),
      cacheWriteTokens: integer(e.cacheWriteTokens, where("cacheWriteTokens")),
      reasoningTokens: integer(e.reasoningTokens, where("reasoningTokens")),
      messageCount: integer(e.messageCount ?? 1, where("messageCount")),
      isTurnStart: boolean(e.isTurnStart, where("isTurnStart")),
      durationMs: orNullNumber(e.durationMs),
      cost: expectDecimalString(e.cost, where("cost")),
      costSource: choice(
        e.costSource ?? "unknown",
        ["unknown", "provider_reported", "estimated"],
        where("costSource"),
      ),
      costIsComplete: boolean(e.costIsComplete, where("costIsComplete")),
      modelAttributionConflicted: boolean(
        e.modelAttributionConflicted,
        where("modelAttributionConflicted"),
      ),
      parserVersion: identity(e.parserVersion, where("parserVersion")),
      dedupKey: identity(e.dedupKey, where("dedupKey")),
    } satisfies MachineEventInput;
  });
  return {
    ...(page.slug === undefined ? {} : { slug: identity(page.slug, "slug") }),
    ...(page.scanStartedAtMs === undefined
      ? {}
      : { scanStartedAtMs: integer(page.scanStartedAtMs, "scanStartedAtMs") }),
    ...(page.scanMs === undefined
      ? {}
      : { scanMs: expectNumber(page.scanMs, "scanMs") }),
    ...(page.snapshotId === undefined
      ? {}
      : { snapshotId: identity(page.snapshotId, "snapshotId") }),
    ...(page.contentHash === undefined
      ? {}
      : { contentHash: identity(page.contentHash, "contentHash") }),
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: orNullString(page.nextCursor) }),
    ...(page.notModified === undefined
      ? {}
      : { notModified: boolean(page.notModified, "notModified") }),
    sinceMs: orNullNumber(page.sinceMs),
    generatedAt: timestamp(page.generatedAt, "generatedAt"),
    events,
  };
}

/**
 * Structural validation for a /live/quotas payload. Direct mode merges these
 * collection-time snapshots independently of event pages.
 */
export function parseLiveQuotasPage(raw: unknown): LiveQuotasPage {
  const page = expectObject(raw, "quotas page");
  if (!Array.isArray(page.quotas))
    throw new LiveError("quotas: expected an array");
  const quotas: MachineQuotaInput[] = page.quotas.map((row, index) => {
    const where = (field: string): string => `quotas[${index}].${field}`;
    const q = expectObject(row, `quotas[${index}]`);
    return {
      provider: expectString(q.provider, where("provider")),
      accountKey: expectString(
        q.accountKey ?? "no-account",
        where("accountKey"),
      ),
      accountLabel: orNullString(q.accountLabel),
      plan: orNullString(q.plan),
      metric: expectString(q.metric, where("metric")),
      usedPercent: orNullNumber(q.usedPercent),
      remainingPercent: orNullNumber(q.remainingPercent),
      remainingLabel: orNullString(q.remainingLabel),
      resetsAt: nullableTimestamp(q.resetsAt, where("resetsAt")),
      creditStatus: nullableObject(q.creditStatus, where("creditStatus")),
      spendControl: nullableObject(q.spendControl, where("spendControl")),
      status: choice(q.status ?? "ok", ["ok", "error"], where("status")),
      error: orNullString(q.error),
      sourceOffsetMinutes: orNullNumber(q.sourceOffsetMinutes),
    };
  });
  return { generatedAt: timestamp(page.generatedAt, "generatedAt"), quotas };
}

export function parseLivePing(raw: unknown): LivePing {
  const p = expectObject(raw, "ping");
  if (p.protocol !== 1) throw new LiveError("Unsupported live protocol");
  return {
    ...(p.capabilities === undefined
      ? {}
      : {
          capabilities: Array.isArray(p.capabilities)
            ? p.capabilities.map((v) => expectString(v, "capability"))
            : (() => {
                throw new LiveError("Invalid capabilities");
              })(),
        }),
    ...(p.ready === undefined ? {} : { ready: boolean(p.ready, "ready") }),
    ...(p.scanAgeMs === undefined
      ? {}
      : { scanAgeMs: orNullNumber(p.scanAgeMs) }),
    ...(p.eventCount === undefined
      ? {}
      : { eventCount: integer(p.eventCount, "eventCount") }),
    protocol: 1,
    slug: identity(p.slug, "slug"),
    displayName: identity(p.displayName, "displayName"),
    hostGroup: orNullString(p.hostGroup),
    osKind: choice(p.osKind, ["windows", "wsl", "linux", "macos"], "osKind"),
    reporterVersion: identity(p.reporterVersion, "reporterVersion"),
    tokscaleVersion: orNullString(p.tokscaleVersion),
    exportSchema: orNullNumber(p.exportSchema),
    reportingTimezone: orNullString(p.reportingTimezone),
    sinceMs: orNullNumber(p.sinceMs),
    serverNowMs: integer(p.serverNowMs, "serverNowMs"),
  };
}
