import { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDashboardQuery, useGranularityMaxQuery, useMachinesQuery, useQuotasQuery } from "../data/queries";
import { formatCost, formatPercent, formatRelative, formatTokens } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Chip, Dot, Empty, MeterBar, SectionTitle, Stat } from "../ui/primitives";
import { ScrollableAreaChart } from "../ui/charts";
import type { QuotaCard } from "../data/repository";

export function DashboardScreen() {
  const { mode, reportingTimezone, sync, lastSync, syncError, requestSync } = useApp();
  const { C } = useTheme();
  const dashboard = useDashboardQuery();
  const quotas = useQuotasQuery();
  const machines = useMachinesQuery();
  const granularityMax = useGranularityMaxQuery("daily");
  const refreshing = dashboard.isFetching || quotas.isFetching;

  const today = dashboard.data?.today;
  const week = dashboard.data?.week;

  // One subscription card per provider-account, metric windows as rows inside
  // (user feedback: 5h + weekly are one subscription, not two cards).
  const subscriptions = useMemo(() => {
    const groups = new Map<string, { key: string; provider: string; accountLabel: string | null; plan: string | null; fetchedAt: string; metrics: QuotaCard[] }>();
    for (const quota of quotas.data ?? []) {
      const key = `${quota.provider}|${quota.accountLabel ?? ""}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          key,
          provider: quota.provider,
          accountLabel: quota.accountLabel,
          plan: quota.plan,
          fetchedAt: quota.fetchedAt,
          metrics: [quota],
        });
      } else {
        group.metrics.push(quota);
        if (quota.fetchedAt > group.fetchedAt) group.fetchedAt = quota.fetchedAt;
      }
    }
    return [...groups.values()];
  }, [quotas.data]);

  // Pull-to-refresh = request an eager push from every online machine (the
  // rendezvous signal, D1) + pull whatever landed since our watermark.
  const onRefresh = () => {
    if (mode === "cloud") void requestSync(null);
    void dashboard.refetch();
    void quotas.refetch();
    void sync();
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.muted} />}
      >
        <View style={styles.header}>
          <Text style={[type.title, { color: C.text }]}>Today</Text>
          <Chip tone={mode === "demo" ? "yellow" : mode === "cloud" ? "green" : "muted"}>
            {mode === "demo" ? "demo data" : mode === "cloud" ? "live" : "not connected"}
          </Chip>
        </View>
        <Text style={[type.muted, { color: C.muted, marginHorizontal: spacing.l, marginBottom: spacing.s }]}>
          {reportingTimezone} · synced {lastSync === null ? "—" : formatRelative(lastSync.toISOString())}
        </Text>
        {syncError !== null && (
          <Card>
            <Text style={{ color: C.err }}>{syncError}</Text>
          </Card>
        )}

        {today === undefined ? (
          <Empty message="Loading local cache…" />
        ) : (
          <>
            <Card>
              <View style={{ flexDirection: "row" }}>
                <Stat label="Spend today" value={formatCost(today.cost)} sub={`${today.messages} messages`} />
                <Stat
                  label="Tokens today"
                  value={formatTokens(
                    today.inputTokens + today.outputTokens + today.cacheReadTokens + today.cacheWriteTokens,
                  )}
                  sub={`cache hit ${formatPercent(today.hitRate)}`}
                />
              </View>
            </Card>

            <Card>
              <View style={{ flexDirection: "row" }}>
                <Stat
                  label="Spend · 7 days"
                  value={formatCost(week?.cost ?? 0)}
                  sub={week === undefined ? undefined : `${formatTokens(week.outputTokens)} output`}
                />
                <Stat
                  label="Cache hits · 7d"
                  value={formatTokens(week?.cacheReadTokens ?? 0)}
                  sub={dashboard.data?.hitRateYesterday === null || dashboard.data?.hitRateYesterday === undefined
                    ? "—"
                    : `yesterday ${formatPercent(dashboard.data.hitRateYesterday)}`}
                />
              </View>
            </Card>

            <SectionTitle trailing="tokens / day · 7 days">Burn rate</SectionTitle>
            {dashboard.data === undefined || dashboard.data.series.length === 0 ? (
              <Empty message="No usage in the last 7 days." />
            ) : (
              <Card>
                <DashboardChart
                  points={dashboard.data.series.map((bucket) => ({ label: bucket.label, value: bucket.tokens }))}
                  yMax={granularityMax.data}
                />
              </Card>
            )}

            <SectionTitle trailing="freshest per account">Subscriptions</SectionTitle>
            {subscriptions.length === 0 ? (
              <Empty message="No quota snapshots yet. Run `npx burn-report usage` on a machine." />
            ) : (
              subscriptions.map((sub) => (
                <Card key={sub.key}>
                  <View style={styles.quotaHeader}>
                    <Text style={[type.h2, { color: C.text }]}>{humanize(sub.provider)}</Text>
                    <Chip tone="muted">{formatRelative(sub.fetchedAt)}</Chip>
                  </View>
                  <Text style={[type.muted, { color: C.muted, marginBottom: spacing.xs }]}>
                    {[
                      sub.accountLabel ?? null,
                      sub.plan === null ? null : humanize(sub.plan),
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </Text>
                  {sub.metrics.map((metric) => (
                    <View key={metric.metric} style={{ marginTop: spacing.s }}>
                      <View style={styles.quotaFooter}>
                        <Text style={[type.body, { color: C.text, fontWeight: "600" }]}>
                          {humanize(metric.metric)}
                        </Text>
                        <Text style={[type.muted, { color: C.muted }]}>
                          {metric.usedPercent === null ? "—" : `${metric.usedPercent.toFixed(0)}% used`}
                          {metric.remainingLabel !== null ? ` · ${metric.remainingLabel}` : ""}
                        </Text>
                      </View>
                      {metric.usedPercent !== null && <MeterBar usedPercent={metric.usedPercent} />}
                    </View>
                  ))}
                </Card>
              ))
            )}

            <SectionTitle>Machines</SectionTitle>
            {machines.data === undefined ? (
              <Empty message="Loading machines…" />
            ) : machines.data.length === 0 ? (
              <Empty message="No machines yet — install burn-report." />
            ) : (
              <Card>
                {machines.data.map((machine) => (
                  <View key={machine.id} style={styles.machineRow}>
                    <Dot ok={machine.lastError === null && machine.lastHeartbeatAt !== null} />
                    <Text style={[type.body, { color: C.text, flex: 1, marginLeft: spacing.s }]} numberOfLines={1}>
                      {machine.displayName}
                    </Text>
                    <Text style={[type.muted, { color: C.muted }]}>{formatRelative(machine.lastHeartbeatAt)}</Text>
                  </View>
                ))}
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Separate component so the yMax query doesn't rerender the whole screen. */
function DashboardChart({ points, yMax }: { points: { label: string; value: number }[]; yMax: number | undefined }) {
  return <ScrollableAreaChart points={points} yMax={yMax} height={210} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: spacing.l,
    marginTop: spacing.m,
  },
  quotaHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  quotaFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  machineRow: { flexDirection: "row", alignItems: "center", paddingVertical: 7 },
});
