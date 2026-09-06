import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useGranularityMaxQuery, useMachinesQuery, useQuotasQuery, useWindowOverviewQuery } from "../data/queries";
import { eventTokens, type QuotaCard } from "../data/repository";
import { formatCost, formatPercent, formatRelative, formatTokens } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Chip, Dot, Empty, MeterBar, SectionTitle, Segmented, Stat } from "../ui/primitives";
import { AreaChart } from "../ui/charts";

type Metric = "cost" | "tokens";
type WindowDays = 1 | 7 | 30 | 90;

const METRICS = [
  { label: "Cost", value: "cost" },
  { label: "Tokens", value: "tokens" },
] as const;

const WINDOWS = [
  { label: "Past 24h", value: "1" },
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
] as const;

export function DashboardScreen() {
  const { mode, reportingTimezone, requestSync } = useApp();
  const { syncError, syncNotice, refreshingMachines, checkingMachines } = useSyncStatus();
  const { C } = useTheme();
  const [metric, setMetric] = useState<Metric>("cost");
  const [days, setDays] = useState<WindowDays>(30);
  const [demoRefreshing, setDemoRefreshing] = useState(false);
  const overview = useWindowOverviewQuery(days);
  const dailyMax = useGranularityMaxQuery("daily", metric);
  const quotas = useQuotasQuery();
  const machines = useMachinesQuery();
  // Cloud pull-to-refresh is covered by the machine-refresh spinner (which
  // settles after the first pull); demo mode has no machines to ask, so the
  // gesture itself drives the spinner — heartbeat refetches must not blip it.
  const refreshing = mode === "cloud" ? refreshingMachines : demoRefreshing;

  const totals = overview.data?.totals;
  const headlineValue =
    totals === undefined
      ? "—"
      : metric === "cost"
        ? formatCost(totals.cost)
        : formatTokens(eventTokens(totals));

  // Pull-to-refresh = request an eager push from every online machine (D1) + pull delta.
  const onRefresh = () => {
    if (mode === "cloud") {
      void requestSync(null);
      return;
    }
    setDemoRefreshing(true);
    void Promise.all([overview.refetch(), quotas.refetch()]).finally(() => setDemoRefreshing(false));
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.muted} />}
      >
        <View style={styles.header}>
          <Text style={[type.title, { color: C.text }]}>Overview</Text>
          <Chip tone={mode === "demo" ? "yellow" : mode === "cloud" ? "green" : "muted"}>
            {mode === "demo" ? "demo data" : mode === "cloud" ? "live" : "not connected"}
          </Chip>
        </View>

        <Segmented options={METRICS} value={metric} onChange={setMetric} />
        <Segmented options={WINDOWS} value={String(days)} onChange={(value) => setDays(Number(value) as WindowDays)} />

        {overview.data !== undefined && overview.data.byClient.length > 0 ? (
          <View style={styles.providerRows}>
            {overview.data.byClient.slice(0, 3).map((client) => {
              const total = metric === "cost" ? overview.data!.totals.cost : eventTokens(overview.data!.totals);
              const share = total === 0 ? 0 : (metric === "cost" ? client.cost : client.tokens) / total;
              return (
                <View key={client.key} style={styles.providerRow}>
                  <View style={[styles.providerDot, { backgroundColor: C.text }]} />
                  <Text style={[type.body, { color: C.text, fontWeight: "600" }]}>{humanize(client.key)}</Text>
                  <Text style={[type.muted, { color: C.muted, marginLeft: spacing.s, flex: 1 }]}>
                    {`${client.sessions} sessions`}
                  </Text>
                  <Text style={[type.muted, { color: C.muted }]}>
                    {`${formatPercent(share)} of ${metric} · ${formatTokens(client.tokens)}`}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}

        <Card>
          <Text style={[type.headline, { color: C.text }]}>{headlineValue}</Text>
          <Text style={[type.muted, { color: C.muted }]}>
            {`${overview.data?.totals.messages ?? 0} messages · API estimate`}
          </Text>
        </Card>

        {syncError !== null && (
          <Card>
            <Text style={{ color: C.err }}>{syncError}</Text>
          </Card>
        )}

        {syncNotice !== null && (
          <Card>
            <Text style={[type.muted, { color: C.muted }]}>{syncNotice}</Text>
          </Card>
        )}

        <SectionTitle trailing={`${metric} / day`}>Daily</SectionTitle>
        {overview.data === undefined || overview.data.series.length === 0 ? (
          <Empty message={`No usage in the last ${days}d.`} />
        ) : (
          <Card>
            <AreaChart
              points={overview.data.series.map((bucket) => ({
                label: bucket.label,
                value: metric === "cost" ? bucket.cost : bucket.tokens,
              }))}
              yMax={dailyMax.data === undefined ? undefined : dailyMax.data}
              height={230}
              formatY={metric === "cost" ? formatCost : formatTokens}
            />
          </Card>
        )}

        <SectionTitle>Totals</SectionTitle>
        {totals === undefined ? null : (
          <Card>
            <View style={styles.stripRow}>
              <StripStat label="Processed" value={formatTokens(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.reasoningTokens)} />
              <StripStat label="Cached input" value={formatTokens(totals.cacheReadTokens)} />
              <StripStat label="Uncached input" value={formatTokens(totals.inputTokens)} />
            </View>
            <View style={styles.stripRow}>
              <StripStat label="Output" value={formatTokens(totals.outputTokens)} />
              <StripStat label="Cache hit" value={formatPercent(totals.hitRate)} />
              <StripStat
                label="Cache savings"
                value={overview.data?.cacheSavings === null || overview.data?.cacheSavings === undefined ? "—" : formatCost(overview.data.cacheSavings)}
              />
            </View>
          </Card>
        )}

        <SectionTitle trailing={checkingMachines ? "Checking machines…" : undefined}>Subscriptions</SectionTitle>
        {quotas.data === undefined || quotas.data.length === 0 ? (
          <Empty message="No quota snapshots yet. Run `npx burn-report usage` on a machine." />
        ) : (
          groupSubscriptions(quotas.data).map((sub) => (
            <Card key={sub.key}>
              <View style={styles.quotaHeader}>
                <Text style={[type.h2, { color: C.text }]}>{humanize(sub.provider)}</Text>
                <Chip tone="muted">{formatRelative(sub.fetchedAt)}</Chip>
              </View>
              <Text style={[type.muted, { color: C.muted }]}>
                {[
                  sub.accountLabel ?? null,
                  sub.plan === null ? null : humanize(sub.plan),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </Text>
              {sub.metrics.map((metricQuota) => (
                <View key={metricQuota.metric} style={{ marginTop: spacing.s }}>
                  <View style={styles.quotaFooter}>
                    <Text style={[type.body, { color: C.text, fontWeight: "600" }]}>
                      {humanize(metricQuota.metric)}
                    </Text>
                    <Text style={[type.muted, { color: C.muted }]}>
                      {metricQuota.usedPercent === null
                        ? "—"
                        : `${metricQuota.usedPercent.toFixed(0)}% used`}
                      {metricQuota.remainingLabel !== null ? ` · ${metricQuota.remainingLabel}` : ""}
                    </Text>
                  </View>
                  {metricQuota.usedPercent !== null && <MeterBar usedPercent={metricQuota.usedPercent} />}
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
      </ScrollView>
    </SafeAreaView>
  );
}

function StripStat({ label, value }: { label: string; value: string }) {
  const { C } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: "600", color: C.text, fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}

/** One card per provider-account; metric windows (5h, weekly…) live inside. */
function groupSubscriptions(quotas: QuotaCard[]): {
  key: string;
  provider: string;
  accountLabel: string | null;
  plan: string | null;
  fetchedAt: string;
  metrics: QuotaCard[];
}[] {
  const groups = new Map<
    string,
    { key: string; provider: string; accountLabel: string | null; plan: string | null; fetchedAt: string; metrics: QuotaCard[] }
  >();
  for (const quota of quotas) {
    const key = JSON.stringify([quota.provider, quota.accountKey]);
    const group = groups.get(key) ?? {
      key,
      provider: quota.provider,
      accountLabel: quota.accountLabel,
      plan: quota.plan,
      fetchedAt: quota.fetchedAt,
      metrics: [] as QuotaCard[],
    };
    group.metrics.push(quota);
    if (quota.fetchedAt > group.fetchedAt) group.fetchedAt = quota.fetchedAt;
    groups.set(key, group);
  }
  return [...groups.values()];
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
  providerRows: { marginHorizontal: spacing.l, marginTop: spacing.s },
  providerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  providerDot: { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  quotaHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  quotaFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  stripRow: { flexDirection: "row", marginTop: spacing.s, gap: spacing.m },
  machineRow: { flexDirection: "row", alignItems: "center", paddingVertical: 7 },
});
