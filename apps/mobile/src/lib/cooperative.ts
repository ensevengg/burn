/** Reuse a short time budget across batches instead of sleeping after every batch. */
export function createYieldBudget(signal?: AbortSignal): () => Promise<void> | undefined {
  let deadline = 0;
  return () => {
    if (signal?.aborted) throw new Error("Query cancelled");
    if (performance.now() < deadline) return;
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        deadline = performance.now() + 4;
        resolve();
      }, 0),
    );
  };
}

/** The synchronous driver keeps pure aggregations easy to test. */
export function runImmediately<T>(work: Generator<void, T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Yield to input/paint on a time budget; cancellation is checked at every batch. */
export async function runCooperatively<T>(work: Generator<void, T>, signal?: AbortSignal): Promise<T> {
  const yieldIfNeeded = createYieldBudget(signal);
  while (true) {
    const pause = yieldIfNeeded();
    if (pause) await pause;
    if (signal?.aborted) {
      work.return(undefined as T);
      throw new Error("Query cancelled");
    }
    const step = work.next();
    if (step.done) return step.value;
  }
}
