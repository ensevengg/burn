/**
 * Serializes mirror-writing scopes on the single SQLite connection.
 *
 * expo-sqlite's withTransactionAsync is not reentrant: two overlapping scopes
 * interleave their BEGIN/COMMIT/ROLLBACK statements, the loser's cleanup
 * ROLLBACK tears down the winner's transaction, and the winner then fails
 * with "cannot rollback - no transaction is active". Every mirror writer
 * (cloud sync pages, demo seed, resets, machine removal) holds this lock for
 * its whole body; callers must never nest it.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task);
  // A rejected task must not poison the chain — only the caller sees the error.
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
