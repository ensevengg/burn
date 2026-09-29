import { createHash } from "node:crypto";
import type { IngestEventInput, IngestQuotaInput } from "@burn/sync-api";
import type { BurnConfig } from "./config";
import { parseEventsJsonl, exportRowsToIngestInputs } from "./events";
import {
  exporterVersion,
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
  events: IngestEventInput[];
}
interface SnapshotDeps {
  now?: () => number;
  scan?: (sinceMs: number) => Promise<string>;
  check?: () => Promise<string | null>;
  ttlMs?: number;
}

/** A normalized full snapshot covers every requested window. One scan promise
 * is shared by HTTP and daemon push; old generations remain briefly pageable. */
export class MachineSnapshots {
  private latest: MachineSnapshot | null = null;
  private pending: Promise<MachineSnapshot> | null = null;
  private checkedAt = -Infinity;
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
  get(force = false): Promise<MachineSnapshot> {
    if (this.pending) return this.pending;
    if (
      !force &&
      this.latest &&
      this.now() >= Date.parse(this.latest.generatedAt) &&
      this.now() - Date.parse(this.latest.generatedAt) <
        (this.deps.ttlMs ?? 30_000)
    )
      return Promise.resolve(this.latest);
    const pending = this.scan().finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
  private async scan(): Promise<MachineSnapshot> {
    if (this.now() < this.checkedAt || this.now() - this.checkedAt >= 300_000) {
      const version = await (this.deps.check ?? exporterVersion)();
      if (version === null)
        throw new Error("burn-events exporter not found on this machine");
      assertExporterMatchesPin(version, this.pin);
      this.checkedAt = this.now();
    }
    const startedAtMs = this.now();
    const rows = parseEventsJsonl(
      await (this.deps.scan ?? ((since) => fetchEventsJsonl(since, 90_000)))(0),
    );
    const events = exportRowsToIngestInputs(rows, this.pin).sort(
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

export class QuotaSnapshots {
  private cached: { generatedAt: string; quotas: IngestQuotaInput[] } | null =
    null;
  private pending: Promise<{
    generatedAt: string;
    quotas: IngestQuotaInput[];
  }> | null = null;
  constructor(
    private readonly load: () => Promise<IngestQuotaInput[]>,
    private readonly now: () => number = Date.now,
  ) {}
  get() {
    if (this.pending) return this.pending;
    if (
      this.cached &&
      this.now() >= Date.parse(this.cached.generatedAt) &&
      this.now() - Date.parse(this.cached.generatedAt) < 45_000
    )
      return Promise.resolve(this.cached);
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
const stores = new Map<
  string,
  { events: MachineSnapshots; quotas: QuotaSnapshots }
>();
export function snapshotsFor(config: BurnConfig) {
  let store = stores.get(config.tokscalePin);
  if (!store) {
    store = {
      events: new MachineSnapshots(config.tokscalePin),
      quotas: new QuotaSnapshots(async () =>
        tokscaleQuotaInputs(await fetchUsage(config.tokscalePin)),
      ),
    };
    stores.set(config.tokscalePin, store);
  }
  return store;
}
