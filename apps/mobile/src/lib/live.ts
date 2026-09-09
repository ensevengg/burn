/**
 * Tailscale live-pull (D1 v2, docs/adr/0001-tailscale-direct-pull).
 *
 * Pulls the not-yet-pushed event tail straight from reachable machines and
 * merges it into the mirror. The invariants that keep this from fighting the
 * cloud path:
 *
 *  1. Live rows are written with revision 0; server rows always carry
 *     revision >= 1. The merge's ON CONFLICT clause updates a row only when
 *     `usage_events.revision = 0` — live can refresh its own rows but can
 *     never overwrite a server-authoritative row, in any interleaving.
 *  2. Event ids come from liveEventId() — byte-identical to the server's
 *     burn_ingest_events recipe — so when the machine's real push lands, the
 *     phone's delta fetch upserts the same row with its revision and the
 *     live copy is simply replaced.
 *  3. The revision watermark is NEVER advanced here. Only server pages move
 *     it, so the next cloud pull re-fetches everything the live path pulled
 *     early and converges the mirror.
 *  4. Writes go through the same write lock as every other mirror writer,
 *     and the pull is cancellable through the same cloud generation counter
 *     cancelCloudSync() advances — resets and disconnects abort live pulls
 *     before they can commit.
 */
import {
  httpLiveApiFor,
  parseLiveEventsPage,
  LiveError,
  type LiveApi,
} from "@burn/sync-api";
import type { SQLiteDatabase } from "expo-sqlite";
import { upsertProvisionalEvents } from "./mirror-write";
import { invalidateEventCache } from "../data/repository";
import { withWriteLock } from "./writelock";
import { cloudGeneration, publishMirrorChange } from "./sync-state";

export interface LivePullStatus {
  environmentId: string;
  slug: string;
  endpoint: string;
  state: "live" | "offline" | "error" | "skipped";
  pulledEvents: number;
  /** |machine clock − phone clock| in ms at ping time; null when unknown. */
  clockSkewMs: number | null;
  error: string | null;
  elapsedMs: number;
}

export interface LivePullOptions {
  /** Ping timeout: fast failure. The mirror is already correct; live is opportunistic. */
  pingTimeoutMs?: number;
  /** Events timeout: generous — the machine's exporter scan takes seconds. */
  eventsTimeoutMs?: number;
  /** Caller's cancellation signal (app lifecycle). */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Test seam — build the LiveApi for an endpoint instead of the HTTP default. */
  apiFor?: (endpoint: string) => LiveApi;
}

const inFlight = new WeakMap<SQLiteDatabase, Promise<LivePullStatus[]>>();
const inFlightController = new WeakMap<SQLiteDatabase, AbortController>();

/** Environments advertising a live endpoint, straight from the mirror. */
async function liveTargets(
  db: SQLiteDatabase,
): Promise<{ environmentId: string; slug: string; liveEndpoint: string }[]> {
  const rows = await db.getAllAsync<{ id: string; slug: string; live_endpoint: string }>(
    "select id, slug, live_endpoint from environments where live_endpoint is not null",
  );
  return rows.map((r) => ({ environmentId: r.id, slug: r.slug, liveEndpoint: r.live_endpoint }));
}

/** Abort when any linked signal fires; cancel() detaches the listeners. */
export function linkedSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    const onAbort = () => controller.abort(new Error(signal.reason?.message ?? "cancelled"));
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      detach.push(() => signal.removeEventListener("abort", onAbort));
    }
  }
  return { signal: controller.signal, cancel: () => detach.forEach((fn) => fn()) };
}

/** Abort when the deadline fires; cancel() clears the timer. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const linked = linkedSignals(signal);
  const onLinkedAbort = () => controller.abort(new Error("cancelled"));
  linked.signal.addEventListener("abort", onLinkedAbort, { once: true });
  // Abort listeners are not retroactive: a signal that was already aborted
  // when we linked it must cancel this timeout synchronously.
  if (linked.signal.aborted) onLinkedAbort();
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      linked.signal.removeEventListener("abort", onLinkedAbort);
      linked.cancel();
    },
  };
}

export function describeFailure(err: unknown): { state: "offline" | "error"; error: string } {
  if (err instanceof LiveError && err.name === "LiveUnreachableError") {
    return { state: "offline", error: (err as Error).message };
  }
  return { state: "error", error: (err as Error).message ?? String(err) };
}

/**
 * Probe every advertising machine and merge its event tail. Concurrent calls
 * share the active probe so foreground/refresh races cannot restart expensive
 * exporter work. Cancelling the owning call — reset/disconnect — aborts before
 * any commit.
 */
