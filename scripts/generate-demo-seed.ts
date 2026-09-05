/**
 * Generates supabase/seed/demo.sql from the shared demo dataset. Run:
 *   bun scripts/generate-demo-seed.ts
 * The seed registers demo environments with FIXED, documented demo tokens —
 * for trying the phone against a throwaway project only, never production.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDemoDataset } from "../apps/mobile/src/data/demo-generator.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = generateDemoDataset();

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const DEMO_READ_TOKEN = "burn-demo-read-token-0123456789abcdef";
const ingestToken = (slug: string) => `burn-demo-ingest-${slug}-0123456789abcdef`;

const slugToId: Record<string, string> = {
  cachyos: "11111111-1111-4111-8111-111111111111",
  windows: "22222222-2222-4222-8222-222222222222",
  wsl: "33333333-3333-4333-8333-333333333333",
};

const q = (value: string | null): string => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`);

const lines: string[] = [
  `-- burn · demo seed (generated ${new Date().toISOString()} by scripts/generate-demo-seed.ts)`,
  `-- Demo tokens (FIXED, for throwaway projects only):`,
  `--   read token:   ${DEMO_READ_TOKEN}`,
  ...dataset.environments.map((e) => `--   ${e.slug.padEnd(8)} ingest: ${ingestToken(e.slug)}`),
  ``,
  `delete from burn.usage_events;`,
  `delete from burn.quota_snapshots;`,
  `delete from burn.sync_requests;`,
  `delete from burn.environments;`,
  `delete from burn.read_tokens;`,
  ``,
  `insert into burn.read_tokens (token_hash, label) values ('${sha256Hex(DEMO_READ_TOKEN)}', 'demo-phone');`,
];

for (const env of dataset.environments) {
  lines.push(
    `insert into burn.environments (id, slug, display_name, host_group, os_kind, ingest_token_hash, reporting_timezone, latest_revision, last_heartbeat_at, last_success_at)\n` +
      `values ('${slugToId[env.slug]!}', '${env.slug}', ${q(env.displayName)}, ${q(env.hostGroup)}, '${env.osKind}', '${sha256Hex(ingestToken(env.slug))}', '${env.reportingTimezone}', 1, now(), now());`,
  );
}

const envId = (slug: string) => `'${slugToId[slug]!}'`;

// Events, batched at 250 rows per INSERT.
const ROW = (e: (typeof dataset.events)[number]) =>
  `('${sha256Hex(e.eventId)}', ${envId(e.environmentSlug)}, '${e.client}', '${e.providerId}', '${e.modelId}', '${e.sessionId}', ${q(e.sessionTitle)}, ${q(e.workspaceKey)}, ${q(e.workspaceLabel)}, ${q(e.agent)}, to_timestamp(${(e.occurredAtMs / 1000).toFixed(3)}), ${e.sourceOffsetMinutes}, ${q(e.sourceTimezone)}, '${e.sourceLocalDate}', ${e.inputTokens}, ${e.outputTokens}, ${e.cacheReadTokens}, ${e.cacheWriteTokens}, ${e.reasoningTokens}, ${e.messageCount}, ${e.isTurnStart}, ${e.durationMs}, ${e.cost}, '${e.costSource}', ${e.costIsComplete}, ${e.modelAttributionConflicted}, '${e.parserVersion}', ${e.revision})`;

const COLS =
  `(event_id, environment_id, client, provider_id, model_id, session_id, session_title, workspace_key, workspace_label, agent, occurred_at, source_offset_minutes, source_timezone, source_local_date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, message_count, is_turn_start, duration_ms, cost, cost_source, cost_is_complete, model_attribution_conflicted, parser_version, revision)`;

lines.push(``, `-- ${dataset.events.length} usage events`);
for (let i = 0; i < dataset.events.length; i += 250) {
  const batch = dataset.events.slice(i, i + 250);
  lines.push(`insert into burn.usage_events ${COLS} values\n${batch.map(ROW).join(",\n")};`);
}

lines.push(``, `-- quota snapshots`);
for (const quota of dataset.quotas) {
  lines.push(
    `insert into burn.quota_snapshots (environment_id, provider, account_key, account_label, plan, metric, used_percent, remaining_percent, remaining_label, resets_at, status, error, fetched_at, source_offset_minutes)\n` +
      `values (${envId(quota.environmentSlug)}, '${quota.provider}', '${quota.accountKey}', ${q(quota.accountLabel)}, ${q(quota.plan)}, '${quota.metric}', ${quota.usedPercent}, ${quota.remainingPercent}, ${q(quota.remainingLabel)}, ${q(quota.resetsAt)}, '${quota.status}', null, now() - interval '${quota.ageMinutes} minutes', 330);`,
  );
}

const out = join(root, "supabase", "seed", "demo.sql");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(
  `wrote ${out}: ${dataset.environments.length} environments, ${dataset.events.length} events, ${dataset.quotas.length} quota snapshots`,
);
