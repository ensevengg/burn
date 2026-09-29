import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const readToken = "test-phone-token-0123456789012345";
const ingestToken = "test-ingest-token-0123456789012345";
const db = new PGlite();
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated;");
  const migrations = join(import.meta.dir, "../../../supabase/migrations");
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(join(migrations, file), "utf8"));
  }
}, 30_000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(
    "truncate burn.environments cascade; truncate burn.read_tokens;",
  );
  await db.query(
    "insert into burn.read_tokens(token_hash) values (encode(sha256(convert_to($1,'utf8')),'hex'))",
    [readToken],
  );
  await db.query(
    "insert into burn.environments(slug,display_name,os_kind,ingest_token_hash) values ('machine','Machine','linux',encode(sha256(convert_to($1,'utf8')),'hex'))",
    [ingestToken],
  );
});

test("quota RPC rejects missing, invalid and revoked read tokens for anonymous callers", async () => {
  await db.exec("set role anon;");
  try {
    for (const token of [null, "invalid-token-01234567890123456789"]) {
      await expect(
        db.query("select public.burn_fetch_quota_latest($1)", [token]),
      ).rejects.toThrow("invalid read token");
    }
    const result = await db.query<{ value: unknown }>(
      "select public.burn_fetch_quota_latest($1) as value",
      [readToken],
    );
    expect(result.rows[0]?.value).toEqual([]);
  } finally {
    await db.exec("reset role;");
  }
  await db.exec("update burn.read_tokens set revoked_at=now(); set role anon;");
  try {
    await expect(
      db.query("select public.burn_fetch_quota_latest($1)", [readToken]),
    ).rejects.toThrow("invalid read token");
  } finally {
    await db.exec("reset role;");
  }
});

async function ingest(token: string, keys: string[]) {
  const events = keys.map((key) => ({
    client: "codex",
    provider_id: "openai",
    model_id: "gpt",
    session_id: "s",
    occurred_at_ms: 1_780_000_000_000,
    dedup_key: key,
    cost: "0.000001",
  }));
  await db.query("select public.burn_ingest_events($1,$2::jsonb)", [
    token,
    JSON.stringify(events),
  ]);
}
async function delta(
  cursors: Record<string, { revision: number; eventId: string }> = {},
  limit = 2,
) {
  const result = await db.query<{
    value: {
      events: { event_id: string; revision: number }[];
      cursors: typeof cursors;
      has_more: boolean;
    };
  }>("select public.burn_fetch_delta_v2($1,$2::jsonb,$3) as value", [
    readToken,
    JSON.stringify(cursors),
    limit,
  ]);
  return result.rows[0]!.value;
}

test("paged cloud deltas retain tied revisions and idle cursors", async () => {
  await ingest(ingestToken, ["a", "b", "c"]);
  const first = await delta();
  expect(first.events).toHaveLength(2);
  expect(first.has_more).toBe(true);
  const second = await delta(first.cursors);
  expect(second.events).toHaveLength(1);
  expect(second.has_more).toBe(false);
  expect(
    new Set([...first.events, ...second.events].map((event) => event.event_id))
      .size,
  ).toBe(3);
  const idle = await delta(second.cursors);
  expect(idle.events).toEqual([]);
  expect(idle.cursors).toEqual(second.cursors);
  expect(idle.has_more).toBe(false);
});

test("a new low-revision machine is fetched after another machine reaches a higher revision", async () => {
  for (let i = 0; i < 5; i++) await ingest(ingestToken, [`a-${i}`]);
  const first = await delta({}, 20);
  const token = "second-machine-token-0123456789012";
  await db.query(
    "insert into burn.environments(slug,display_name,os_kind,ingest_token_hash) values ('second','Second','linux',encode(sha256(convert_to($1,'utf8')),'hex'))",
    [token],
  );
  await ingest(token, ["b-first"]);
  const second = await delta(first.cursors);
  expect(second.events).toHaveLength(1);
  expect(second.events[0]?.revision).toBe(1);
});

