import { useEffect, useState } from "react";

/**
 * Current time for age text ("checked 3m ago", reset countdowns, stale
 * machines), re-rendering the caller on an interval. The local-mirror queries
 * cannot do this: a refetch that returns equal rows notifies nobody.
 */
export function useNow(intervalMs = 30_000): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return Date.now();
}
