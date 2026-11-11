import {
  object as expectObject,
  string as expectString,
  nullableString as orNullString,
  number as expectNumber,
  nullableNumber as orNullNumber,
  decimal as expectDecimalString,
  integer,
  timestamp,
  nullableResetTime,
  nullableObject,
  boolean,
  choice,
  identity,
} from "./validation";
import type { MachineEventInput, MachineQuotaInput, MachineMetricInput } from "./payloads";
import type { OsKind } from "./types";
import {
  CONTROL_HEADER,
  POWER_MODE_PATH,
  parsePowerModeState,
  powerModeId,
  type PowerModeState,
} from "./controls";

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

/** Capability name a reporter advertises when it serves /live/peers. */
export const PEER_DISCOVERY_CAPABILITY = "peer-discovery";

/** Another burn reporter on the same tailnet, as seen from one machine. */
export interface LivePeer {
  url: string;
  slug: string;
  displayName: string;
  osKind: OsKind;
}

export interface LivePeersPage {
  peers: LivePeer[];
}

/** Capability name a reporter advertises when it serves /live/digests. */
export const DAY_DIGESTS_CAPABILITY = "day-digests";
export const DAY_MS = 86_400_000;

/**
 * One digest per UTC day of a snapshot's events (`floor(occurredAtMs / DAY_MS)`),
 * oldest first. A phone that kept the digests of the snapshot it last
 * reconciled can tell which days changed since and download only from the
 * earliest of them, instead of the whole history every day.
 */
export interface LiveDigestsPage {
  snapshotId: string;
  contentHash: string;
  generatedAt: string;
  days: [day: number, digest: string][];
}

/**
 * Where a reconciliation must start, as an epoch-ms `since`: the start of the
 * earliest UTC day whose digest differs between what the phone holds and what
 * the machine now has (a day on only one side differs). Null when every day
 * matches. With nothing held, everything differs and the answer is 0.
 */
export function earliestChangedDayMs(
  held: Readonly<Record<string, string>> | null,
  current: readonly (readonly [number, string])[],
): number | null {
  if (held === null) return 0;
  let earliest: number | null = null;
  const seen = new Set<string>();
  for (const [day, digest] of current) {
    seen.add(String(day));
    if (held[String(day)] !== digest && (earliest === null || day < earliest)) earliest = day;
  }
  for (const key of Object.keys(held)) {
    const day = Number(key);
    if (!seen.has(key) && (earliest === null || day < earliest)) earliest = day;
  }
  return earliest === null ? null : Math.max(0, earliest) * DAY_MS;
}

export interface LiveMetricsPage {
  generatedAt: string;
  metrics: MachineMetricInput[];
}

export interface LivePageRequest {
  limit?: number;
  cursor?: string;
  knownHash?: string;
  force?: boolean;
  /** First-page order; continuation cursors carry it. Older reporters ignore it. */
  order?: "asc" | "desc";
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
  metrics?(sinceMs: number, signal?: AbortSignal): Promise<LiveMetricsPage>;
  /** Other reporters this machine can see on the tailnet (ADR 0005). */
  peers?(signal?: AbortSignal): Promise<LivePeersPage>;
  /** Per-day content digests; only reporters advertising the capability answer. */
  digests?(signal?: AbortSignal): Promise<LiveDigestsPage>;
  /** Opt-in control (ADR 0004); only machines advertising it answer. */
  powerMode?(signal?: AbortSignal): Promise<PowerModeState>;
  /** Apply a mode; resolves with the state read back after the change. */
  setPowerMode?(mode: string, signal?: AbortSignal): Promise<PowerModeState>;
}

type LiveTransport = {
  [K in keyof LiveApi]: (...args: Parameters<NonNullable<LiveApi[K]>>) => Promise<unknown>;
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
  if (transport.metrics) {
    const metrics = transport.metrics;
    api.metrics = async (...args) => parseLiveMetricsPage(await metrics(...args));
  }
  if (transport.peers) {
    const peers = transport.peers;
    api.peers = async (...args) => parseLivePeersPage(await peers(...args));
  }
  if (transport.digests) {
    const digests = transport.digests;
    api.digests = async (...args) => parseLiveDigestsPage(await digests(...args));
  }
  if (transport.powerMode) {
    const read = transport.powerMode;
    api.powerMode = async (...args) => parsePowerModeState(await read(...args));
  }
  if (transport.setPowerMode) {
    const write = transport.setPowerMode;
    api.setPowerMode = async (mode, signal) =>
      parsePowerModeState(await write(powerModeId(mode, "mode"), signal));
  }
  validatedApis.add(api);
  return api;
}

/** Re-send window: a message
 * completed just after a scan is caught by the next pull's overlap. */
export const LIVE_OVERLAP_MS = 60 * 60_000;

