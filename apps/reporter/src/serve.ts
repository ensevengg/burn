import { SystemMetricHistory } from "./system-metrics";
import { gzipSync } from "node:zlib";
import { MachineSnapshots, QuotaSnapshots, snapshotsFor } from "./snapshots";
/** Machine backend bound to the tailnet (or loopback for local diagnostics).
 * Serves validated, priced tokscale rows and vendor quotas from shared
 * snapshots, read-only. The phone owns incremental cursors and history
 * storage. The one write is the opt-in power-mode control (ADR 0004). */
import {
  CONTROL_HEADER,
  EVENT_EXPORT_SCHEMA,
  POWER_MODE_CAPABILITY,
  POWER_MODE_PATH,
  parsePowerModeRequest,
  type MachineQuotaInput,
} from "@burn/sync-api";
import { ControlError, PowerModeController } from "./power-mode.js";
import { loadConfig, type BurnConfig } from "./config.js";
import {
  fetchUsage,
  spawnRunner,
  TokscaleError,
  tokscaleQuotaInputs,
  REPORTER_VERSION,
} from "./tokscale.js";

export interface LiveDeps {
  config: BurnConfig;
  metrics?: SystemMetricHistory;
  now?: () => number;
  exporterScan?: (sinceMs: number) => Promise<string>;
  exporterCheck?: () => Promise<string | null>;
  usage?: (pin: string) => Promise<unknown>;
  powerMode?: PowerModeController;
}

export interface LiveServerHandle {
  hostname: string;
  port: number;
  /** Endpoint to add on the phone. */
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

/** Opt-in control endpoint (ADR 0004). Reads are GET; the single write is a
 * JSON POST that browsers cannot forge cross-origin: it must carry the control
 * header (forcing a CORS preflight the reporter never answers) and no Origin. */
async function powerModeRoute(req: Request, control: PowerModeController | null): Promise<Response> {
  if (control === null)
    return jsonResponse({ error: "power mode control is off on this machine; run: burn-report controls enable power-mode" }, 404);
  const failed = (err: unknown) =>
    err instanceof ControlError
      ? jsonResponse({ error: err.message }, err.status)
      : jsonResponse({ error: errorText(err) }, 500);
  if (req.method === "GET") return control.state().then((state) => jsonResponse(state), failed);
  if (req.method !== "POST") {
    const response = jsonResponse({ error: "GET or POST only" }, 405);
    response.headers.set("allow", "GET, POST");
    return response;
  }
  if (req.headers.get("origin") !== null)
    return jsonResponse({ error: "browser requests cannot change machine controls" }, 403);
  if (req.headers.get(CONTROL_HEADER) !== "1")
    return jsonResponse({ error: `missing ${CONTROL_HEADER} header` }, 403);
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? ""))
    return jsonResponse({ error: "expected application/json" }, 415);
  if (Number(req.headers.get("content-length") ?? 0) > 1_024)
    return jsonResponse({ error: "request too large" }, 413);
  let mode: string;
  try {
    const text = await req.text();
    if (text.length > 1_024) return jsonResponse({ error: "request too large" }, 413);
    mode = parsePowerModeRequest(JSON.parse(text)).mode;
  } catch (err) {
    return jsonResponse({ error: `invalid request: ${errorText(err)}` }, 400);
  }
  try {
    const state = await control.set(mode);
    console.log(`[controls] power mode set to ${mode}`);
    return jsonResponse(state);
  } catch (err) {
    console.warn(`[controls] power mode ${mode} failed: ${errorText(err)}`);
    return failed(err);
  }
}

/**
 * Pure request handler — Bun.serve-independent so tests exercise it without
 * sockets. `GET /ping`, `GET /live/events`, `GET /live/quotas`, `GET /live/metrics`,
 * and the opt-in `/controls/power-mode`; anything else is a 404/405.
 */
