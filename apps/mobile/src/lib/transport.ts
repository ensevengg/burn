import { LiveError } from "@burn/sync-api";

/** Abort when any linked signal fires; cancel() detaches the listeners. */
export function linkedSignals(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    const onAbort = () =>
      controller.abort(new Error(signal.reason?.message ?? "cancelled"));
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      detach.push(() => signal.removeEventListener("abort", onAbort));
    }
  }
  return {
    signal: controller.signal,
    cancel: () => detach.forEach((fn) => fn()),
  };
}

/** Abort when the deadline fires; cancel() clears the timer. */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const linked = linkedSignals(signal);
  const onLinkedAbort = () => controller.abort(new Error("cancelled"));
  linked.signal.addEventListener("abort", onLinkedAbort, { once: true });
  // Abort listeners are not retroactive: a signal that was already aborted
  // when we linked it must cancel this timeout synchronously.
  if (linked.signal.aborted) onLinkedAbort();
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      linked.signal.removeEventListener("abort", onLinkedAbort);
      linked.cancel();
    },
  };
}

export function describeFailure(err: unknown): {
  state: "offline" | "error";
  error: string;
} {
  if (err instanceof LiveError && err.name === "LiveUnreachableError") {
    return { state: "offline", error: (err as Error).message };
  }
  return { state: "error", error: (err as Error).message ?? String(err) };
}

