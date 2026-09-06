/**
 * burn-events JSONL contract (D2): a versioned mirror of tokscale-core's
 * serialized UnifiedMessage plus burn's timezone evidence. Field names match
 * upstream serde on purpose — when the intended upstream
 * `tokscale events --jsonl` export lands, its output parses with the same
 * schema (the optional fields cover the small deltas: null/empty dedup_key,
 * missing timezone enrichment, numeric cost).
 */
import { normalizeCostSource, type IngestEventInput } from "@burn/sync-api";
import { z } from "zod";

export const eventExportRowSchema = z.object({
  client: z.string().min(1),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  session_id: z.string().min(1),
  session_title: z.string().nullable().optional(),
  workspace_key: z.string().nullable().optional(),
  workspace_label: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  /** Authoritative UTC instant, epoch ms (tokscale UnifiedMessage.timestamp). */
  timestamp: z.number().int().positive(),
  /** Tokscale's derived calendar day — burn's source_local_date evidence. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number(),
    cache_write: z.number(),
    reasoning: z.number(),
  }),
  /** serde f64 upstream; decimal strings accepted for forward compatibility. */
  cost: z.union([z.number(), z.string()]),
  cost_source: z.string(),
  duration_ms: z.number().int().nullable().optional(),
  message_count: z.number().int().optional(),
  is_turn_start: z.boolean().optional(),
  model_attribution_conflicted: z.boolean().optional(),
  /**
   * The exporter guarantees non-empty via the D2 fallback; null/empty is
   * tolerated so an upstream stream without the fallback still pushes.
   */
  dedup_key: z.string().nullable().optional(),
  /** Enrichment; optional so an upstream stream without it still validates. */
  source_offset_minutes: z.number().int().optional(),
  source_timezone: z.string().nullable().optional(),
});
export type EventExportRow = z.infer<typeof eventExportRowSchema>;

/** D2: every payload is schema-validated; on mismatch, fail loudly. */
export function parseEventsJsonl(text: string): EventExportRow[] {
  const rows: EventExportRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`burn-events line ${i + 1}: invalid JSON — ${(err as Error).message}`);
    }
    const parsed = eventExportRowSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `burn-events line ${i + 1} schema drift at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"} (tokscale output changed? check the pin)`,
      );
    }
    rows.push(parsed.data);
  }
  return rows;
}

/** D8: cost is a decimal string on the wire; the server column is numeric(14,6). */
export function costToDecimalString(cost: number | string): string {
  const value = typeof cost === "string" ? Number(cost) : cost;
  if (!Number.isFinite(value)) throw new Error(`non-numeric cost: ${JSON.stringify(cost)}`);
  return value.toFixed(6);
}

function cmp(a: string | null | undefined, b: string | null | undefined): number {
  return a === b ? 0 : (a ?? "") < (b ?? "") ? -1 : 1;
}

/** Mirrors the exporter's content comparator so ordinals agree on both sides. */
function contentCmp(a: EventExportRow, b: EventExportRow): number {
  return (
    a.timestamp - b.timestamp ||
    cmp(a.client, b.client) ||
    cmp(a.model_id, b.model_id) ||
    cmp(a.provider_id, b.provider_id) ||
    a.tokens.input - b.tokens.input ||
    a.tokens.output - b.tokens.output ||
    a.tokens.cache_read - b.tokens.cache_read ||
    a.tokens.cache_write - b.tokens.cache_write ||
    a.tokens.reasoning - b.tokens.reasoning ||
    Number(a.cost) - Number(b.cost) ||
    (a.duration_ms ?? 0) - (b.duration_ms ?? 0) ||
    (a.message_count ?? 1) - (b.message_count ?? 1) ||
    Number(a.is_turn_start ?? false) - Number(b.is_turn_start ?? false) ||
    cmp(a.agent, b.agent) ||
    cmp(a.session_title, b.session_title) ||
    cmp(a.workspace_key, b.workspace_key)
  );
}

/**
 * D2 fallback dedup key for sources tokscale leaves without one — same recipe
 * as the exporter: `v1:<client>:<session_id>:<source_ts_ms>:<ordinal>`, where
 * ordinal is the content-sorted position within the session. Applied here too
 * so an upstream `tokscale events --jsonl` stream (null dedup_key) pushes
 * without touching the exporter.
 */
export function deriveDedupKeys(rows: EventExportRow[]): void {
  const missing = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!row.dedup_key) {
      const group = `${row.client}|${row.session_id}`;
      const indices = missing.get(group);
      if (indices === undefined) missing.set(group, [index]);
      else indices.push(index);
    }
  });
  for (const indices of missing.values()) {
    indices.sort((a, b) => contentCmp(rows[a]!, rows[b]!));
    for (const [ord, index] of indices.entries()) {
      const row = rows[index]!;
      row.dedup_key = `v1:${row.client}:${row.session_id}:${row.timestamp}:${ord + 1}`;
    }
  }
}

export function exportRowToIngestInput(row: EventExportRow, tokscalePin: string): IngestEventInput {
  const costSource = normalizeCostSource(row.cost_source);
  const conflicted = row.model_attribution_conflicted ?? false;
  return {
    client: row.client,
    providerId: row.provider_id,
    modelId: row.model_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? null,
    workspaceKey: row.workspace_key ?? null,
    workspaceLabel: row.workspace_label ?? null,
    agent: row.agent ?? null,
    occurredAtMs: row.timestamp,
    // Enrichment shim: an upstream stream without offsets gets this machine's.
    sourceOffsetMinutes: row.source_offset_minutes ?? -new Date().getTimezoneOffset(),
    sourceTimezone: row.source_timezone ?? null,
    sourceLocalDate: row.date,
    inputTokens: row.tokens.input,
    outputTokens: row.tokens.output,
    cacheReadTokens: row.tokens.cache_read,
    cacheWriteTokens: row.tokens.cache_write,
    reasoningTokens: row.tokens.reasoning,
    messageCount: row.message_count ?? 1,
    isTurnStart: row.is_turn_start ?? false,
    durationMs: row.duration_ms ?? null,
    cost: costToDecimalString(row.cost),
    costSource,
    // unknown source = pricing missing; conflicted rows stay unpriced upstream.
    costIsComplete: costSource !== "unknown" && !conflicted,
    modelAttributionConflicted: conflicted,
    parserVersion: `tokscale-${tokscalePin}`,
    dedupKey: row.dedup_key ?? "",
  };
}

export function exportRowsToIngestInputs(
  rows: EventExportRow[],
  tokscalePin: string,
): IngestEventInput[] {
  deriveDedupKeys(rows);
  return rows.map((row) => {
    if (!row.dedup_key) {
      throw new Error("burn-events row without dedup_key after fallback derivation");
    }
    return exportRowToIngestInput(row, tokscalePin);
  });
}

/**
 * Re-send window: a message completed just after the last scan is caught by
 * the next push's overlap. Re-upserts are server-side no-ops for unchanged
 * content (revision does not advance), so a generous window is cheap.
 */
export const PUSH_OVERLAP_MS = 60 * 60_000;

/** Push everything (`--full`) or since the last acknowledged batch, minus overlap. */
export function pushSinceMs(lastPushAt: string, full: boolean): number {
  if (full) return 0;
  const last = Date.parse(lastPushAt);
  const base = Number.isFinite(last) ? last : 0;
  return Math.max(0, base - PUSH_OVERLAP_MS);
}

export function planBatches<T>(items: readonly T[], size = 500): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
