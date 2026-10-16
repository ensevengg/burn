import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { useGranularityMaxQuery, useMachinesQuery, useQuotasQuery, useWindowOverviewQuery } from "../data/queries";
import { eventTokens, type QuotaCard, type WindowOverview } from "../data/repository";
import {
  bucketTitle,
  formatCost,
  formatCostCompact,
  formatPercent,
  formatRelative,
  formatTokens,
  formatUntil,
  type Granularity,
} from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { fillSeries, rollupYears } from "../lib/series";
import { DASHBOARD_RANGES, USAGE_RANGES, usageWindowStart, type UsageRangeId } from "../lib/usage-range";
import { gutter, hairline, radius, spacing, type } from "../theme";
import { Card, Dot, Empty, Ring, SectionTitle, Segmented, ShareBar } from "../ui/primitives";
import { FadeIn, PressableScale, Skeleton, useTweenedNumber } from "../ui/motion";
import { UsageChart, type ChartPoint } from "../ui/charts";
import { Screen } from "../ui/screen";

type Metric = "cost" | "tokens";

const METRICS = [
  { label: "Cost", value: "cost" },
  { label: "Tokens", value: "tokens" },
] as const;

const RANGE_WORDS: Record<UsageRangeId, string> = {
  "1": "last 24 hours",
  "7": "last 7 days",
  "30": "last 30 days",
  "90": "last 90 days",
  "365": "last year",
  all: "all time",
};

export function DashboardScreen() {
  const [metric, setMetric] = useState<Metric>("cost");
  const [rangeId, setRangeId] = useState<UsageRangeId>("30");
  return (
    <Screen title="Overview">
      <FadeIn>
        <UsageHero metric={metric} setMetric={setMetric} rangeId={rangeId} setRangeId={setRangeId} />
      </FadeIn>
      <FadeIn delay={60}>
        <AgentShares metric={metric} rangeId={rangeId} />
      </FadeIn>
      <FadeIn delay={110}>
        <TokenBreakdown metric={metric} rangeId={rangeId} />
      </FadeIn>
      <FadeIn delay={160}>
        <Limits />
      </FadeIn>
      <FadeIn delay={200}>
        <MachineStrip />
      </FadeIn>
    </Screen>
  );
}

/** Everything the hero renders, captured from one consistent read so labels, number and chart never disagree. */
interface HeroSnapshot {
  rangeId: UsageRangeId;
  metric: Metric;
  total: number;
  messages: number;
  sessions: number;
  points: ChartPoint[];
  keys: string[];
  tokens: number[];
  costs: number[];
  granularity: Granularity;
  yMax: number | undefined;
}

function buildSnapshot(
  overview: WindowOverview,
  metric: Metric,
  rangeId: UsageRangeId,
  timeZone: string,
  peak: number | undefined,
): HeroSnapshot {
  const range = USAGE_RANGES[rangeId];
  const now = Date.now();
  let series = fillSeries(overview.series, range.granularity, timeZone, range.days === null ? null : usageWindowStart(range.days, now), now);
  let granularity = range.granularity;
  if (range.days === null) ({ series, granularity } = rollupYears(series));
  return {
    rangeId,
    metric,
    total: metric === "cost" ? overview.totals.cost : eventTokens(overview.totals),
    messages: overview.totals.messages,
    sessions: overview.sessions,
    points: series.map((bucket) => ({ label: bucket.label, value: metric === "cost" ? bucket.cost : bucket.tokens })),
    keys: series.map((bucket) => bucket.key),
    tokens: series.map((bucket) => bucket.tokens),
    costs: series.map((bucket) => bucket.cost),
    granularity,
    // All-time already contains the historical peak; elsewhere the ceiling
    // is the fixed per-granularity peak (user direction).
    yMax: range.days === null ? undefined : peak,
  };
}

