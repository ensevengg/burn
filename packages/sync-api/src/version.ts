/** Machine wire-format contract version. Bump on breaking payload changes. */
export const SYNC_SCHEMA_VERSION = 1;

/**
 * Tokscale version the reporter pins to (D2). Bumped via Renovate weekly;
 * fixtures in apps/reporter/fixtures gate every bump.
 */
export const TOKSCALE_PIN = "4.15.1";

/**
 * Exporter contract version (D2): the JSONL shape the `burn-events` exporter
 * emits and the reporter consumes. Bump when the payload shape changes;
 * reported by /ping as the environment's exportSchema.
 */
export const EVENT_EXPORT_SCHEMA = 1;
