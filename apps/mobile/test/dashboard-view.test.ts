import { expect, test } from "bun:test";
import { DEFAULT_DASHBOARD_VIEW, parseDashboardView } from "../src/lib/dashboard-view";

test("a saved dashboard view round-trips and bad values fall back field by field", () => {
  expect(parseDashboardView(null)).toEqual(DEFAULT_DASHBOARD_VIEW);
  expect(parseDashboardView(JSON.stringify({ metric: "tokens", range: "7" }))).toEqual({ metric: "tokens", range: "7" });
  expect(parseDashboardView("{oops")).toEqual(DEFAULT_DASHBOARD_VIEW);
  expect(parseDashboardView(JSON.stringify({ metric: "tokens", range: "365" }))).toEqual({ metric: "tokens", range: "30" });
  expect(parseDashboardView(JSON.stringify(["cost"]))).toEqual(DEFAULT_DASHBOARD_VIEW);
});
