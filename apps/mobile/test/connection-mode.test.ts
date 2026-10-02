import { expect, test } from "bun:test";
import { readAppMode } from "../src/lib/connection-mode";
import { listDirectMachines } from "../src/lib/direct";
import { mirrorFixture } from "./mirror-fixture";

test("legacy cloud setup becomes Tailscale registrations without losing cached data or preferences", async () => {
  const fx = mirrorFixture();
  try {
    fx.native.exec(`
      insert into kv values ('mode','cloud'),('reporting_timezone','UTC'),('theme_mode','dark'),
        ('cloud_cursors_v2','old'),('cloud_membership_v2','old'),('watermark_revision','9'),
        ('direct_hash_saved','hash'),('direct_full_at_saved','100'),('direct_backfill_saved','page');
      insert into environments (id,slug,display_name,os_kind,live_endpoint) values
        ('saved','saved','Saved','linux','http://100.64.0.1:8787'),
        ('no-url','no-url','Offline','windows',null),
        ('registered','registered','Registered','wsl','http://old-address:8787');
      insert into direct_machines (id,slug,base_url,display_name,added_at) values
        ('registered','registered','http://current-address:8787','Registered','2026-10-01T00:00:00Z');
      insert into quota_snapshots (row_key,environment_id,provider,account_key,metric,status,fetched_at)
        values ('quota','saved','codex','a','weekly','ok','2026-10-01T00:00:00Z');
      insert into usage_events (event_id,environment_id,client,provider_id,model_id,session_id,occurred_at_ms)
        values ('event','saved','codex','openai','gpt','session',1000);
    `);
    expect(await readAppMode(fx.db)).toBe("direct");
    expect((await listDirectMachines(fx.db)).map((m) => [m.id, m.baseUrl])).toEqual([
      ["registered", "http://current-address:8787"], ["saved", "http://100.64.0.1:8787"],
    ]);
    expect(fx.native.query("select count(*) as n from environments").get()).toEqual({ n: 3 });
    expect(fx.native.query("select last_heartbeat_at,last_error from environments where id='no-url'").get()).toEqual({
      last_heartbeat_at: null, last_error: "Add the machine URL to resume refreshes.",
    });
    expect(fx.native.query("select event_id from usage_events").get()).toEqual({ event_id: "event" });
    expect(fx.native.query("select row_key from quota_snapshots").get()).toEqual({ row_key: "quota" });
    expect(fx.native.query("select key,value from kv order by key").all()).toEqual([
      { key: "machine_backend_v1", value: "1" }, { key: "mode", value: "direct" },
      { key: "reporting_timezone", value: "UTC" }, { key: "theme_mode", value: "dark" },
    ]);
    // Reopening must leave new cursors and reconciliation state intact.
    fx.native.exec("insert into kv values ('direct_full_at_saved','200'),('direct_hash_saved','new-hash')");
    const writes = fx.writes.length;
    expect(await readAppMode(fx.db)).toBe("direct");
    expect(fx.writes.length).toBe(writes);
  } finally { fx.native.close(); }
});

test("upgrade is atomic when a registry write fails", async () => {
  const fx = mirrorFixture();
  try {
    fx.native.exec(`
      insert into kv values ('mode','cloud'),('cloud_cursors_v2','old');
      insert into environments (id,slug,display_name,os_kind,live_endpoint)
        values ('saved','saved','Saved','linux','http://100.64.0.1:8787');
      create trigger fail_registration before insert on direct_machines
        begin select raise(abort,'registration failed'); end;
    `);
    await expect(readAppMode(fx.db)).rejects.toThrow("registration failed");
    expect(fx.native.query("select value from kv where key='mode'").get()).toEqual({ value: "cloud" });
    expect(fx.native.query("select count(*) as n from direct_machines").get()).toEqual({ n: 0 });
    expect(fx.native.query("select value from kv where key='cloud_cursors_v2'").get()).toEqual({ value: "old" });
  } finally { fx.native.close(); }
});

test("demo and unconfigured installs remain unchanged; unsupported stored modes return setup", async () => {
  const fx = mirrorFixture();
  try {
    expect(await readAppMode(fx.db)).toBe("unconfigured");
    for (const mode of ["demo", "unconfigured", "unsupported"]) {
      fx.native.query("insert or replace into kv values ('mode',?)").run(mode);
      const writes = fx.writes.length;
      expect(await readAppMode(fx.db)).toBe(mode === "demo" ? "demo" : "unconfigured");
      expect(fx.writes.length).toBe(writes);
    }
  } finally { fx.native.close(); }
});
