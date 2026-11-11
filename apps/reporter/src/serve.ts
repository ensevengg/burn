import { SystemMetricHistory } from "./system-metrics";
import { gzipSync } from "node:zlib";
import { networkInterfaces } from "node:os";
import { MachineSnapshots, QuotaSnapshots, snapshotDayDigests, snapshotsFor } from "./snapshots";
/** Machine backend bound to the tailnet (or loopback for local diagnostics).
 * Serves validated, priced tokscale rows and vendor quotas from shared
 * snapshots, read-only. The phone owns incremental cursors and history
 * storage. The one write is the opt-in power-mode control (ADR 0004). */
import {
  CONTROL_HEADER,
  DAY_DIGESTS_CAPABILITY,
  EVENT_EXPORT_SCHEMA,
  PEER_DISCOVERY_CAPABILITY,
  POWER_MODE_CAPABILITY,
  POWER_MODE_PATH,
  parsePowerModeRequest,
  type MachineQuotaInput,
} from "@burn/sync-api";
import { ControlError, PowerModeController } from "./power-mode.js";
import { PeerDirectory } from "./peers.js";
import { configPath, loadOrInitConfig, type BurnConfig } from "./config.js";
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
  /** Present on a listening server: answers /live/peers and is advertised. */
  peers?: PeerDirectory;
}

export interface LiveServerHandle {
  hostname: string;
  port: number;
  /** Endpoint to add on the phone. */
  url: string;
  stop(): void;
}

/** This machine's address in Tailscale's range (100.64.0.0/10), read from the
 * network interfaces. Needs no CLI, which the macOS App Store and some
 * Windows installs do not put on PATH. */
export function tailnetAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  for (const addresses of Object.values(interfaces))
    for (const entry of addresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) return entry.address;
    }
  return null;
}

/** Resolve the tailnet IPv4: the tailscale CLI when it is on PATH (it knows
 * which interface is Tailscale's), else the interface in Tailscale's range. */
export async function tailscaleIp(timeoutMs = 5_000): Promise<string | null> {
  try {
    const { stdout } = await spawnRunner(
      { command: "tailscale", prefix: [] },
      ["ip", "-4"],
      timeoutMs,
    );
    const address = /^(\d+\.\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1];
    if (address) return address;
  } catch {
    /* no CLI, or Tailscale is stopped */
  }
  return tailnetAddress();
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
      capabilities: [
        "paged-events", "content-hash", "machine-metrics", "newest-first-pages", DAY_DIGESTS_CAPABILITY,
        ...(deps.peers ? [PEER_DISCOVERY_CAPABILITY] : []),
        ...controls,
      ],
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
      case "/live/peers": {
        if (!deps.peers) return jsonResponse({ error: "not found" }, 404);
        try {
          return respond(req, { peers: await deps.peers.list() });
        } catch (err) {
          return jsonResponse({ error: errorText(err) }, 500);
        }
      }
      case "/live/digests": {
        try {
          const snapshot = await snapshots.get();
          return respond(req, {
            snapshotId: snapshot.id,
            contentHash: snapshot.contentHash,
            generatedAt: snapshot.generatedAt,
            days: snapshotDayDigests(snapshot),
          });
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
    /** Tailnet address lookup; injectable for tests. */
    detect?: () => Promise<string | null>;
    /** Suppress the loopback warning (the supervisor prints its own). */
    quiet?: boolean;
    /** Answer /live/peers (default on). */
    peerDiscovery?: boolean;
  } = {},
): Promise<LiveServerHandle> {
  const detected = options.bind ? null : await (options.detect ?? tailscaleIp)();
  const hostname = options.bind ?? detected ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (!options.bind && detected === null && !options.quiet) {
    console.warn(
      "[live] tailscale not detected — binding 127.0.0.1 (phone cannot reach this)",
    );
  }
  const metrics = options.deps?.metrics ?? new SystemMetricHistory();
  const sample = () => { void metrics.sample().catch((err) => console.warn(`[systems] ${errorText(err)}`)); };
  // Peers are probed on the port this server ends up on, known only once it
  // listens, so the directory is filled in right after.
  const liveDeps: LiveDeps = { config, ...options.deps, metrics };
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 150,
    fetch: createLiveFetch(liveDeps),
  });
  if (!liveDeps.peers && options.peerDiscovery !== false)
    liveDeps.peers = new PeerDirectory(server.port ?? port);
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

/**
 * A server that follows Tailscale. Started at boot, a daemon usually runs
 * before Tailscale has an address; binding loopback once and staying there
 * left the machine unreachable until someone restarted it. This keeps
 * looking and moves to the tailnet address when it appears (or changes),
 * starting the new listener before stopping the old one.
 */
export async function superviseLiveServer(
  config: BurnConfig,
  options: {
    bind?: string;
    port?: number;
    deps?: Omit<LiveDeps, "config">;
    detect?: () => Promise<string | null>;
    pollMs?: number;
    onBound?: (live: LiveServerHandle, tailnet: boolean) => void;
  } = {},
): Promise<{ current(): LiveServerHandle; stop(): void }> {
  const detect = options.detect ?? tailscaleIp;
  // One history across rebinds: the phone's 24-hour health view survives.
  const deps = { ...options.deps, metrics: options.deps?.metrics ?? new SystemMetricHistory() };
  const base = {
    deps,
    quiet: true,
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  const first = options.bind ? options.bind : await detect();
  let live = await startLiveServer(config, { ...base, bind: first ?? "127.0.0.1" });
  options.onBound?.(live, options.bind !== undefined || first !== null);
  if (options.bind) return { current: () => live, stop: () => live.stop() };
  let busy = false;
  const watcher = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const address = await detect();
      if (address === null || address === live.hostname) return;
      // Same port on the new address, so a phone that registered this
      // machine by name keeps working.
      const next = await startLiveServer(config, { ...base, bind: address, port: live.port });
      live.stop();
      live = next;
      options.onBound?.(live, true);
    })()
      .catch((err) => console.warn(`[serve] could not move to the tailnet address: ${errorText(err)}`))
      .finally(() => (busy = false));
  }, options.pollMs ?? 10_000);
  return {
    current: () => live,
    stop: () => {
      clearInterval(watcher);
      live.stop();
    },
  };
}

/** Run until interrupted; binding failures fail the command. */
export async function runServe(args: Map<string, string>): Promise<void> {
  const { config, created } = loadOrInitConfig();
  if (created)
    console.log(
      `[serve] first run: this machine is "${config.environmentName}" (${config.environmentSlug}). ` +
        `Rename it with: burn-report init --slug … --name …  (config: ${configPath()})`,
    );
  const options: { bind?: string; port?: number } = {};
  const bind = args.get("bind");
  if (bind) options.bind = bind;
  const port = args.get("port");
  if (port) {
    options.port = Number(port);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      throw new Error("--port must be an integer between 1 and 65535");
  }
  const live = await superviseLiveServer(config, {
    ...options,
    onBound: (bound, tailnet) => {
      if (tailnet) {
        console.log(`[serve] ${config.environmentSlug} at ${bound.url}`);
        console.log("Add this address (or this machine's Tailscale name) on your phone's Machines tab. Keep this process running.");
      } else {
        console.warn(
          `[serve] Tailscale has no address yet — listening on ${bound.url} only (the phone cannot reach this). ` +
            "Waiting for Tailscale; no restart needed.",
        );
      }
    },
  });
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
