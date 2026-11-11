import { createHash } from "node:crypto";
import type { MachineEventInput, MachineQuotaInput } from "@burn/sync-api";
import type { BurnConfig } from "./config";
import { parseEventsJsonl, exportRowsToMachineInputs } from "./events";
import {
  exporterVersion,
  exporterCapabilities,
  assertExporterCapabilities,
  exporterFingerprint,
  assertExporterMatchesPin,
  fetchEventsJsonl,
} from "./exporter";
import { fetchUsage, tokscaleQuotaInputs } from "./tokscale";

export interface MachineSnapshot {
  id: string;
  contentHash: string;
  startedAtMs: number;
  generatedAt: string;
  scanMs: number;
  events: MachineEventInput[];
}
interface SnapshotDeps {
  now?: () => number;
  scan?: (sinceMs: number) => Promise<string>;
  check?: () => Promise<string | null>;
  ttlMs?: number;
  fingerprint?: () => Promise<string | null>;
}

/** A normalized full snapshot covers every requested window. One scan promise
 * is shared by HTTP consumers; old generations remain briefly pageable.
 *
 * A resident daemon keeps the snapshot warm (`keepWarm`): scans then run on a
 * timer instead of inside a phone's request, which otherwise waits for the
 * exporter (and, once an hour, for tokscale to re-download its pricing data).
 * Requests are answered from the newest finished snapshot, at most one
 * refresh interval behind the sources, the same bound the cache TTL gives. */
