import { useQuery } from "@tanstack/react-query";
import type { Granularity } from "../lib/format";
import {
  queryClients,
  queryDailyTotals,
  queryEnvironments,
  queryGranularityMax,
  queryHistory,
  queryModels,
  queryQuotas,
  queryRecords,
  querySessions,
  queryWindowOverview,
  queryWorkspaces,
} from "./repository";
import type { SQLiteDatabase } from "expo-sqlite";
import { useApp } from "../lib/app-context";

/** All queries read the local mirror; sync invalidates them wholesale. */
function useDbQuery<T>(key: readonly unknown[], loader: (db: SQLiteDatabase) => Promise<T>, enabled = true) {
  const { db } = useApp();
  return useQuery({
    queryKey: key,
    queryFn: () => {
      if (db === null) throw new Error("database not open yet");
      return loader(db);
    },
    enabled: enabled && db !== null,
  });
}

export function useHistoryQuery(granularity: Granularity, groupBy: "model" | "client" | "none", days: number) {
  const { reportingTimezone } = useApp();
  return useDbQuery(
    ["history", reportingTimezone, granularity, groupBy, days],
    (db) => queryHistory(db, reportingTimezone, granularity, groupBy, days, null),
  );
}

/** Historical peak bucket for the granularity — the fixed Y ceiling (user direction). */
export function useGranularityMaxQuery(granularity: Granularity, metric: "cost" | "tokens" = "tokens") {
  const { reportingTimezone } = useApp();
  return useDbQuery(["granularity-max", reportingTimezone, granularity, metric], (db) =>
    queryGranularityMax(db, reportingTimezone, granularity, metric),
  );
}

/** The restructured dashboard's single source: totals, sessions, series, client shares, cache savings. */
export function useWindowOverviewQuery(days: number) {
  const { reportingTimezone } = useApp();
  return useDbQuery(["window-overview", reportingTimezone, days], (db) =>
    queryWindowOverview(db, reportingTimezone, days, "cost"),
  );
}

/** Contribution grid always feeds on a trailing year, independent of the window selector. */
export function useDailyTotalsQuery() {
  const { reportingTimezone } = useApp();
  return useDbQuery(["daily-totals", reportingTimezone], (db) => queryDailyTotals(db, reportingTimezone, 365));
}

export function useRecordsQuery() {
  const { reportingTimezone } = useApp();
  return useDbQuery(["records", reportingTimezone], (db) => queryRecords(db, reportingTimezone));
}

export function useModelsQuery(days: number) {
  return useDbQuery(["models", days], (db) => queryModels(db, days, null));
}

export function useClientsQuery(days: number) {
  return useDbQuery(["clients", days], (db) => queryClients(db, days, null));
}

export function useWorkspacesQuery(days: number) {
  return useDbQuery(["workspaces", days], (db) => queryWorkspaces(db, days, null));
}

export function useSessionsQuery(days: number) {
  return useDbQuery(["sessions", days], (db) => querySessions(db, days, null));
}

export function useQuotasQuery() {
  return useDbQuery(["quotas"], (db) => queryQuotas(db));
}

export function useMachinesQuery() {
  return useDbQuery(["machines"], (db) => queryEnvironments(db));
}