/** Fades content back while a newer selection loads (stale-while-revalidate cue). */
function Dim({ dim, children }: { dim: boolean; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: dim ? 0.4 : 1, duration: dim ? 220 : 160, useNativeDriver: true }).start();
  }, [dim, opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/**
 * Headline + chart + range. Holds scrub state so a drag across the chart
 * re-renders only this block, never the whole screen.
 */
function UsageHero({
  metric,
  setMetric,
  rangeId,
  setRangeId,
}: {
  metric: Metric;
  setMetric: (metric: Metric) => void;
  rangeId: UsageRangeId;
  setRangeId: (range: UsageRangeId) => void;
}) {
  const { C } = useTheme();
  const { reportingTimezone } = useApp();
  const range = USAGE_RANGES[rangeId];
  const overview = useWindowOverviewQuery(range.days, metric, range.granularity);
  // The peak scans all history; start it only once the window has painted
  // so first paint never queues behind it.
  const overviewData = overview.data !== undefined && !overview.isPlaceholderData ? overview.data : undefined;
  const peak = useGranularityMaxQuery(range.granularity, metric, overviewData !== undefined && range.days !== null);
  const [scrub, setScrub] = useState<number | null>(null);

  // Placeholder rows belong to the previous selection: keep showing the last
  // consistent snapshot, dimmed, until the new window lands. The ceiling
  // starts from the window's own peak and morphs to the historical one; a
  // placeholder peak from another granularity is never used.
  const peakData = peak.data !== undefined && !peak.isPlaceholderData ? peak.data : undefined;
  const fresh = useMemo(
    () => (overviewData === undefined ? null : buildSnapshot(overviewData, metric, rangeId, reportingTimezone, peakData)),
    [overviewData, peakData, metric, rangeId, reportingTimezone],
  );
  const last = useRef<HeroSnapshot | null>(null);
  if (fresh !== null) last.current = fresh;
  const shown = fresh ?? last.current;
  const pending = fresh === null && shown !== null;

  const format = shown?.metric === "tokens" ? formatTokens : formatCost;
  const scrubbing = scrub !== null && shown !== null && scrub < shown.keys.length;
  const eyebrow =
    shown === null
      ? " "
      : scrubbing
        ? bucketTitle(shown.keys[scrub]!, shown.granularity)
        : `${shown.metric === "cost" ? "Spend" : "Processed"} · ${RANGE_WORDS[shown.rangeId]}`;
  const sub =
    shown === null
      ? " "
      : scrubbing
        ? shown.metric === "cost"
          ? `${formatTokens(shown.tokens[scrub]!)} tokens`
          : `${formatCost(shown.costs[scrub]!)} API estimate`
        : `${shown.messages.toLocaleString("en")} messages · ${shown.sessions.toLocaleString("en")} sessions`;
  const scrubValue = scrubbing ? (shown.metric === "cost" ? shown.costs[scrub]! : shown.tokens[scrub]!) : null;

  const onScrub = useCallback((index: number | null) => setScrub(index), []);

  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <Text style={[type.eyebrow, { color: scrubbing ? C.text : C.muted, flex: 1 }]} numberOfLines={1}>
          {eyebrow}
        </Text>
        <Segmented options={METRICS} value={metric} onChange={setMetric} size="s" style={styles.metricToggle} />
      </View>
      <Dim dim={pending}>
        {shown === null ? (
          <Skeleton style={[styles.heroSkeleton, { backgroundColor: C.panelAlt }]} />
        ) : (
          <HeroNumber key={shown.metric} value={shown.total} scrubValue={scrubValue} format={format} />
        )}
        <Text style={[type.muted, { color: C.muted, marginTop: 4 }]} numberOfLines={1}>
          {sub}
        </Text>
        <View style={styles.chartWrap}>
          {shown === null ? (
            <Skeleton style={[styles.chartSkeleton, { backgroundColor: C.panel }]} />
          ) : (
            <UsageChart
              points={shown.points}
              yMax={shown.yMax}
              height={196}
              formatY={shown.metric === "cost" ? formatCostCompact : formatTokens}
              onScrub={onScrub}
            />
          )}
        </View>
      </Dim>
      <Segmented options={DASHBOARD_RANGES} value={rangeId} onChange={setRangeId} style={{ marginTop: spacing.m }} />
    </View>
  );
}

