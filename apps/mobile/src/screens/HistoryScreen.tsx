import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDailyTotalsQuery, useGranularityMaxQuery, useHistoryQuery, useRecordsQuery } from "../data/queries";
import { buildStackLayers, type RecordStats } from "../data/repository";
import type { Granularity } from "../lib/format";
import { formatCost, formatPercent, formatTokens } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Empty, SectionTitle, Segmented, Stat } from "../ui/primitives";
import { ScrollableAreaChart } from "../ui/charts";
import { ContributionGrid } from "../ui/heatmap";

/**
 * One selector picks the window (user feedback: granularity + window rows were
 * confusing); bucket size derives from it. "All" uses yearly buckets.
 */
const WINDOWS = [
  { label: "7d", value: "7", granularity: "daily", days: 7 },
  { label: "30d", value: "30", granularity: "daily", days: 30 },
  { label: "90d", value: "90", granularity: "daily", days: 90 },
  { label: "1y", value: "365", granularity: "monthly", days: 365 },
  { label: "All", value: "all", granularity: "yearly", days: 36500 },
] as const satisfies readonly { label: string; value: string; granularity: Granularity; days: number }[];

const GROUPINGS = [
  { label: "Total", value: "none" },
  { label: "By model", value: "model" },
  { label: "By agent", value: "client" },
] as const;

