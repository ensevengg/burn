/** A bounded follow-up window covers the daemon's 30s poll plus export/upload. */
export async function followMachineUpdates(
  signal: AbortSignal,
  pull: () => Promise<void>,
  options: {
    now?: () => number;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    durationMs?: number;
    /** Fired once the first pull settles (or the loop exits early) — releases the refresh spinner. */
    onSettle?: () => void;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableWait;
  const deadline = now() + (options.durationMs ?? 120_000);
  let settled = false;
  const settle = () => {
    if (!settled) {
      settled = true;
      options.onSettle?.();
    }
  };
  while (!signal.aborted) {
    await pull();
    settle();
    if (signal.aborted || now() >= deadline) return;
    await wait(Math.min(6_000, deadline - now()), signal);
  }
  // Aborted before the first pull could finish — release the spinner anyway.
  settle();
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
