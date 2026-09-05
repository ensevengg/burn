import { useQuery } from "@tanstack/react-query";
import type { Granularity } from "../lib/format";
import {
  queryClients,
  queryDailyTotals,
  queryDashboard,
  queryEnvironments,
  queryGranularityMax,
  queryHistory,
  queryModels,
  queryQuotas,
  queryRecords,
  querySessions,
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

export function useDashboardQuery() {
  const { reportingTimezone } = useApp();
  return useDbQuery(["dashboard", reportingTimezone], (db) => queryDashboard(db, reportingTimezone, null));
}

export function useHistoryQuery(granularity: Granularity, groupBy: "model" | "client" | "none", days: number) {
  const { reportingTimezone } = useApp();
  return useDbQuery(
    ["history", reportingTimezone, granularity, groupBy, days],
    (db) => queryHistory(db, reportingTimezone, granularity, groupBy, days, null),
  );
}

/** Historical peak bucket for the granularity — the fixed Y ceiling (user direction). */
export function useGranularityMaxQuery(granularity: Granularity) {
  const { reportingTimezone } = useApp();
  return useDbQuery(["granularity-max", reportingTimezone, granularity], (db) =>
    queryGranularityMax(db, reportingTimezone, granularity),
  );
}

export function useDailyTotalsQuery(days: number) {
  const { reportingTimezone } = useApp();
  return useDbQuery(["daily-totals", reportingTimezone, days], (db) =>
    queryDailyTotals(db, reportingTimezone, days),
  );
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