export { LiveError, LiveUnreachableError } from "./errors";
import { LiveError, LiveUnreachableError } from "./errors";

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
    payload?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "accept-encoding": "gzip",
      };
      if (knownHash) headers["if-none-match"] = `"${knownHash}"`;
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers[CONTROL_HEADER] = "1";
      }
      response = await fetchImpl(`${base}${path}`, {
        headers,
        ...(payload === undefined ? {} : { method: "POST", body: JSON.stringify(payload) }),
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
      // A proxy in front of a stopped reporter (e.g. `tailscale serve`)
      // answers 502/503/504 without a JSON body: the machine is unreachable.
      if ([502, 503, 504].includes(response.status))
        throw new LiveUnreachableError(`${base}${path}: reporter not answering (HTTP ${response.status})`);
      if (!response.ok) throw new LiveError(`${base}${path}: HTTP ${response.status}`, response.status);
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
      else if (page.order) params.set("order", page.order);
      if (page.force) params.set("force", "1");
      return call(
        `/live/events${params.size ? `?${params}` : ""}`,
        signal,
        page.knownHash,
      );
    },
    quotas: async (signal) => call("/live/quotas", signal),
    metrics: async (sinceMs, signal) => call(`/live/metrics?since=${Math.floor(sinceMs)}`, signal),
    digests: async (signal) => call("/live/digests", signal),
    peers: async (signal) => call("/live/peers", signal),
    powerMode: async (signal) => call(POWER_MODE_PATH, signal),
    setPowerMode: async (mode, signal) => call(POWER_MODE_PATH, signal, undefined, { mode }),
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
      resetsAt: nullableResetTime(q.resetsAt, where("resetsAt")),
      creditStatus: nullableObject(q.creditStatus, where("creditStatus")),
      spendControl: nullableObject(q.spendControl, where("spendControl")),
      status: choice(q.status ?? "ok", ["ok", "error"], where("status")),
      error: orNullString(q.error),
      sourceOffsetMinutes: orNullNumber(q.sourceOffsetMinutes),
      ...(q.fetchedAt === null || q.fetchedAt === undefined
        ? {}
        : { fetchedAt: timestamp(q.fetchedAt, where("fetchedAt")) }),
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

function percent(value: unknown, where: string): number {
  const number = expectNumber(value, where);
  if (number < 0 || number > 100) throw new LiveError(`${where}: expected 0–100`);
  return number;
}

function nullablePercent(value: unknown, where: string): number | null {
  return value === null || value === undefined ? null : percent(value, where);
}

function nullableTemperature(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  const number = expectNumber(value, where);
  if (number < -50 || number > 200) throw new LiveError(`${where}: invalid temperature`);
  return number;
}

export function parseLivePeersPage(raw: unknown): LivePeersPage {
  const page = expectObject(raw, "peers page");
  if (!Array.isArray(page.peers)) throw new LiveError("peers: expected an array");
  return {
    peers: page.peers.map((entry, index) => {
      const peer = expectObject(entry, `peers[${index}]`);
      const url = identity(peer.url, `peers[${index}].url`);
      // A peer list is another machine's word: only plain tailnet-style
      // endpoints are accepted, never an arbitrary URL to send the phone to.
      if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(url)) throw new LiveError(`peers[${index}].url: invalid endpoint`);
      return {
        url,
        slug: identity(peer.slug, `peers[${index}].slug`),
        displayName: identity(peer.displayName, `peers[${index}].displayName`),
        osKind: choice(peer.osKind, ["windows", "wsl", "linux", "macos"], `peers[${index}].osKind`),
      };
    }),
  };
}

export function parseLiveDigestsPage(raw: unknown): LiveDigestsPage {
  const page = expectObject(raw, "digests page");
  if (!Array.isArray(page.days)) throw new LiveError("digests: expected an array");
  let previous = -1;
  const days = page.days.map((entry, index): [number, string] => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new LiveError(`days[${index}]: expected [day, digest]`);
    const day = integer(entry[0], `days[${index}].day`);
    const digest = identity(entry[1], `days[${index}].digest`);
    if (day <= previous) throw new LiveError(`days[${index}]: days must ascend`);
    previous = day;
    return [day, digest];
  });
  return {
    snapshotId: identity(page.snapshotId, "snapshotId"),
    contentHash: identity(page.contentHash, "contentHash"),
    generatedAt: timestamp(page.generatedAt, "generatedAt"),
    days,
  };
}

/** Validate peer-provided vitals before they reach the phone mirror. */
export function parseLiveMetricsPage(raw: unknown): LiveMetricsPage {
  const page = expectObject(raw, "metrics page");
  if (!Array.isArray(page.metrics)) throw new LiveError("metrics: expected an array");
  const metrics = page.metrics.map((row, index) => {
    const metric = expectObject(row, `metrics[${index}]`);
    const where = (field: string): string => `metrics[${index}].${field}`;
    return {
      capturedAtMs: integer(metric.capturedAtMs, where("capturedAtMs")),
      cpuLoadPct: percent(metric.cpuLoadPct, where("cpuLoadPct")),
      cpuTempC: nullableTemperature(metric.cpuTempC, where("cpuTempC")),
      ramUsedPct: percent(metric.ramUsedPct, where("ramUsedPct")),
      ramTempC: nullableTemperature(metric.ramTempC, where("ramTempC")),
      gpuUtilPct: nullablePercent(metric.gpuUtilPct, where("gpuUtilPct")),
      gpuTempC: nullableTemperature(metric.gpuTempC, where("gpuTempC")),
    } satisfies MachineMetricInput;
  });
  return { generatedAt: timestamp(page.generatedAt, "generatedAt"), metrics };
}
