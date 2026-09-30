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

test("a crashed recovery owner and old empty recovery guard do not block future uploads", async () => {
  const { utimesSync } = await import("node:fs");
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
  await child.exited;
  const path = `${indexPath(config)}.lock`;
  for (const recovery of [String(child.pid), ""]) {
    writeFileSync(path, String(child.pid));
    writeFileSync(`${path}.recovery`, recovery);
    utimesSync(`${path}.recovery`, new Date(0), new Date(0));
    const release = lockPush(config);
    expect(() => lockPush(config)).toThrow("still running");
    release();
  }
});

test("competing reporter processes recover a dead owner and never overlap writes", async () => {
  const { utimesSync } = await import("node:fs");
  const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
  await dead.exited;
  const path = `${indexPath(config)}.lock`;
  writeFileSync(path, String(dead.pid));
  writeFileSync(`${path}.recovery`, "");
  utimesSync(`${path}.recovery`, new Date(0), new Date(0));
  const source = `
    const { lockPush } = await import(${JSON.stringify(new URL("../src/event-index.ts", import.meta.url).pathname)});
    const { openSync,closeSync,unlinkSync } = await import('node:fs');
    const config = ${JSON.stringify(config)};
    for(let i=0;i<20;i++) {
      let release;
      for(let attempt=0;attempt<500;attempt++) {
        try { release=lockPush(config); break; }
        catch(err) { if(!/retry|still running/.test(err.message)) throw err; await Bun.sleep(2); }
      }
      if(!release) throw new Error('lock starved');
      const marker = ${JSON.stringify(join(dir, "active-writer"))};
      const fd = openSync(marker,'wx');
      await Bun.sleep(2);
      closeSync(fd); unlinkSync(marker); release();
    }
  `;
  const workers = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BURN_CONFIG_DIR: dir },
    }),
  );
  const results = await Promise.all(
    workers.map(async (worker) => ({
      code: await worker.exited,
      error: await new Response(worker.stderr).text(),
    })),
  );
  expect(results).toEqual(Array(8).fill({ code: 0, error: "" }));
}, 20_000);

test("a killed reporter's published owner directory is recoverable immediately", async () => {
  const source = `const {lockPush}=await import(${JSON.stringify(new URL("../src/event-index.ts", import.meta.url).pathname)}); lockPush(${JSON.stringify(config)}); console.log('owned'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BURN_CONFIG_DIR: dir },
  });
  try {
    expect(
      new TextDecoder().decode((await child.stdout.getReader().read()).value),
    ).toContain("owned");
    expect(() => lockPush(config)).toThrow("still running");
    child.kill("SIGKILL");
    await child.exited;
    const release = lockPush(config);
    release();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