/**
 * Counts up from zero on first paint, glides between values on refresh, and
 * follows the finger while scrubbing. Stays mounted through a scrub so
 * letting go glides back to the total instead of recounting from zero.
 */
function HeroNumber({
  value,
  scrubValue,
  format,
}: {
  value: number;
  scrubValue: number | null;
  format: (n: number) => string;
}) {
  const { C } = useTheme();
  const shown = useTweenedNumber(scrubValue ?? value, scrubValue === null ? 650 : 0, 0);
  return (
    <Text style={[type.display, { color: C.text }]} numberOfLines={1} adjustsFontSizeToFit>
      {format(shown)}
    </Text>
  );
}

const AgentShares = memo(function AgentShares({ metric, rangeId }: { metric: Metric; rangeId: UsageRangeId }) {
  const { C } = useTheme();
  const range = USAGE_RANGES[rangeId];
  const overview = useWindowOverviewQuery(range.days, metric, range.granularity);
  const clients = overview.data?.byClient ?? [];
  // Hold the section's space on first load so Limits doesn't paint here and get pushed down.
  if (overview.data === undefined) return <SectionSkeleton title="Agents" height={164} corner={radius.m} />;
  if (clients.length === 0) return null;
  const total = metric === "cost" ? overview.data.totals.cost : eventTokens(overview.data.totals);
  const rows = clients.slice(0, 5).map((client, i) => ({
    ...client,
    share: total === 0 ? 0 : (metric === "cost" ? client.cost : client.tokens) / total,
    color: C.chart[Math.min(i, C.chart.length - 1)]!,
  }));
  return (
    <>
      <SectionTitle trailing={metric === "cost" ? "by spend" : "by tokens"}>Agents</SectionTitle>
      <View style={{ marginHorizontal: gutter }}>
        <ShareBar shares={rows.map((row) => ({ key: row.key, fraction: row.share, color: row.color }))} />
        {rows.map((row) => (
          <View key={row.key} style={styles.agentRow}>
            <View style={[styles.swatch, { backgroundColor: row.color }]} />
            <Text style={[type.body, { color: C.text, fontWeight: "600" }]} numberOfLines={1}>
              {humanize(row.key)}
            </Text>
            <Text style={[type.muted, { color: C.faint, marginLeft: 8, flex: 1 }]} numberOfLines={1}>
              {`${row.sessions} sessions`}
            </Text>
            <Text style={[type.muted, { color: C.muted, width: 52, textAlign: "right", fontVariant: ["tabular-nums"] }]}>
              {formatPercent(row.share)}
            </Text>
            <Text style={[styles.agentValue, { color: C.text }]}>
              {metric === "cost" ? formatCost(row.cost) : formatTokens(row.tokens)}
            </Text>
          </View>
        ))}
      </View>
    </>
  );
});

const TokenBreakdown = memo(function TokenBreakdown({ metric, rangeId }: { metric: Metric; rangeId: UsageRangeId }) {
  const { C } = useTheme();
  const range = USAGE_RANGES[rangeId];
  const overview = useWindowOverviewQuery(range.days, metric, range.granularity);
  const totals = overview.data?.totals;
  if (totals === undefined) return <SectionSkeleton title="Tokens" height={110} corner={radius.l} />;
  const savings = overview.data?.cacheSavings ?? null;
  return (
    <>
      <SectionTitle>Tokens</SectionTitle>
      <Card style={styles.tokensCard}>
        <Ring fraction={totals.hitRate} size={78} stroke={7} color={C.text}>
          <Text style={[styles.ringValue, { color: C.text }]}>{`${(totals.hitRate * 100).toFixed(0)}%`}</Text>
          <Text style={[styles.ringLabel, { color: C.muted }]}>cache hit</Text>
        </Ring>
        <View style={styles.tokenGrid}>
          <TokenStat label="Processed" value={formatTokens(eventTokens(totals))} />
          <TokenStat label="Output" value={formatTokens(totals.outputTokens)} />
          <TokenStat label="Cached input" value={formatTokens(totals.cacheReadTokens)} />
          <TokenStat label="Uncached input" value={formatTokens(totals.inputTokens)} />
          {savings !== null && <TokenStat label="Cache savings" value={formatCost(savings)} />}
          {totals.reasoningTokens > 0 && <TokenStat label="Reasoning" value={formatTokens(totals.reasoningTokens)} />}
        </View>
      </Card>
    </>
  );
});