export function pullLiveFromMachines(
  db: SQLiteDatabase,
  options: LivePullOptions = {},
): Promise<LivePullStatus[]> {
  const existing = inFlight.get(db);
  if (existing !== undefined) return existing;
  const generation = cloudGeneration(db);
  const internal = new AbortController();
  inFlightController.set(db, internal);
  // Relay the caller's lifecycle signal into this probe (stop()/reset abort).
  const relayCaller = () => internal.abort(new Error("cancelled"));
  const callerSignal = options.signal;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) relayCaller();
    else callerSignal.addEventListener("abort", relayCaller, { once: true });
  }
  const assertActive = (): void => {
    if (cloudGeneration(db) !== generation) throw new LiveError("live pull cancelled");
  };
  const pending = pullLiveUnlocked(db, options, internal.signal, assertActive)
    .finally(() => {
      callerSignal?.removeEventListener("abort", relayCaller);
      if (inFlight.get(db) === pending) {
        inFlight.delete(db);
        inFlightController.delete(db);
      }
    })
    .catch((err: unknown) => {
      // A failed live pull must never break the refresh that started it —
      // the statuses carry the failure to the Machines card instead.
      if (err instanceof LiveError && err.message === "live pull cancelled") throw err;
      return [] as LivePullStatus[];
    });
  inFlight.set(db, pending);
  return pending;
}

async function pullLiveUnlocked(
  db: SQLiteDatabase,
  options: LivePullOptions,
  probeSignal: AbortSignal,
  assertActive: () => void,
): Promise<LivePullStatus[]> {
  const started = Date.now();
  assertActive();
  const targets = await liveTargets(db);
  assertActive();
  if (targets.length === 0) return [];

  const statuses = await Promise.all(
    targets.map(async (target): Promise<LivePullStatus> => {
      const targetStart = Date.now();
      const base: LivePullStatus = {
        environmentId: target.environmentId,
        slug: target.slug,
        endpoint: target.liveEndpoint,
        state: "live",
        pulledEvents: 0,
        clockSkewMs: null,
        error: null,
        elapsedMs: 0,
      };
      const api = options.apiFor
        ? options.apiFor(target.liveEndpoint)
        : httpLiveApiFor(target.liveEndpoint, options.fetchImpl ?? fetch);
      try {
        // 1. Reachability + identity. A slow-to-answer machine counts as
        // offline: the mirror is already correct, live is opportunistic.
        const pingTimeout = withTimeout(probeSignal, options.pingTimeoutMs ?? 2_500);
        let ping;
        try {
          ping = await api.ping(pingTimeout.signal);
        } finally {
          pingTimeout.cancel();
        }
        assertActive();
        // Slug is the natural key (server-unique). A reused address must not
        // inject rows under another environment's id.
        if (ping.slug !== target.slug) {
          return {
            ...base,
            state: "skipped",
            error: `endpoint answered as "${ping.slug}", expected "${target.slug}"`,
            elapsedMs: Date.now() - targetStart,
          };
        }
        const clockSkewMs = Math.abs(ping.serverNowMs - Date.now());

        // 2. Fetch + validate the tail. Machine-side scans take seconds on
        // real histories — generous timeout, still abortable.
        const eventsTimeout = withTimeout(probeSignal, options.eventsTimeoutMs ?? 60_000);
        let page;
        try {
          page = parseLiveEventsPage(await api.events(null, eventsTimeout.signal));
        } finally {
          eventsTimeout.cancel();
        }
        assertActive();

        // 3. Merge. Ids follow the server's recipe; revision stays 0; the
        // WHERE clause makes server rows (revision >= 1) untouchable.
        let changedEvents = 0;
        await withWriteLock(async () => {
          assertActive();
          await db.withTransactionAsync(async () => {
            changedEvents = await upsertProvisionalEvents(
              db,
              { id: target.environmentId, slug: target.slug },
              page.events,
            );
          });
          // Post-commit eviction, inside the writer — same contract as
          // resetDb and the cloud pull. An identical overlap keeps all
          // derived screen data hot.
          if (changedEvents > 0) invalidateEventCache(db);
        });
        if (changedEvents > 0) publishMirrorChange(db, "events");

        return {
          ...base,
          pulledEvents: page.events.length,
          clockSkewMs,
          elapsedMs: Date.now() - targetStart,
        };
      } catch (err) {
        assertActive();
        const failure = describeFailure(err);
        return { ...base, ...failure, elapsedMs: Date.now() - targetStart };
      }
    }),
  );
  return statuses;
}