test("broadcast refresh remains deliverable to every reporter and failed work can retry", async () => {
  const token = "second-machine-token-0123456789012";
  await db.query(
    "insert into burn.environments(slug,display_name,os_kind,ingest_token_hash) values ('second','Second','linux',encode(sha256(convert_to($1,'utf8')),'hex'))",
    [token],
  );
  await db.query("select public.burn_request_sync($1)", [readToken]);
  const poll = async (t: string) =>
    (
      await db.query<{ value: { requests: { generation: number }[] } }>(
        "select public.burn_poll_sync_requests($1) as value",
        [t],
      )
    ).rows[0]!.value.requests;
  const first = await poll(ingestToken);
  const second = await poll(token);
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(await poll(ingestToken)).toHaveLength(0);
  await db.query(
    "select public.burn_complete_sync_requests($1,$2::jsonb,false)",
    [ingestToken, JSON.stringify(first.map((r) => r.generation))],
  );
  await db.exec(
    "update burn.sync_deliveries set lease_until=now()-interval '1 second' where completed_at is null",
  );
  expect(await poll(ingestToken)).toHaveLength(1);
  await db.query(
    "select public.burn_complete_sync_requests($1,$2::jsonb,true)",
    [ingestToken, JSON.stringify(first.map((r) => r.generation))],
  );
  expect(await poll(ingestToken)).toHaveLength(0);
});

test("heartbeat and quota success cannot erase an event failure or claim an event upload", async () => {
  await db.exec("set role anon");
  try {
    await db.query(
      "select public.burn_report_channel_error($1,'exporter failed','events')",
      [ingestToken],
    );
    await db.query("select public.burn_heartbeat($1,'{}')", [ingestToken]);
    await db.query("select public.burn_push_quota_snapshot($1,'[]')", [
      ingestToken,
    ]);
    const env = (
      await db.query<{
        value: {
          environments: {
            last_error: string;
            last_success_at: string | null;
          }[];
        };
      }>("select public.burn_fetch_delta_v2($1) as value", [readToken])
    ).rows[0]!.value.environments[0]!;
    expect(env.last_error).toBe("exporter failed");
    expect(env.last_success_at).toBeNull();
    await db.query("select public.burn_ingest_events($1,'[]')", [ingestToken]);
    await expect(
      db.query(
        "select public.burn_report_channel_error('invalid','error','events')",
      ),
    ).rejects.toThrow("invalid ingest token");
    await expect(
      db.query("select burn_api._ingest_events($1,'[]')", [ingestToken]),
    ).rejects.toThrow();
  } finally {
    await db.exec("reset role");
  }
  const result = await db.query<{
    latest_revision: number;
    last_error: string | null;
    last_event_success_at: unknown;
  }>(
    "select latest_revision,last_error,last_event_success_at from burn.environments",
  );
  expect(result.rows[0]!.latest_revision).toBe(0);
  expect(result.rows[0]!.last_error).toBeNull();
  expect(result.rows[0]!.last_event_success_at).not.toBeNull();
});

test("quota retries retain source collection time and create one snapshot", async () => {
  const payload = JSON.stringify([
    {
      provider: "codex",
      account_key: "a",
      metric: "5h",
      used_percent: 40,
      status: "ok",
      fetched_at: "2026-09-29T10:00:00Z",
    },
  ]);
  for (let i = 0; i < 2; i++)
    await db.query("select public.burn_push_quota_snapshot($1,$2)", [
      ingestToken,
      payload,
    ]);
  expect(
    (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from burn.quota_snapshots",
      )
    ).rows[0]!.count,
  ).toBe(1);
  const result = await db.query<{ value: { fetched_at: string }[] }>(
    "select public.burn_fetch_quota_latest($1) as value",
    [readToken],
  );
  expect(Date.parse(result.rows[0]!.value[0]!.fetched_at)).toBe(
    Date.parse("2026-09-29T10:00:00Z"),
  );
});

test("read RPCs reject invalid tokens and malformed continuation state", async () => {
  await db.exec("set role anon");
  try {
    await expect(
      db.query("select public.burn_fetch_delta_v2('invalid')"),
    ).rejects.toThrow("invalid read token");
    await expect(
      db.query(
        'select public.burn_fetch_delta_v2($1,\'{"env":{"revision":0}}\')',
        [readToken],
      ),
    ).rejects.toThrow("invalid cursor");
  } finally {
    await db.exec("reset role");
  }
});
