/** Wire-format contract version. Bump when an RPC's payload shape changes. */
export const SYNC_SCHEMA_VERSION = 1;

/**
 * Tokscale version the reporter pins to (D2). Bumped via Renovate weekly;
 * fixtures in apps/reporter/fixtures gate every bump.
 */
export const TOKSCALE_PIN = "4.15.1";
// EVENT_EXPORT_SCHEMA returns with D2's `burn-events` exporter — the constant
// was dead until then (first-check C3) and was removed to keep that honest.