function SectionSkeleton({ title, height, corner }: { title: string; height: number; corner: number }) {
  const { C } = useTheme();
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Skeleton style={{ height, borderRadius: corner, marginHorizontal: gutter, backgroundColor: C.panel }} />
    </>
  );
}

function TokenStat({ label, value }: { label: string; value: string }) {
  const { C } = useTheme();
  return (
    <View style={styles.tokenStat}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <Text style={[styles.tokenValue, { color: C.text }]}>{value}</Text>
    </View>
  );
}

interface Subscription {
  key: string;
  provider: string;
  accountLabel: string | null;
  plan: string | null;
  fetchedAt: string;
  metrics: QuotaCard[];
  lowest: number;
}

/** One entry per provider-account; metric windows (5h, weekly…) live inside. Most urgent first. */
function groupSubscriptions(quotas: QuotaCard[]): Subscription[] {
  const groups = new Map<string, Subscription>();
  for (const quota of quotas) {
    const key = JSON.stringify([quota.provider, quota.accountKey]);
    const group = groups.get(key) ?? {
      key,
      provider: quota.provider,
      accountLabel: quota.accountLabel,
      plan: quota.plan,
      fetchedAt: quota.fetchedAt,
      metrics: [] as QuotaCard[],
      lowest: 100,
    };
    group.metrics.push(quota);
    group.lowest = Math.min(group.lowest, quota.remainingPercent ?? 100);
    if (quota.fetchedAt > group.fetchedAt) group.fetchedAt = quota.fetchedAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.lowest - b.lowest);
}

const STALE_QUOTA_MS = 24 * 3_600_000;

