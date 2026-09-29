import { gzipSync } from "node:zlib";
import { MachineSnapshots, QuotaSnapshots, snapshotsFor } from "./snapshots";
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
import { EVENT_EXPORT_SCHEMA, type IngestQuotaInput } from "@burn/sync-api";
import {
  loadConfig,
  loadCursor,
  type BurnConfig,
  type ReporterCursor,
} from "./config.js";
import { pushSinceMs } from "./events.js";
import {
  fetchUsage,
  spawnRunner,
  TokscaleError,
  tokscaleQuotaInputs,
  REPORTER_VERSION,
} from "./tokscale.js";

export interface LiveDeps {
  config: BurnConfig;
  now?: () => number;
  cursor?: () => ReporterCursor;
  exporterScan?: (sinceMs: number) => Promise<string>;
  exporterCheck?: () => Promise<string | null>;
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
    const { stdout } = await spawnRunner(
      { command: "tailscale", prefix: [] },
      ["ip", "-4"],
      timeoutMs,
    );
    return /^(\d+\.\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
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
export function createLiveFetch(
  deps: LiveDeps,
): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const shared = snapshotsFor(deps.config);
  const snapshots =
    deps.exporterScan || deps.exporterCheck || deps.now
      ? new MachineSnapshots(deps.config.tokscalePin, {
          now,
          ...(deps.exporterScan ? { scan: deps.exporterScan } : {}),
          ...(deps.exporterCheck ? { check: deps.exporterCheck } : {}),
        })
      : shared.events;
  const quotas =
    deps.usage || deps.now
      ? new QuotaSnapshots(
          async () =>
            tokscaleQuotaInputs(
              (await (deps.usage ?? fetchUsage)(
                deps.config.tokscalePin,
              )) as Awaited<ReturnType<typeof fetchUsage>>,
            ),
          now,
        )
      : shared.quotas;
  const encoded = new Map<string, { text: string; gzip: Uint8Array }>();
  const respond = (
    req: Request,
    payload: unknown,
    cacheKey?: string,
    headers: Record<string, string> = {},
  ) => {
    let body = cacheKey ? encoded.get(cacheKey) : undefined;
    if (!body) {
      const text = JSON.stringify(payload);
      body = { text, gzip: gzipSync(text) };
      if (cacheKey) {
        encoded.set(cacheKey, body);
        while (encoded.size > 4) encoded.delete(encoded.keys().next().value!);
      }
    }
    const gzip = (req.headers.get("accept-encoding") ?? "")
      .split(",")
      .some((part) => {
        const [encoding, ...parameters] = part.trim().split(";");
        return (
          encoding?.toLowerCase() === "gzip" &&
          !parameters.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p))
        );
      });
    return new Response(gzip ? body.gzip : body.text, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
        vary: "Accept-Encoding",
        ...headers,
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      },
    });
  };

  const pingPayload = () => {
    const cursor = (deps.cursor ?? (() => loadCursor(deps.config)))();
    return {
      protocol: 1 as const,
      capabilities: ["paged-events", "content-hash"],
      ready: snapshots.peek() !== null,
      scanAgeMs: snapshots.peek()
        ? now() - Date.parse(snapshots.peek()!.generatedAt)
        : null,
      eventCount: snapshots.peek()?.events.length ?? 0,
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

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method !== "GET") return jsonResponse({ error: "GET only" }, 405);
    switch (path) {
      case "/ping":
        return jsonResponse(pingPayload());
      case "/live/events": {
        try {
          const url = new URL(req.url);
          const sinceParam = url.searchParams.get("since");
          const requested = sinceParam === null ? null : Number(sinceParam);
          if (
            sinceParam !== null &&
            (!sinceParam.trim() ||
              !Number.isSafeInteger(requested) ||
              requested! < 0)
          )
            return jsonResponse({ error: "invalid since timestamp" }, 400);
          let sinceMs =
            requested !== null &&
            Number.isSafeInteger(requested) &&
            requested >= 0
              ? requested
              : pushSinceMs(
                  (deps.cursor ?? (() => loadCursor(deps.config)))().lastPushAt,
                  false,
                );
          const cursor = url.searchParams.get("cursor");
          const parts = cursor?.split(":");
          if (sinceParam === null && parts?.length === 3)
            sinceMs = Number(parts[1]);
          if (
            parts &&
            (parts.length !== 3 ||
              Number(parts[1]) !== sinceMs ||
              !/^\d+$/.test(parts[2]!))
          )
            return jsonResponse({ error: "invalid page cursor" }, 400);
          const snapshot = parts
            ? snapshots.pageSnapshot(parts[0]!)
            : await snapshots.get(url.searchParams.get("force") === "1");
          if (!snapshot)
            return jsonResponse(
              { error: "snapshot expired; restart the window" },
              410,
            );
          const headers = {
            etag: `W/"${snapshot.contentHash}"`,
            "x-generated-at": snapshot.generatedAt,
            "x-scan-started-at-ms": String(snapshot.startedAtMs),
            "x-burn-slug": deps.config.environmentSlug,
          };
          if (
            !cursor &&
            req.headers.get("if-none-match")?.replace(/^W\//, "") ===
              headers.etag.replace(/^W\//, "")
          )
            return new Response(null, { status: 304, headers });
          let lo = 0;
          let hi = snapshot.events.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (snapshot.events[mid]!.occurredAtMs < sinceMs) lo = mid + 1;
            else hi = mid;
          }
          const first = lo;
          const count = snapshot.events.length - first;
          const offset = parts ? Number(parts[2]) : 0;
          if (!Number.isSafeInteger(offset) || offset > count)
            return jsonResponse({ error: "invalid page offset" }, 400);
          const limitParam = url.searchParams.get("limit");
          const requestedLimit =
            limitParam === null ? count : Number(limitParam);
          if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0)
            return jsonResponse({ error: "invalid page limit" }, 400);
          const limit =
            limitParam === null
              ? count
              : Math.max(1, Math.min(requestedLimit, 1000));
          const events = snapshot.events.slice(
            first + offset,
            first + offset + limit,
          );
          // Keep paged payloads below the phone's decode bound, including UTF-8.
          // Old clients without a limit retain their unpaged protocol.
          if (limitParam !== null) {
            let bytes = 0;
            let keep = 0;
            for (const event of events) {
              const size = Buffer.byteLength(JSON.stringify(event)) + 1;
              if (size > 4_000_000)
                return jsonResponse(
                  { error: "event exceeds page size limit" },
                  413,
                );
              if (bytes + size > 4_000_000) break;
              bytes += size;
              keep++;
            }
            events.splice(keep);
          }
          const nextCursor =
            offset + events.length < count
              ? `${snapshot.id}:${sinceMs}:${offset + events.length}`
              : null;
          return respond(
            req,
            {
              slug: deps.config.environmentSlug,
              sinceMs,
              generatedAt: snapshot.generatedAt,
              scanStartedAtMs: snapshot.startedAtMs,
              scanMs: snapshot.scanMs,
              snapshotId: snapshot.id,
              contentHash: snapshot.contentHash,
              events,
              nextCursor,
            },
            `${snapshot.id}:${sinceMs}:${offset}:${limit}`,
            headers,
          );
        } catch (err) {
          return jsonResponse(
            { error: errorText(err) },
            errorText(err).includes("not found") ? 503 : 500,
          );
        }
      }
      case "/live/quotas": {
        try {
          return respond(req, await quotas.get());
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
  options: {
    bind?: string;
    port?: number;
    deps?: Omit<LiveDeps, "config">;
  } = {},
): Promise<LiveServerHandle> {
  const detected = options.bind ? null : await tailscaleIp();
  const hostname = options.bind ?? detected ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!options.bind && detected === null) {
    console.warn(
      "[live] tailscale not detected — binding 127.0.0.1 (phone cannot reach this)",
    );
  }
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 150,
    fetch: createLiveFetch({ config, ...options.deps }),
  });
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
  const options: { bind?: string; port?: number } = {};
  const bindArg = args.get("bind");
  if (bindArg) options.bind = bindArg;
  const portArg = args.get("port");
  if (portArg) options.port = Number(portArg);
  const live = await startLiveServer(config, options);
  const advertised = args.get("live-url") ?? live.url;
  console.log(
    `[serve] ${config.environmentSlug} live at ${live.url} (advertised: ${advertised})`,
  );
  try {
    if (config.mode === "cloud") {
      const { reporterApiFor } = await import("./backend.js");
      await reporterApiFor(config).heartbeat({
        reporterVersion: REPORTER_VERSION,
        tokscaleVersion: null,
        exportSchema: EVENT_EXPORT_SCHEMA,
        reportingTimezone: config.reportingTimezone,
        liveEndpoint: advertised,
      });
    }
  } catch (err) {
    console.warn(
      `[serve] heartbeat failed (phone will learn the endpoint on the next push): ${(err as Error).message}`,
    );
  }
  await new Promise<never>(() => {
    const shutdown = () => {
      live.stop();
      console.log("\n[serve] stopped");
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
