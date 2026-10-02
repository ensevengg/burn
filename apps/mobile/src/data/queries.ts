import { useEffect } from "react";
import { useIsFocused } from "@react-navigation/native";
import { keepPreviousData, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import type { Granularity } from "../lib/format";
import {
  queryClients,
  queryEnvironments,
  queryGranularityMax,
  queryModels,
  queryQuotas,
  querySessions,
  querySystems,
  queryWindowOverview,
  queryWorkspaces,
} from "./repository";
import type { SQLiteDatabase } from "expo-sqlite";
import { useApp } from "../lib/app-context";
import type { UsageWindowDays } from "../lib/usage-range";

interface DbQueryOptions {
  enabled?: boolean;
  /**
   * Periodic re-read for tiny always-fresh tables (quota staleness, machine
   * heartbeats). Event queries must not heartbeat: they re-read and
   * re-aggregate their whole window, and mirror-change invalidations already
   * cover every real data change.
   */
  heartbeatMs?: number | false;
  /** Show the previous window's data while a chip-tap recomputes, instead of blanking. */
  keepPrevious?: boolean;
}

/** Focused screens read the local mirror; sync invalidates only changed families. */
function useDbQuery<T>(
  key: readonly unknown[],
  loader: (db: SQLiteDatabase, signal: AbortSignal) => Promise<T>,
  options: DbQueryOptions = {},
) {
  const { enabled = true, heartbeatMs = false, keepPrevious = false } = options;
  const { db } = useApp();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  useEffect(() => {
    const cancelUnused = () => {
      void queryClient.cancelQueries({ queryKey: key, exact: true, predicate: (query) => !query.isActive() });
    };
    if (!focused || !enabled) cancelUnused();
    return cancelUnused;
  }, [focused, enabled, queryClient, JSON.stringify(key)]);
  // Annotated options pin TData = T: with placeholderData in play, useQuery
  // otherwise infers the placeholder function itself as the data type.
  const queryOptions: UseQueryOptions<T, Error, T> = {
    queryKey: key,
    queryFn: ({ signal }) => {
      if (db === null) throw new Error("database not open yet");
      return loader(db, signal);
    },
    enabled: enabled && focused && db !== null,
    refetchInterval: heartbeatMs === false ? false : focused && enabled ? heartbeatMs : false,
  };
  if (keepPrevious) {
    // TanStack guards placeholderData against function-typed data
    // (NonFunctionGuard<T>), which cannot be proven for an unresolved generic —
    // no loader here returns a function, so the cast only satisfies that guard.
    queryOptions.placeholderData = keepPreviousData<T> as NonNullable<
      UseQueryOptions<T, Error, T>["placeholderData"]
    >;
  }
  return useQuery(queryOptions);
}

/** Historical peak bucket for the granularity — the fixed Y ceiling (user direction). */
export function useGranularityMaxQuery(granularity: Granularity, metric: "cost" | "tokens" = "tokens") {
  const { reportingTimezone } = useApp();
  return useDbQuery(
    ["granularity-max", reportingTimezone, granularity, metric],
    (db, signal) => queryGranularityMax(db, reportingTimezone, granularity, metric, signal),
    { keepPrevious: true },
  );
}

/** The restructured dashboard's single source: totals, sessions, series, client shares, cache savings. */
export function useWindowOverviewQuery(days: UsageWindowDays, metric: "cost" | "tokens", granularity: Granularity) {
  const { reportingTimezone } = useApp();
  return useDbQuery(
    ["window-overview", reportingTimezone, days, metric, granularity],
    (db, signal) => queryWindowOverview(db, reportingTimezone, days, metric, granularity, signal),
    { keepPrevious: true },
  );
}

export function useModelsQuery(days: UsageWindowDays, enabled = true) {
  return useDbQuery(["models", days], (db, signal) => queryModels(db, days, null, signal), {
    enabled,
    keepPrevious: true,
  });
}

export function useClientsQuery(days: UsageWindowDays, enabled = true) {
  return useDbQuery(["clients", days], (db, signal) => queryClients(db, days, null, signal), {
    enabled,
    keepPrevious: true,
  });
}

export function useWorkspacesQuery(days: UsageWindowDays, enabled = true) {
  return useDbQuery(["workspaces", days], (db, signal) => queryWorkspaces(db, days, null, signal), {
    enabled,
    keepPrevious: true,
  });
}

export function useSessionsQuery(days: UsageWindowDays, enabled = true) {
  return useDbQuery(["sessions", days], (db, signal) => querySessions(db, days, null, 60, signal), {
    enabled,
    keepPrevious: true,
  });
}

export function useQuotasQuery() {
  return useDbQuery(["quotas"], (db) => queryQuotas(db), { heartbeatMs: 60_000 });
}

export function useMachinesQuery() {
  return useDbQuery(["machines"], (db) => queryEnvironments(db), { heartbeatMs: 60_000 });
}

export function useSystemsQuery() {
  return useDbQuery(["systems"], (db) => querySystems(db), { heartbeatMs: 60_000 });
}
