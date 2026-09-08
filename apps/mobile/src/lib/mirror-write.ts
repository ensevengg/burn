/**
 * Bound-row batch shared by every usage-event mirror writer.
 * 400 rows × 28 columns = 11,200 bindings, below Expo SQLite's 32,766 limit.
 */
export const EVENT_WRITE_BATCH_SIZE = 400;
