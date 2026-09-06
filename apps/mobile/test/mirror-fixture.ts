import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { SQLiteDatabase } from "expo-sqlite";

/** Execute the actual mirror DDL and SQL without loading React Native. */
export function mirrorFixture() {
  const native = new Database(":memory:");
  const source = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
  const schema = source.match(/db\.execAsync\(`([\s\S]*?)`\)/)![1]!;
  native.exec(schema);
  const writes: { sql: string; count: number }[] = [];
  let readRows = 0;
  const db = {
    getFirstAsync: async (sql: string, params: SQLQueryBindings[] = []) => native.query(sql).get(...params),
    getAllAsync: async (sql: string, params: SQLQueryBindings[] = []) => {
      const rows = native.query(sql).all(...params);
      readRows += rows.length;
      return rows;
    },
    runAsync: async (sql: string, params: SQLQueryBindings[] = []) => {
      writes.push({ sql, count: params.length });
      return native.query(sql).run(...params);
    },
    withTransactionAsync: async (work: () => Promise<void>) => {
      native.exec("begin");
      try {
        await work();
        native.exec("commit");
      } catch (err) {
        native.exec("rollback");
        throw err;
      }
    },
  } as unknown as SQLiteDatabase;
  return {
    db,
    native,
    writes,
    get readRows() {
      return readRows;
    },
  };
}
