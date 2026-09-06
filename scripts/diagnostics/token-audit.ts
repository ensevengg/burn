/**
 * [DEBUG-tokaudit] Differential audit for the token-totals discrepancy.
 * Sums a burn-events JSONL dump (exactly the UnifiedMessage stream tokscale
 * aggregates — same five buckets as the app's eventTokens) by window and
 * client, so machine-side truth can be compared against the server and the
 * app headline. Throwaway diagnostic; delete once the discrepancy is closed.
 *
 * Usage: bun scripts/diagnostics/token-audit.ts <events.jsonl> [days]
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun token-audit.ts <events.jsonl> [days=90]");
  process.exit(1);
}
const days = Number(process.argv[3] ?? 90);
const cutoff = Date.now() - days * 86_400_000;

interface Buckets {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  messages: number;
  rows: number;
  cost: number;
}
const zero = (): Buckets => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, messages: 0, rows: 0, cost: 0 });
const add = (a: Buckets, b: Buckets): Buckets => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write,
  reasoning: a.reasoning + b.reasoning,
  messages: a.messages + b.messages,
  rows: a.rows + b.rows,
  cost: a.cost + b.cost,
});
const total = (b: Buckets): number => b.input + b.output + b.cache_read + b.cache_write + b.reasoning;

const allTime = new Map<string, Buckets>();
const recent = new Map<string, Buckets>();
let minTs = Infinity;
let maxTs = -Infinity;
let badRows = 0;

const lines = readFileSync(file, "utf8").split("\n");
for (const line of lines) {
  if (line.trim() === "") continue;
  let row: {
    client?: string;
    model_id?: string;
    timestamp?: number;
    message_count?: number;
    cost?: number | string;
    tokens?: { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number };
  };
  try {
    row = JSON.parse(line);
  } catch {
    badRows++;
    continue;
  }
  const ts = row.timestamp ?? 0;
  if (ts > 0) {
    minTs = Math.min(minTs, ts);
    maxTs = Math.max(maxTs, ts);
  }
  const client = row.client ?? "?";
  const b: Buckets = {
    input: row.tokens?.input ?? 0,
    output: row.tokens?.output ?? 0,
    cache_read: row.tokens?.cache_read ?? 0,
    cache_write: row.tokens?.cache_write ?? 0,
    reasoning: row.tokens?.reasoning ?? 0,
    messages: row.message_count ?? 1,
    rows: 1,
    cost: Number(row.cost ?? 0),
  };
  allTime.set(client, add(allTime.get(client) ?? zero(), b));
  if (ts >= cutoff) recent.set(client, add(recent.get(client) ?? zero(), b));
}

const fmt = (n: number) => `${(n / 1e9).toFixed(3)}B`.padStart(8);

const sum = (m: Map<string, Buckets>): Buckets => {
  let t = zero();
  for (const v of m.values()) t = add(t, v);
  return t;
};

console.log(`rows=${allTime.size > 0 ? lines.filter((l) => l.trim() !== "").length : 0} badRows=${badRows}`);
console.log(`span: ${new Date(minTs).toISOString()} .. ${new Date(maxTs).toISOString()}`);
console.log(`\n== ALL TIME by client ==`);
for (const [client, b] of [...allTime].sort((x, y) => total(y[1]) - total(x[1])))
  console.log(`${client.padEnd(12)} total=${fmt(total(b))} in=${fmt(b.input)} out=${fmt(b.output)} cacheR=${fmt(b.cache_read)} cacheW=${fmt(b.cache_write)} reason=${fmt(b.reasoning)} msgs=${b.messages} rows=${b.rows} cost=$${b.cost.toFixed(2)}`);
const at = sum(allTime);
console.log(`${"TOTAL".padEnd(12)} total=${fmt(total(at))} (buckets: in=${fmt(at.input)} out=${fmt(at.output)} cacheR=${fmt(at.cache_read)} cacheW=${fmt(at.cache_write)} reason=${fmt(at.reasoning)})`);

console.log(`\n== LAST ${days}d by client (cutoff ${new Date(cutoff).toISOString()}) ==`);
for (const [client, b] of [...recent].sort((x, y) => total(y[1]) - total(x[1])))
  console.log(`${client.padEnd(12)} total=${fmt(total(b))} in=${fmt(b.input)} out=${fmt(b.output)} cacheR=${fmt(b.cache_read)} cacheW=${fmt(b.cache_write)} reason=${fmt(b.reasoning)} msgs=${b.messages} rows=${b.rows} cost=$${b.cost.toFixed(2)}`);
const rc = sum(recent);
console.log(`${"TOTAL".padEnd(12)} total=${fmt(total(rc))} (buckets: in=${fmt(rc.input)} out=${fmt(rc.output)} cacheR=${fmt(rc.cache_read)} cacheW=${fmt(rc.cache_write)} reason=${fmt(rc.reasoning)})`);
