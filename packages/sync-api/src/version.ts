/** Wire-format contract version. Bump when an RPC's payload shape changes. */
export const SYNC_SCHEMA_VERSION = 1;

/**
 * Tokscale version the reporter pins to (D2). Bumped via Renovate weekly;
 * fixtures in apps/reporter/fixtures gate every bump.
 */
export const TOKSCALE_PIN = "4.15.1";

/** Exporter wire schema emitted by `burn-events` (see D2). */
export const EVENT_EXPORT_SCHEMA = 1;