export function createLiveFetch(
  deps: LiveDeps,
): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const shared = snapshotsFor(deps.config);
  const metrics = deps.metrics ?? new SystemMetricHistory(undefined, now);
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
  const control = deps.config.controls?.powerMode
    ? (deps.powerMode ?? new PowerModeController())
    : null;
  const encoded = new Map<string, { text: string; gzip?: Uint8Array }>();
  const respond = (
    req: Request,
    payload: unknown,
    cacheKey?: string,
    headers: Record<string, string> = {},
  ) => {
    const gzip = (req.headers.get("accept-encoding") ?? "")
      .split(",")
      .some((part) => {
        const [encoding, ...parameters] = part.trim().split(";");
        return (
          encoding?.toLowerCase() === "gzip" &&
          !parameters.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p))
        );
      });
    let body = cacheKey ? encoded.get(cacheKey) : undefined;
    if (!body) {
      const text = JSON.stringify(payload);
      body = { text };
      if (cacheKey) {
        encoded.set(cacheKey, body);
        while (encoded.size > 4) encoded.delete(encoded.keys().next().value!);
      }
    }
    if (gzip && !body.gzip) body.gzip = gzipSync(body.text);
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

  const pingPayload = async () => {
    const controls = control !== null && (await control.supported()) ? [POWER_MODE_CAPABILITY] : [];
    return {
      protocol: 1 as const,
      capabilities: ["paged-events", "content-hash", "machine-metrics", "newest-first-pages", ...controls],
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
      // The exporter is checked against this pin before any page is served.
      tokscaleVersion: deps.config.tokscalePin,
      exportSchema: EVENT_EXPORT_SCHEMA,
      reportingTimezone: deps.config.reportingTimezone,
      sinceMs: 0,
      serverNowMs: now(),
    };
  };

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === POWER_MODE_PATH) return powerModeRoute(req, control);
    if (req.method !== "GET") return jsonResponse({ error: "GET only" }, 405);
    switch (path) {
      case "/ping":
        return jsonResponse(await pingPayload());
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
          let sinceMs = requested ?? 0;
          const cursor = url.searchParams.get("cursor");
          const parts = cursor?.split(":");
          // Ascending cursors keep their original three-part form; newest-first
          // windows append their order so a resumed window cannot change it.
          const cursorOrder =
            parts?.length === 3
              ? "asc"
              : parts?.length === 4 && parts[3] === "desc"
                ? "desc"
                : null;
          if (sinceParam === null && cursorOrder) sinceMs = Number(parts![1]);
          if (
            parts &&
            (cursorOrder === null ||
              Number(parts[1]) !== sinceMs ||
              !/^\d+$/.test(parts[2]!))
          )
            return jsonResponse({ error: "invalid page cursor" }, 400);
          const orderParam = url.searchParams.get("order");
          if (orderParam !== null && orderParam !== "asc" && orderParam !== "desc")
            return jsonResponse({ error: "invalid page order" }, 400);
          const newestFirst = (cursorOrder ?? orderParam) === "desc";
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
          const pageKey = `${snapshot.id}:${sinceMs}:${offset}:${limit}:${newestFirst ? "desc" : "asc"}`;
          if (encoded.has(pageKey)) return respond(req, null, pageKey, headers);
          const end = snapshot.events.length;
          const events = newestFirst
            ? snapshot.events
                .slice(Math.max(first, end - offset - limit), end - offset)
                .reverse()
            : snapshot.events.slice(first + offset, first + offset + limit);
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
              ? `${snapshot.id}:${sinceMs}:${offset + events.length}${newestFirst ? ":desc" : ""}`
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
            pageKey,
            headers,
          );
        } catch (err) {
          return jsonResponse(
            { error: errorText(err) },
            errorText(err).includes("not found") ? 503 : 500,
          );
        }
      }
      case "/live/metrics": {
        const since = new URL(req.url).searchParams.get("since");
        const sinceMs = since === null ? 0 : Number(since);
        if ((since !== null && !since.trim()) || !Number.isSafeInteger(sinceMs) || sinceMs < 0)
          return jsonResponse({ error: "invalid since timestamp" }, 400);
        try {
          return respond(req, {
            generatedAt: new Date(now()).toISOString(),
            metrics: deps.config.osKind === "wsl" ? [] : await metrics.since(sinceMs),
          });
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
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
  const metrics = options.deps?.metrics ?? new SystemMetricHistory();
  const sample = () => { void metrics.sample().catch((err) => console.warn(`[systems] ${errorText(err)}`)); };
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 150,
    fetch: createLiveFetch({ config, ...options.deps, metrics }),
  });
  const sampler = config.osKind === "wsl" ? null : setInterval(sample, 30_000);
  if (sampler) sample();
  // Injected scans (tests, embedders) get their own cold store in
  // createLiveFetch; only the shared production store is kept warm.
  const injected = options.deps?.exporterScan || options.deps?.exporterCheck || options.deps?.now;
  const stopWarm = injected
    ? null
    : snapshotsFor(config).events.keepWarm(10_000, (message) => console.warn(`[scan] ${message}`));
  const boundPort = server.port ?? port;
  return {
    hostname,
    port: boundPort,
    url: `http://${hostname}:${boundPort}`,
    stop: () => {
      if (sampler) clearInterval(sampler);
      stopWarm?.();
      server.stop(true);
    },
  };
}

/** Run until interrupted; binding failures fail the command. */
export async function runServe(args: Map<string, string>): Promise<void> {
  const config = loadConfig();
  const options: { bind?: string; port?: number } = {};
  const bind = args.get("bind");
  if (bind) options.bind = bind;
  const port = args.get("port");
  if (port) {
    options.port = Number(port);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      throw new Error("--port must be an integer between 1 and 65535");
  }
  const live = await startLiveServer(config, options);
  console.log(`[serve] ${config.environmentSlug} at ${live.url}`);
  console.log("Add this URL on your phone's Machines tab. Keep this process running.");
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      live.stop();
      console.log("\n[serve] stopped");
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
