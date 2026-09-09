/**
 * Live server (D1 v2, docs/adr/0001-tailscale-direct-pull): a read-only HTTP
 * endpoint that serves the not-yet-pushed tail of this machine's event stream
 * to the phone over the tailnet.
 *
 * Auth model: the server binds the tailnet interface (or loopback when no
 * tailnet is detected), so tailnet membership IS the authorization. No tokens
 * cross this boundary — D7's secret surface is unchanged.
 *
 * Everything served is exactly what the next `push` would send: same exporter,
 * same schema gate, same dedup fallback, same cursor-minus-overlap window.
 * The phone merges those rows with revision 0, and the server's own revisioned
 * copy wins the upsert once the real push lands — the two paths converge by
 * construction instead of by reconciliation.
 */
import {
  EVENT_EXPORT_SCHEMA,
  type IngestEventInput,
  type IngestQuotaInput,
} from "@burn/sync-api";
import { loadConfig, loadCursor, type BurnConfig, type ReporterCursor } from "./config.js";
import {
  exportRowsToIngestInputs,
  parseEventsJsonl,
  pushSinceMs,
} from "./events.js";
import {
  assertExporterCapabilities,
  assertExporterMatchesPin,
  exporterCapabilities,
  exporterFingerprint,
  exporterVersion,
  fetchEventsJsonl,
} from "./exporter.js";
import { fetchUsage, spawnRunner, TokscaleError, tokscaleQuotaInputs, REPORTER_VERSION } from "./tokscale.js";

export interface LiveDeps {
  config: BurnConfig;
  now?: () => number;
  cursor?: () => ReporterCursor;
  exporterScan?: (sinceMs: number) => Promise<string>;
  exporterCheck?: () => Promise<string | null>;
  exporterFingerprint?: () => Promise<string | null>;
  usage?: (pin: string) => Promise<unknown>;
}

export interface LiveServerHandle {
  hostname: string;
  port: number;
  /** What the machine advertises in heartbeats while running. */
  url: string;
  stop(): void;
}

