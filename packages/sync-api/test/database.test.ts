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
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrations, file), "utf8"));
  }
}, 30_000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("truncate burn.environments cascade; truncate burn.read_tokens;");
  await db.query("insert into burn.read_tokens(token_hash) values (encode(sha256(convert_to($1,'utf8')),'hex'))", [readToken]);
  await db.query("insert into burn.environments(slug,display_name,os_kind,ingest_token_hash) values ('machine','Machine','linux',encode(sha256(convert_to($1,'utf8')),'hex'))", [ingestToken]);
});

test("quota RPC rejects missing, invalid and revoked read tokens for anonymous callers", async () => {
  await db.exec("set role anon;");
  try {
    for (const token of [null, "invalid-token-01234567890123456789"]) {
      await expect(db.query("select public.burn_fetch_quota_latest($1)", [token])).rejects.toThrow("invalid read token");
    }
    const result = await db.query<{ value: unknown }>("select public.burn_fetch_quota_latest($1) as value", [readToken]);
    expect(result.rows[0]?.value).toEqual([]);
  } finally {
    await db.exec("reset role;");
  }
  await db.exec("update burn.read_tokens set revoked_at=now(); set role anon;");
  try {
    await expect(db.query("select public.burn_fetch_quota_latest($1)", [readToken])).rejects.toThrow("invalid read token");
  } finally {
    await db.exec("reset role;");
  }
});
