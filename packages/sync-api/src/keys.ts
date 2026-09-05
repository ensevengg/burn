import type { CostSource } from "./types";

/**
 * Upsert key definitions (engineering convention: dedup keys live HERE, not at
 * call sites).
 *
 * usage_events.event_id = sha256( environment_slug | client | dedup_key )
 *   - computed server-side by burn_api.ingest_events; the reporter never
 *     invents IDs.
 *   - `dedup_key` must be stable across rescans of the same source message.
 *     Tokscale's UnifiedMessage.dedup_key is authoritative. For sources where
 *     tokscale has none, the exporter (D2) derives one deterministically from
 *     session identity + source-local timestamp + message ordinal, versioned:
 *     `v1:<client>:<session_id>:<source_ts_ms>:<ordinal>`.
 *   - Identity columns never change after insert; content corrections
 *     (pricing/parser fixes) upsert in place and advance the environment
 *     revision, which propagates to phones via the revision watermark.
 *
 * quota_snapshots: append-only, no dedup key — freshness selection happens at
 * read time per (provider, account_key, metric).
 *
 * environments: natural key = slug (one reporter installation each; `windows`
 * and `wsl` are distinct slugs sharing a host_group).
 */

export function eventIdentityDescription(): string {
  return "sha256(environment_slug | client | dedup_key)";
}

/** Quota account key: stable per provider account. Falls back safely. */
export function quotaAccountKey(providerAccountId: string | null | undefined): string {
  const trimmed = providerAccountId?.trim();
  return trimmed ? trimmed : "no-account";
}

/** Metric label derived from a tokscale usage metric row. */
export function quotaMetricLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_") || "unknown";
}

export function normalizeCostSource(raw: string | null | undefined): CostSource {
  switch (raw) {
    case "provider_reported":
    case "providerReported":
      return "provider_reported";
    case "estimated":
      return "estimated";
    default:
      return "unknown";
  }
}
