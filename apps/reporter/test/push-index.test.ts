import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReporterSyncApi, IngestEventInput } from "@burn/sync-api";
import {
  configSchema,
  loadCursor,
  saveCursor,
  cursorPath,
} from "../src/config";
import { MachineSnapshots } from "../src/snapshots";
import { pushEvents } from "../src/commands";
import { indexPath, lockPush } from "../src/event-index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "burn-index-"));
  process.env["BURN_CONFIG_DIR"] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["BURN_CONFIG_DIR"];
});
const config = configSchema.parse({
  mode: "direct",
  environmentSlug: "machine",
  environmentName: "Machine",
});
const fixture = readFileSync(
  join(import.meta.dir, "../fixtures/tokscale-events.jsonl"),
  "utf8",
);

function reporter() {
  const batches: IngestEventInput[][] = [];
  let revision = 0;
  const api = {
    ingestEvents: async (events: IngestEventInput[]) => {
      batches.push(events);
      if (events.length) revision++;
      return { revision, changed: events.length };
    },
  } as ReporterSyncApi;
  return { api, batches };
}
test("unchanged scans send no rows; old pricing corrections and late old events still upload", async () => {
  let raw = fixture;
  const snapshots = new MachineSnapshots(config.tokscalePin, {
    scan: async () => raw,
    check: async () => config.tokscalePin,
    now: () => 2_000_000_000_000,
  });
  const { api, batches } = reporter();
  const first = await pushEvents(config, api, { snapshots });
  expect(first.rows).toBeGreaterThan(0);
  expect((await pushEvents(config, api, { snapshots })).rows).toBe(0);
  const rows = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows[0].cost = 0.123;
  rows.push({
    ...rows[0],
    dedup_key: "late-old",
    timestamp: rows[0].timestamp - 1000,
  });
  raw = rows.map((r) => JSON.stringify(r)).join("\n");
  await snapshots.get(true);
  const third = await pushEvents(config, api, { snapshots });
  expect(third.rows).toBe(2);
  expect(batches.at(-1)!.some((e) => e.dedupKey === "late-old")).toBe(true);
  expect(loadCursor(config).lastPushAt).toBe(
    new Date(2_000_000_000_000).toISOString(),
  );
});
test("lost acknowledgements leave the index untouched and replay every unacknowledged row", async () => {
  const snapshots = new MachineSnapshots(config.tokscalePin, {
    scan: async () => fixture,
    check: async () => config.tokscalePin,
  });
  const { api } = reporter();
  const failure = {
    ...api,
    ingestEvents: async () => {
      throw new Error("acknowledgement lost");
    },
  };
  await expect(pushEvents(config, failure, { snapshots })).rejects.toThrow(
    "acknowledgement lost",
  );
  expect(loadCursor(config).lastRevision).toBe(0);
  const result = await pushEvents(config, api, { snapshots });
  expect(result.rows).toBeGreaterThan(0);
  expect(
    Object.keys(JSON.parse(readFileSync(indexPath(config), "utf8"))).length,
  ).toBe(result.rows);
});
test("changing backend, slug or parser pin starts a separate acknowledgement scope", () => {
  saveCursor(
    { lastRevision: 50, lastPushAt: new Date().toISOString() },
    config,
  );
  writeFileSync(
    join(dir, "cursor.json"),
    JSON.stringify({ lastRevision: 999, lastPushAt: new Date().toISOString() }),
  );
  for (const c of [
    { ...config, environmentSlug: "other" },
    { ...config, supabaseUrl: "https://other.supabase.co" },
    { ...config, tokscalePin: "different" },
    { ...config, ingestToken: "rotated-token-0123456789012345" },
  ]) {
    expect(cursorPath(c)).not.toBe(cursorPath(config));
    expect(loadCursor(c).lastRevision).toBe(0);
  }
});

test("a concurrent process lock blocks a second push and releases after failure", () => {
  const release = lockPush(config);
  expect(() => lockPush(config)).toThrow("still running");
  release();
  const next = lockPush(config);
  next();
});