function Limits() {
  const { C } = useTheme();
  const { checkingMachines } = useSyncStatus();
  const quotas = useQuotasQuery();
  const subscriptions = useMemo(() => groupSubscriptions(quotas.data ?? []), [quotas.data]);
  if (quotas.data === undefined) return null;
  return (
    <>
      <SectionTitle trailing={checkingMachines ? "checking…" : "most urgent first"}>Limits</SectionTitle>
      {subscriptions.length === 0 ? (
        <Empty message="No quota snapshots yet. Run `npx burn-report usage` on a machine." />
      ) : (
        subscriptions.map((sub) => {
          const stale = Date.now() - Date.parse(sub.fetchedAt) > STALE_QUOTA_MS;
          return (
            <Card key={sub.key} style={[styles.limitCard, stale && { opacity: 0.55 }]}>
              <View style={{ flex: 1, paddingTop: 2 }}>
                <Text style={[type.h2, { color: C.text }]} numberOfLines={1}>
                  {humanize(sub.provider)}
                </Text>
                <Text style={[type.muted, { color: C.muted, marginTop: 1 }]} numberOfLines={1}>
                  {sub.plan === null ? "Account" : humanize(sub.plan)}
                </Text>
                <Text style={[type.muted, { color: stale ? C.warn : C.faint, marginTop: 6 }]}>
                  {`checked ${formatRelative(sub.fetchedAt)}`}
                </Text>
              </View>
              <View style={styles.limitMetrics}>
                {sub.metrics.map((quota) => {
                  const remaining = quota.remainingPercent;
                  const tone = remaining === null ? C.faint : remaining <= 15 ? C.err : remaining <= 35 ? C.warn : C.text;
                  const resets = formatUntil(quota.resetsAt);
                  return (
                    <View key={quota.metric} style={styles.limitMetric}>
                      <Ring fraction={(remaining ?? 0) / 100} size={50} stroke={4.5} color={tone}>
                        <Text style={[styles.limitPct, { color: remaining !== null && remaining <= 15 ? C.err : C.text }]}>
                          {remaining === null ? "—" : `${remaining.toFixed(0)}%`}
                        </Text>
                      </Ring>
                      <Text style={[styles.limitName, { color: C.text }]} numberOfLines={1}>
                        {humanize(quota.metric)}
                      </Text>
                      <Text style={[styles.limitReset, { color: C.faint }]} numberOfLines={1}>
                        {resets ?? "left"}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </Card>
          );
        })
      )}
    </>
  );
}

function MachineStrip() {
  const { C } = useTheme();
  const { machineStates } = useSyncStatus();
  const machines = useMachinesQuery();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  if (machines.data === undefined || machines.data.length === 0) return null;
  return (
    <>
      <SectionTitle trailing="Manage" onTrailingPress={() => navigation.navigate("machines")}>
        Machines
      </SectionTitle>
      <View style={styles.machineStrip}>
        {machines.data.map((machine) => {
          const state = machineStates[machine.id];
          const live = state === "live";
          return (
            <PressableScale
              key={machine.id}
              accessibilityRole="button"
              accessibilityLabel={`${machine.displayName}, ${live ? "live" : "last seen " + formatRelative(machine.lastHeartbeatAt)}`}
              onPress={() => navigation.navigate("machines")}
              style={[styles.machineChip, { backgroundColor: C.panel, borderColor: C.border }]}
            >
              <Dot color={live ? C.ok : state === "error" || state === "skipped" ? C.warn : C.faint} size={7} />
              <Text style={[type.muted, { color: C.text, fontWeight: "600" }]} numberOfLines={1}>
                {machine.displayName}
              </Text>
              <Text style={[type.muted, { color: C.faint }]}>
                {live ? "live" : formatRelative(machine.lastHeartbeatAt).replace(" ago", "")}
              </Text>
            </PressableScale>
          );
        })}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  hero: { paddingHorizontal: gutter, paddingTop: spacing.s },
  heroTop: { flexDirection: "row", alignItems: "center", gap: spacing.m, marginBottom: 6 },
  metricToggle: { width: 138 },
  heroSkeleton: { height: 46, width: 190, borderRadius: radius.s, marginVertical: 2 },
  chartWrap: { marginTop: spacing.l, minHeight: 196 },
  chartSkeleton: { height: 196, borderRadius: radius.m },
  agentRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, marginTop: 2 },
  swatch: { width: 8, height: 8, borderRadius: 2, marginRight: 10 },
  agentValue: { width: 78, textAlign: "right", fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  tokensCard: { flexDirection: "row", alignItems: "center", gap: spacing.l },
  ringValue: { fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -0.4 },
  ringLabel: { fontSize: 9.5, fontWeight: "600", marginTop: -1 },
  tokenGrid: { flex: 1, flexDirection: "row", flexWrap: "wrap", rowGap: spacing.m },
  tokenStat: { width: "50%" },
  tokenValue: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 1, letterSpacing: -0.3 },
  limitCard: { flexDirection: "row", alignItems: "flex-start", gap: spacing.m, paddingVertical: 14 },
  limitMetrics: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 216, rowGap: spacing.m },
  limitMetric: { width: 72, alignItems: "center" },
  limitPct: { fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -0.3 },
  limitName: { fontSize: 11.5, fontWeight: "600", marginTop: 6 },
  limitReset: { fontSize: 10.5, fontVariant: ["tabular-nums"], marginTop: 1 },
  machineStrip: { flexDirection: "row", flexWrap: "wrap", gap: spacing.s, marginHorizontal: gutter },
  machineChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: radius.pill,
    borderWidth: hairline,
  },
});
