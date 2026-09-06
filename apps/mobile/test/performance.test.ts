import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { queryQuotas } from "../src/data/repository";
import { calendarParts } from "../src/lib/format";

describe("quota account identity", () => {
  test("freshest machine wins across labels without merging separate accounts", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`create table quota_snapshots(provider text, account_key text, account_label text, plan text,
        metric text, used_percent real, remaining_label text, resets_at text, fetched_at text, status text)`);
      const insert = db.prepare(
        "insert into quota_snapshots values ('Codex', ?, ?, null, 'weekly', ?, null, null, ?, 'ok')",
      );
      insert.run("one", "Linux", 20, "2026-09-06T10:00:00Z");
      insert.run("one", "Personal", 50, "2026-09-06T11:00:00Z");
      insert.run("two", "Personal", 70, "2026-09-06T12:00:00Z");
      const adapter = {
        getAllAsync: async (sql: string) => db.query(sql).all(),
      } as unknown as SQLiteDatabase;
      const cards = await queryQuotas(adapter);
      expect(cards.map((q) => [q.accountKey, q.usedPercent]).sort()).toEqual([
        ["one", 50],
        ["two", 70],
      ]);
    } finally {
      db.close();
    }
  });
});

test("calendar bucketing reuses a formatter across distinct timestamps", () => {
  const Native = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(Native, {
    construct(target, args) {
      constructions++;
      return Reflect.construct(target, args);
    },
  });
  try {
    for (let i = 0; i < 100; i++) calendarParts(Date.UTC(2025, 0, 1) + i * 1000, "Pacific/Auckland");
    expect(constructions).toBeLessThanOrEqual(1);
  } finally {
    Intl.DateTimeFormat = Native;
  }
});