/** Resolve the tailnet IPv4 via the tailscale CLI, or null when absent. */
export async function tailscaleIp(timeoutMs = 5_000): Promise<string | null> {
  try {
    const { stdout } = await spawnRunner({ command: "tailscale", prefix: [] }, ["ip", "-4"], timeoutMs);
    return /^(\d+\.\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200, request?: Request): Response {
  const json = JSON.stringify(payload);
  const acceptsGzip = request?.headers.get("accept-encoding")?.includes("gzip") === true;
  if (acceptsGzip && json.length >= 1_024) {
    return new Response(Bun.gzipSync(new TextEncoder().encode(json)), {
      status,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        vary: "accept-encoding",
      },
    });
  }
  return new Response(json, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorText(err: unknown): string {
  if (err instanceof TokscaleError) return err.message;
  return (err as Error).message ?? String(err);
}

/**
 * Pure request handler — Bun.serve-independent so tests exercise it without
 * sockets. `GET /ping`, `GET /live/events`, `GET /live/quotas`; anything else
 * is a 404/405.
 */
export function createLiveFetch(deps: LiveDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  type EventPage = {
    sinceMs: number;
    generatedAt: string;
    generation: string | null;
    events: IngestEventInput[];
  };
  type EventSnapshot = Omit<EventPage, "sinceMs" | "generation"> & { fingerprint: string };
  let activeScan: { sinceMs: number; promise: Promise<EventPage | null> } | null = null;
  let activeSnapshot: Promise<EventSnapshot | null> | null = null;
  let eventSnapshot: EventSnapshot | null = null;
  let fingerprintInFlight: Promise<string | null> | null = null;
  let quotaCache: { expiresAt: number; page: { generatedAt: string; quotas: IngestQuotaInput[] } } | null = null;
  let quotaInFlight: Promise<{ generatedAt: string; quotas: IngestQuotaInput[] }> | null = null;

  const pingPayload = () => {
    const cursor = (deps.cursor ?? loadCursor)();
    return {
      protocol: 1 as const,
      slug: deps.config.environmentSlug,
      displayName: deps.config.environmentName,
      hostGroup: deps.config.hostGroup,
      osKind: deps.config.osKind,
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: null,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: deps.config.reportingTimezone,
      sinceMs: pushSinceMs(cursor.lastPushAt, false),
      serverNowMs: now(),
    };
  };

  const scanUncached = async (sinceMs: number): Promise<EventPage | null> => {
    if (activeScan !== null) {
      if (activeScan.sinceMs === sinceMs) return activeScan.promise;
      // A cloud-tail request and a direct request can use different cursors.
      // Serialize those scans instead of making one caller fail with a 503.
      await activeScan.promise.catch(() => null);
      return scanUncached(sinceMs);
    }
    const promise = (async (): Promise<EventPage | null> => {
      const exporter = await (deps.exporterCheck ?? exporterVersion)();
      if (exporter === null) return null;
      assertExporterMatchesPin(exporter, deps.config.tokscalePin);
      const rows = parseEventsJsonl(await (deps.exporterScan ?? fetchEventsJsonl)(sinceMs));
      return {
        sinceMs,
        generatedAt: new Date(now()).toISOString(),
        generation: null,
        events: exportRowsToIngestInputs(rows, deps.config.tokscalePin),
      };
    })();
    activeScan = { sinceMs, promise };
    void promise
      .finally(() => {
        if (activeScan?.promise === promise) activeScan = null;
      })
      .catch(() => {});
    return promise;
  };

  const readFingerprint = (): Promise<string | null> => {
    if (fingerprintInFlight !== null) return fingerprintInFlight;
    const pending = (deps.exporterFingerprint ?? exporterFingerprint)();
    fingerprintInFlight = pending;
    void pending
      .finally(() => {
        if (fingerprintInFlight === pending) fingerprintInFlight = null;
      })
      .catch(() => {});
    return pending;
  };

  const pageFromSnapshot = (snapshot: EventSnapshot, sinceMs: number): EventPage => ({
    sinceMs,
    generatedAt: snapshot.generatedAt,
    generation: snapshot.fingerprint,
    events: snapshot.events.filter((event) => event.occurredAtMs >= sinceMs),
  });

  const scanEvents = async (
    sinceMs: number,
    knownGeneration: string | null,
  ): Promise<EventPage | null> => {
    // A generation match skips parsing, never contract validation. This stays
    // cheap because exporterVersion() caches a successful process probe.
    const exporter = await (deps.exporterCheck ?? exporterVersion)();
    if (exporter === null) return null;
    assertExporterMatchesPin(exporter, deps.config.tokscalePin);
    const fingerprint = await readFingerprint();
    // Missing/old development exporters remain correct, just uncached.
    if (fingerprint === null) return scanUncached(sinceMs);
    if (knownGeneration === fingerprint) {
      return {
        sinceMs,
        generatedAt: eventSnapshot?.generatedAt ?? new Date(now()).toISOString(),
        generation: fingerprint,
        events: [],
      };
    }
    if (eventSnapshot?.fingerprint === fingerprint) {
      return pageFromSnapshot(eventSnapshot, sinceMs);
    }
    if (activeSnapshot !== null) {
      const snapshot = await activeSnapshot;
      if (snapshot?.fingerprint === fingerprint) return pageFromSnapshot(snapshot, sinceMs);
      return scanEvents(sinceMs, knownGeneration);
    }

    const pending = (async (): Promise<EventSnapshot | null> => {
      const page = await scanUncached(0);
      if (page === null) return null;
      const snapshot = {
        fingerprint,
        generatedAt: page.generatedAt,
        events: page.events,
      };
      eventSnapshot = snapshot;
      return snapshot;
    })();
    activeSnapshot = pending;
    void pending
      .finally(() => {
        if (activeSnapshot === pending) activeSnapshot = null;
      })
      .catch(() => {});
    const snapshot = await pending;
    return snapshot === null ? null : pageFromSnapshot(snapshot, sinceMs);
  };

  const loadQuotas = (): Promise<{ generatedAt: string; quotas: IngestQuotaInput[] }> => {
    if (quotaCache !== null && quotaCache.expiresAt > now()) return Promise.resolve(quotaCache.page);
    if (quotaInFlight !== null) return quotaInFlight;
    const pending = (async () => {
      const outputs = await (deps.usage ?? fetchUsage)(deps.config.tokscalePin);
      const page = {
        generatedAt: new Date(now()).toISOString(),
        quotas: tokscaleQuotaInputs(outputs as Awaited<ReturnType<typeof fetchUsage>>),
      };
      quotaCache = { expiresAt: now() + 5 * 60_000, page };
      return page;
    })();
    quotaInFlight = pending;
    void pending
      .finally(() => {
        if (quotaInFlight === pending) quotaInFlight = null;
      })
      .catch(() => {});
    return pending;
  };

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method !== "GET") return jsonResponse({ error: "GET only" }, 405);
    switch (path) {
      case "/ping":
        return jsonResponse(pingPayload());
      case "/live/events": {
        try {
          // Direct mode (ADR 0002) passes the phone's per-machine cursor;
          // without it, serve the machine's own push cursor minus overlap —
          // exactly the next push's window.
          const sinceParam = new URL(req.url).searchParams.get("since");
          const requested = sinceParam === null ? null : Number(sinceParam);
          const cursor = (deps.cursor ?? loadCursor)();
          const sinceMs =
            requested !== null && Number.isFinite(requested) && requested >= 0
              ? Math.floor(requested)
              : pushSinceMs(cursor.lastPushAt, false);
          // The exact transform the push path applies: dedup fallback derived,
          // cost → decimal string, timezone shim, parser version pinned. The
          // phone receives the same rows its Supabase twin will have.
          const knownGeneration = new URL(req.url).searchParams.get("generation");
          const page = await scanEvents(sinceMs, knownGeneration);
          if (page === null) {
            return jsonResponse({ error: "burn-events exporter not found on this machine" }, 503);
          }
          return jsonResponse(page, 200, req);
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
        }
      }
      case "/live/quotas": {
        try {
          return jsonResponse(await loadQuotas());
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
        }
      }
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  };
}

/**
 * Bind and run. `--bind` wins; else the tailnet IP; else loopback (with a
 * loud warning — loopback means only this machine can answer, which is right
 * for a smoke test and useless to the phone).
 */
export async function startLiveServer(
  config: BurnConfig,
  options: { bind?: string; port?: number } = {},
): Promise<LiveServerHandle> {
  const detected = options.bind ? null : await tailscaleIp();
  const hostname = options.bind ?? detected ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!options.bind && detected === null) {
    console.warn("[live] tailscale not detected — binding 127.0.0.1 (phone cannot reach this)");
  }
  const server = Bun.serve({ hostname, port, fetch: createLiveFetch({ config }) });
  const boundPort = server.port ?? port;
  return {
    hostname,
    port: boundPort,
    url: `http://${hostname}:${boundPort}`,
    stop: () => server.stop(true),
  };
}

/**
 * `burn-report serve` — the live server alone, without the daemon's push
 * loop. Heartbeats once at startup so the phone learns the endpoint even if
 * no push has happened yet; the daemon remains the recommended resident mode.
 */
export async function runServe(args: Map<string, string>): Promise<void> {
  const config = loadConfig();
  assertExporterCapabilities(await exporterCapabilities(), config.tokscalePin);
  const options: { bind?: string; port?: number } = {};
  const bindArg = args.get("bind");
  if (bindArg) options.bind = bindArg;
  const portArg = args.get("port");
  if (portArg) options.port = Number(portArg);
  const live = await startLiveServer(config, options);
  const advertised = args.get("live-url") ?? live.url;
  console.log(`[serve] ${config.environmentSlug} live at ${live.url} (advertised: ${advertised})`);
  try {
    const { reporterApiFor } = await import("./backend.js");
    await reporterApiFor(config).heartbeat({
      reporterVersion: REPORTER_VERSION,
      tokscaleVersion: null,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: config.reportingTimezone,
      liveEndpoint: advertised,
    });
  } catch (err) {
    console.warn(`[serve] heartbeat failed (phone will learn the endpoint on the next push): ${(err as Error).message}`);
  }
  await new Promise<never>(() => {
    process.on("SIGINT", () => {
      live.stop();
      console.log("\n[serve] stopped");
      process.exit(0);
    });
  });
}
