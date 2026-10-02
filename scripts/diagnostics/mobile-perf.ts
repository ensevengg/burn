import {
  queryQuotas,
  computeGranularityMax,
  queryGranularityMax,
  type EventRow,
} from "../../apps/mobile/src/data/repository";
import type { SQLiteDatabase } from "expo-sqlite";
import { mirrorFixture } from "../../apps/mobile/test/mirror-fixture";
const rows = Array.from(
  { length: 27000 },
  (_, i) =>
    ({
      occurredAtMs: Date.UTC(2026, 0, 1) + i * 60000,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0.01,
    }) as EventRow,
);
const started = performance.now();
const tick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
computeGranularityMax(rows, "Asia/Kolkata", "daily");
console.log(
  JSON.stringify({
    case: "27000 events historical peak",
    elapsedMs: Math.round(performance.now() - started),
    timerDelayMs: Math.round(await tick),
  }),
);
const quotaFixture = mirrorFixture();
const db = quotaFixture.native;
const insert = db.prepare(`insert into quota_snapshots
  (row_key, provider, account_key, account_label, plan, metric, used_percent,
   remaining_percent, remaining_label, resets_at, fetched_at, status)
  values (?, 'Codex', ?, ?, 'chatgpt_plus', 'weekly', ?, ?, null, null, ?, 'ok')`);
const put = (key: string, label: string, time: string, used: number) =>
  insert.run(`${key}|${time}`, key, label, used, 100 - used, time);
const adapter = quotaFixture.db;
put("same-account", "Personal", "2026-09-06T10:00:00Z", 20);
put("same-account", "Personal", "2026-09-06T11:00:00Z", 50);
console.log(
  JSON.stringify({ case: "same account and label, newer Windows", cards: await queryQuotas(adapter) }),
);
db.exec("delete from quota_snapshots");
put("same-account", "CachyOS label", "2026-09-06T10:00:00Z", 20);
put("same-account", "Windows label", "2026-09-06T11:00:00Z", 50);
console.log(
  JSON.stringify({
    case: "same account, different labels, expect 1",
    actual: (await queryQuotas(adapter)).length,
  }),
);
db.exec("delete from quota_snapshots");
put("account-one", "Personal", "2026-09-06T10:00:00Z", 20);
put("account-two", "Personal", "2026-09-06T11:00:00Z", 50);
console.log(
  JSON.stringify({
    case: "different accounts, same label, expect 2",
    actual: (await queryQuotas(adapter)).length,
  }),
);
db.close();
// Exercise the production asynchronous query while a timer represents pending input.
const rawRows = rows.map((e) => ({
  occurred_at_ms: e.occurredAtMs,
  input_tokens: e.inputTokens,
  output_tokens: e.outputTokens,
  cache_read_tokens: e.cacheReadTokens,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  cost: "0.01",
  cost_is_complete: 1,
  duration_ms: null,
}));
const queryDb = { getAllAsync: async () => rawRows } as unknown as SQLiteDatabase;
const queryStarted = performance.now();
let lastTick = queryStarted;
let maxGap = 0;
let ticks = 0;
const inputTimer = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
  ticks++;
}, 0);
try {
  await queryGranularityMax(queryDb, "Asia/Kolkata", "daily");
  console.log(
    JSON.stringify({
      case: "27000 events cooperative screen query (mock native read)",
      elapsedMs: Math.round(performance.now() - queryStarted),
      timerTicks: ticks,
      maxTimerGapMs: Math.round(maxGap),
    }),
  );
} finally {
  clearInterval(inputTimer);
}