export class MachineSnapshots {
  private latest: MachineSnapshot | null = null;
  private pending: Promise<MachineSnapshot> | null = null;
  private checkedAt = -Infinity;
  private sourceFingerprint: string | null = null;
  private refreshedAt = -Infinity;
  private warmers = 0;
  /** The last scan failed: requests wait for the next one so the phone is
   * told, instead of being served an ever-older snapshot in silence. */
  private failed = false;
  private readonly history = new Map<
    string,
    { snapshot: MachineSnapshot; touchedAt: number }
  >();
  private readonly now: () => number;
  constructor(
    private readonly pin: string,
    private readonly deps: SnapshotDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
  }
  peek(): MachineSnapshot | null {
    return this.latest;
  }
  pageSnapshot(id: string): MachineSnapshot | null {
    const entry = this.history.get(id);
    if (!entry || this.now() - entry.touchedAt > 300_000) return null;
    entry.touchedAt = this.now();
    return entry.snapshot;
  }
  /** Scan now and on every interval; returns the stop function. Failures are
   * reported once per distinct message, not once per tick. */
  keepWarm(intervalMs = 30_000, report: (message: string) => void = () => {}): () => void {
    this.warmers++;
    let reported: string | null = null;
    const tick = () => {
      if (this.pending || this.fresh()) return;
      this.refresh(false).then(
        () => (reported = null),
        (err: unknown) => {
          const message = (err as Error).message ?? String(err);
          if (message !== reported) report(message);
          reported = message;
        },
      );
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearInterval(timer);
      this.warmers--;
    };
  }
  private fresh(): boolean {
    return (
      this.latest !== null &&
      this.now() >= this.refreshedAt &&
      this.now() - this.refreshedAt < (this.deps.ttlMs ?? 30_000)
    );
  }
  get(force = false): Promise<MachineSnapshot> {
    // Warm stores answer from the finished snapshot while a scan runs. A
    // forced read, a failed scan or a clock set back behind the snapshot
    // still waits for a scan.
    if (!force && this.warmers > 0 && this.latest && !this.failed && this.now() >= this.latest.startedAtMs) {
      if (!this.pending && !this.fresh()) void this.refresh(false).catch(() => {});
      return Promise.resolve(this.latest);
    }
    if (this.pending) return this.pending;
    if (!force && this.fresh()) return Promise.resolve(this.latest!);
    return this.refresh(force);
  }
  private refresh(force: boolean): Promise<MachineSnapshot> {
    const pending = this.scan(force)
      .then(
        (snapshot) => {
          this.failed = false;
          return snapshot;
        },
        (err: unknown) => {
          this.failed = true;
          throw err;
        },
      )
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
  private async scan(force: boolean): Promise<MachineSnapshot> {
    if (this.now() < this.checkedAt || this.now() - this.checkedAt >= 300_000) {
      const version = await (this.deps.check ?? exporterVersion)();
      if (version === null)
        throw new Error("burn-events exporter not found on this machine");
      assertExporterMatchesPin(version, this.pin);
      if (!this.deps.check)
        assertExporterCapabilities(await exporterCapabilities(), this.pin);
      this.checkedAt = this.now();
    }
    // Keep main's source fingerprint fast path behind the resumable snapshot
    // cache. Injected scans opt in explicitly so fixtures never probe a binary.
    const fingerprint = this.deps.fingerprint
      ? await this.deps.fingerprint()
      : this.deps.scan ? null : await exporterFingerprint();
    if (!force && fingerprint !== null && fingerprint === this.sourceFingerprint && this.latest && this.now() >= this.latest.startedAtMs) {
      this.refreshedAt = this.now();
      this.history.set(this.latest.id, { snapshot: this.latest, touchedAt: this.now() });
      return this.latest;
    }
    const startedAtMs = this.now();
    const rows = parseEventsJsonl(
      await (this.deps.scan ?? ((since) => fetchEventsJsonl(since, 90_000)))(0),
    );
    const events = exportRowsToMachineInputs(rows, this.pin).sort(
      (a, b) =>
        a.occurredAtMs - b.occurredAtMs ||
        a.client.localeCompare(b.client) ||
        a.dedupKey.localeCompare(b.dedupKey),
    );
    const contentHash = createHash("sha256")
      .update(JSON.stringify(events))
      .digest("hex");
    const generatedAt = new Date(this.now()).toISOString();
    const snapshot = {
      id: `${startedAtMs.toString(36)}-${contentHash.slice(0, 16)}`,
      contentHash,
      startedAtMs,
      generatedAt,
      scanMs: this.now() - startedAtMs,
      events,
    };
    this.refreshedAt = this.now();
    this.sourceFingerprint = fingerprint;
    this.latest = snapshot;
    this.history.set(snapshot.id, { snapshot, touchedAt: this.now() });
    while (this.history.size > 3) {
      const oldest = [...this.history].sort(
        (a, b) => a[1].touchedAt - b[1].touchedAt,
      )[0];
      if (oldest) this.history.delete(oldest[0]);
    }
    return snapshot;
  }
}

/** Vendor quotas, read through tokscale. A reading is fresh for 45 seconds.
 * With `serveStaleMs`, an older reading (up to that age) is returned at once
 * with its true collection time while a refresh runs behind it: provider APIs
 * take seconds, and the phone shows "checked X ago" either way. */
export class QuotaSnapshots {
  private cached: { generatedAt: string; quotas: MachineQuotaInput[] } | null =
    null;
  private pending: Promise<{
    generatedAt: string;
    quotas: MachineQuotaInput[];
  }> | null = null;
  constructor(
    private readonly load: () => Promise<MachineQuotaInput[]>,
    private readonly now: () => number = Date.now,
    private readonly serveStaleMs = 0,
  ) {}
  get() {
    const age = this.cached ? this.now() - Date.parse(this.cached.generatedAt) : NaN;
    if (this.cached && age >= 0 && age < 45_000) return Promise.resolve(this.cached);
    if (this.cached && age >= 0 && age < this.serveStaleMs) {
      // A failed refresh keeps the last reading; its age stays visible.
      if (!this.pending) void this.refresh().catch(() => {});
      return Promise.resolve(this.cached);
    }
    return this.pending ?? this.refresh();
  }
  private refresh() {
    const pending = this.load()
      .then((quotas) => {
        this.cached = {
          generatedAt: new Date(this.now()).toISOString(),
          quotas,
        };
        return this.cached;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}
/** How old a quota reading may be and still be answered immediately. */
export const QUOTA_SERVE_STALE_MS = 10 * 60_000;
const stores = new Map<
  string,
  { events: MachineSnapshots; quotas: QuotaSnapshots }
>();
export function snapshotsFor(config: BurnConfig) {
  let store = stores.get(config.tokscalePin);
  if (!store) {
    store = {
      events: new MachineSnapshots(config.tokscalePin),
      quotas: new QuotaSnapshots(
        async () => tokscaleQuotaInputs(await fetchUsage(config.tokscalePin)),
        Date.now,
        QUOTA_SERVE_STALE_MS,
      ),
    };
    stores.set(config.tokscalePin, store);
  }
  return store;
}