export function HistoryScreen() {
  const [windowValue, setWindowValue] = useState<string>("30");
  const [groupBy, setGroupBy] = useState<"none" | "model" | "client">("none");
  const window = WINDOWS.find((w) => w.value === windowValue) ?? WINDOWS[1]!;
  const history = useHistoryQuery(window.granularity, groupBy, window.days);
  const granularityMax = useGranularityMaxQuery(window.granularity);
  const dailyTotals = useDailyTotalsQuery();
  const records = useRecordsQuery();
  const { C } = useTheme();
  const { reportingTimezone } = useApp();

  // Stack keys ordered by total usage, most used first — bottom layer and top
  // of the legend are the dominant model/agent (user expectation).
  const stackKeys = useMemo(() => {
    const totalsByKey = new Map<string, number>();
    for (const bucket of history.data?.series ?? []) {
      for (const [key, tokens] of Object.entries(bucket.stacks)) {
        totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + tokens);
      }
    }
    return [...totalsByKey.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }, [history.data]);

  const colorFor = useMemo(() => {
    const map = new Map<string, string>();
    stackKeys.forEach((key, index) => map.set(key, C.chart[index % C.chart.length]!));
    return (key: string) => map.get(key) ?? C.muted;
  }, [stackKeys, C]);

  const layers = useMemo(
    () => (groupBy === "none" || history.data === undefined ? undefined : buildStackLayers(history.data.series, stackKeys)),
    [groupBy, history.data, stackKeys],
  );

  // Daily × total gives the honest per-day cache-hit-rate line; other
  // combinations would need stacked rate semantics, so they skip the chart.
  const rateSeries = useMemo(() => {
    if (window.granularity !== "daily" || groupBy !== "none") return [];
    return (history.data?.series ?? []).map((bucket) => {
      const denominator = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
      return {
        label: bucket.label,
        value: denominator === 0 ? 0 : bucket.cacheReadTokens / denominator,
      };
    });
  }, [window.granularity, groupBy, history.data]);

  // Ranked rows under the chart when By model/agent is active (user feedback:
  // "By model" should show models from most used to least used).
  const ranked = useMemo(() => {
    if (groupBy === "none" || history.data === undefined) return null;
    const totalsByKey = new Map<string, number>();
    for (const bucket of history.data.series) {
      for (const [key, tokens] of Object.entries(bucket.stacks)) {
        totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + tokens);
      }
    }
    return [...totalsByKey.entries()]
      .map(([key, tokens]) => ({ key, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [groupBy, history.data]);

  const totals = history.data?.totals;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={[type.title, { color: C.text }, styles.title]}>History</Text>

        <Segmented options={WINDOWS} value={windowValue} onChange={setWindowValue} />
        <Segmented options={GROUPINGS} value={groupBy} onChange={setGroupBy} />

        {totals === undefined ? (
          <Empty message="Loading…" />
        ) : history.data !== undefined && history.data.series.length === 0 ? (
          <Empty message={`No usage in the last ${window.label}.`} />
        ) : (
          <>
            <Card>
              <View style={{ flexDirection: "row" }}>
                <Stat
                  label="Total tokens"
                  value={formatTokens(
                    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.reasoningTokens,
                  )}
                  sub={`${totals.messages} messages`}
                />
                <Stat label="Total cost" value={formatCost(totals.cost)} tone="accent" sub={`coverage ${formatPercent(totals.costCoverage)} priced`} />
              </View>
            </Card>

            <SectionTitle trailing="last 365 days · tap a day">Contribution</SectionTitle>
            <Card>
              <ContributionGrid totals={dailyTotals.data} timeZone={reportingTimezone} />
            </Card>

            <SectionTitle>Records</SectionTitle>
            <RecordsCard records={records.data} />

            <SectionTitle trailing={`tokens per ${window.granularity === "daily" ? "day" : window.granularity === "monthly" ? "month" : "year"}`}>Usage</SectionTitle>
            {history.data === undefined ? null : (
              <Card>
                <ScrollableAreaChart
                  points={history.data.series.map((bucket) => ({ label: bucket.label, value: bucket.tokens }))}
                  layers={layers}
                  colorFor={colorFor}
                  legendKeys={stackKeys.map((key) => humanize(key))}
                  yMax={granularityMax.data}
                  pxPerPoint={44}
                  height={240}
                />
              </Card>
            )}

            {ranked !== null && ranked.length > 0 && (
              <>
                <SectionTitle trailing={`most used · ${groupBy === "model" ? "models" : "agents"}`}>
                  Ranked
                </SectionTitle>
                <Card>
                  {ranked.map((row, index) => {
                    const top = ranked[0]!.tokens || 1;
                    return (
                      <View key={row.key} style={{ marginTop: index === 0 ? 0 : spacing.s }}>
                        <View style={styles.rankedRow}>
                          <Text style={[type.body, { color: C.text, flex: 1 }]} numberOfLines={1}>
                            {`${index + 1}. ${humanize(row.key)}`}
                          </Text>
                          <Text style={[type.muted, { color: C.muted }]}>
                            {`${formatTokens(row.tokens)} · ${formatPercent(totals === undefined ? 0 : row.tokens / (totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.reasoningTokens))}`}
                          </Text>
                        </View>
                        <View style={[styles.rankTrack, { backgroundColor: C.panelAlt }]}>
                          <View
                            style={{
                              width: `${(row.tokens / top) * 100}%`,
                              height: "100%",
                              backgroundColor: colorFor(row.key),
                              borderRadius: 999,
                            }}
                          />
                        </View>
                      </View>
                    );
                  })}
                </Card>
              </>
            )}

            {rateSeries.length > 0 && (
              <>
                <SectionTitle trailing="cache hit rate">Efficiency</SectionTitle>
                <Card>
                  <ScrollableAreaChart
                    points={rateSeries}
                    pxPerPoint={44}
                    height={150}
                    formatY={(fraction: number) => `${Math.round(fraction * 100)}%`}
                  />
                </Card>
              </>
            )}

            <SectionTitle>Token mix</SectionTitle>
            <Card>
              <MixRow label="Input" value={totals.inputTokens} total={totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} color={C.chart[1] ?? C.muted} />
              <MixRow label="Output" value={totals.outputTokens} total={totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} color={C.text} />
              <MixRow label="Cache read" value={totals.cacheReadTokens} total={totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} color={C.chart[2] ?? C.muted} />
              <MixRow label="Cache write" value={totals.cacheWriteTokens} total={totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} color={C.chart[3] ?? C.muted} />
              <MixRow label="Reasoning" value={totals.reasoningTokens} total={totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens} color={C.chart[4] ?? C.muted} />
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RecordsCard({ records }: { records: RecordStats | undefined }) {
  const { C } = useTheme();
  if (records === undefined) return <Empty message="Loading…" />;
  return (
    <Card>
      <View style={{ flexDirection: "row" }}>
        <Stat
          label="Biggest day"
          value={records.biggestDay === null ? "—" : formatTokens(records.biggestDay.tokens)}
          sub={records.biggestDay === null ? undefined : `${records.biggestDay.key} · ${formatCost(records.biggestDay.cost)}`}
        />
        <Stat
          label="Longest streak"
          value={`${records.longestStreak}d`}
          sub={`current ${records.currentStreak}d`}
        />
      </View>
      <View style={[styles.priciestRow, { borderTopColor: C.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[type.muted, { color: C.muted }]}>Priciest session</Text>
          <Text style={[type.body, { color: C.text, fontWeight: "600" }]} numberOfLines={1}>
            {records.topSession === null
              ? "—"
              : records.topSession.title ?? humanize(records.topSession.sessionId)}
          </Text>
          {records.topSession !== null && (
            <Text style={[type.muted, { color: C.muted }]}>
              {`${formatCost(records.topSession.cost)} · ${formatTokens(records.topSession.tokens)} · ${humanize(records.topSession.client ?? "")}`.trim()}
            </Text>
          )}
        </View>
      </View>
    </Card>
  );
}

function MixRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {  const { C } = useTheme();
  const fraction = total === 0 ? 0 : value / total;
  return (
    <View style={{ marginTop: spacing.s }}>
      <View style={styles.mixRow}>
        <Text style={[type.body, { color: C.text }]}>{label}</Text>
        <Text style={[type.muted, { color: C.muted }]}>{`${formatTokens(value)} · ${formatPercent(fraction)}`}</Text>
      </View>
      <View style={[styles.mixTrack, { backgroundColor: C.panelAlt }]}>
        <View style={{ width: `${fraction * 100}%`, height: "100%", backgroundColor: color, borderRadius: 999 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: { marginHorizontal: spacing.l, marginTop: spacing.m, marginBottom: spacing.s },
  mixRow: { flexDirection: "row", justifyContent: "space-between" },
  mixTrack: { height: 5, borderRadius: 999, overflow: "hidden", marginTop: 4 },
  rankedRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rankTrack: { height: 5, borderRadius: 999, overflow: "hidden", marginTop: 4 },
  priciestRow: { flexDirection: "row", borderTopWidth: 1, marginTop: spacing.m, paddingTop: spacing.m },
});
