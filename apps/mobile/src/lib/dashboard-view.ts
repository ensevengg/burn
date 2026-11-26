/** Pure: kept free of React Native so tests can load it. */
/** The dashboard's metric and range, remembered across launches. */
export interface DashboardView {
  metric: "cost" | "tokens";
  range: "1" | "7" | "30" | "90" | "all";
}
export const DEFAULT_DASHBOARD_VIEW: DashboardView = { metric: "cost", range: "30" };

/** Anything unreadable or from an older build falls back field by field. */
export function parseDashboardView(raw: string | null): DashboardView {
  let value: unknown = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    value = null;
  }
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const metric = record["metric"] === "tokens" || record["metric"] === "cost" ? record["metric"] : DEFAULT_DASHBOARD_VIEW.metric;
  const range = ["1", "7", "30", "90", "all"].includes(record["range"] as string)
    ? (record["range"] as DashboardView["range"])
    : DEFAULT_DASHBOARD_VIEW.range;
  return { metric, range };
}
