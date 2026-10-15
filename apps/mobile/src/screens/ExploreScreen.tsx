import { memo, useCallback, useMemo, useState } from "react";
import { Animated, LayoutAnimation, StyleSheet, Text, View } from "react-native";
import { useClientsQuery, useModelsQuery, useSessionsQuery, useWorkspacesQuery } from "../data/queries";
import { formatCost, formatPercent, formatRelative, formatTokens } from "../lib/format";
import { humanize } from "../lib/labels";
import { useTheme } from "../lib/theme-context";
import { gutter, hairline, radius, spacing, type } from "../theme";
import { Empty, Segmented, ShareBar } from "../ui/primitives";
import { GrowBar, PressableScale, Skeleton } from "../ui/motion";
import { Screen } from "../ui/screen";
import { eventTokens, type BreakdownRow, type SessionRow } from "../data/repository";
import { EXPLORE_RANGES, USAGE_RANGES, type UsageRangeId } from "../lib/usage-range";

type Tab = "models" | "clients" | "workspaces" | "sessions";

const TABS = [
  { label: "Models", value: "models" },
  { label: "Agents", value: "clients" },
  { label: "Spaces", value: "workspaces" },
  { label: "Sessions", value: "sessions" },
] as const;

const NOUNS: Record<Tab, [string, string]> = {
  models: ["model", "models"],
  clients: ["agent", "agents"],
  workspaces: ["workspace", "workspaces"],
  sessions: ["session", "sessions"],
};

/** Expanding a row animates the list's layout once, natively. */
const expandAnimation = LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity);

export function ExploreScreen() {
  const [tab, setTab] = useState<Tab>("models");
  const [rangeId, setRangeId] = useState<UsageRangeId>("30");
  const [expanded, setExpanded] = useState<string | null>(null);
  const windowDays = USAGE_RANGES[rangeId].days;
  const { C } = useTheme();

  const models = useModelsQuery(windowDays, tab === "models");
  const clients = useClientsQuery(windowDays, tab === "clients");
  const workspaces = useWorkspacesQuery(windowDays, tab === "workspaces");
  const sessions = useSessionsQuery(windowDays, tab === "sessions");
  const breakdown = tab === "models" ? models : tab === "clients" ? clients : workspaces;
  const modelMode = tab === "models";
  const rows = tab === "sessions" ? sessions.data : breakdown.data;
  const loading = rows === undefined;

  const { maxValue, totalValue, totalCost, totalTokens } = useMemo(() => {
    const data = breakdown.data ?? [];
    const value = (row: BreakdownRow) => (modelMode ? eventTokens(row) : row.cost);
    return {
      maxValue: Math.max(0.000001, ...data.map(value)),
      totalValue: data.reduce((sum, row) => sum + value(row), 0),
      totalCost: data.reduce((sum, row) => sum + row.cost, 0),
      totalTokens: data.reduce((sum, row) => sum + eventTokens(row), 0),
    };
  }, [breakdown.data, modelMode]);

  const toggle = useCallback((key: string) => {
    LayoutAnimation.configureNext(expandAnimation);
    setExpanded((current) => (current === key ? null : key));
  }, []);
  const changeTab = (next: Tab) => {
    setExpanded(null);
    setTab(next);
  };

  const count = rows?.length ?? 0;
  const [singular, plural] = NOUNS[tab];
  const summary =
    tab === "sessions"
      ? `${count} ${count === 1 ? singular : plural} · most recent first`
      : `${count} ${count === 1 ? singular : plural} · ${formatTokens(totalTokens)} tokens · ${formatCost(totalCost)}`;

  return (
    <Screen
      title="Explore"
      renderList={(scroll) => (
        <Animated.FlatList<BreakdownRow | SessionRow>
          key={`${tab}-${rangeId}`}
          data={(rows ?? []) as (BreakdownRow | SessionRow)[]}
          keyExtractor={(row) => row.key}
          extraData={expanded}
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          windowSize={7}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}
          contentContainerStyle={scroll.contentContainerStyle}
          refreshControl={scroll.refreshControl}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <>
              {scroll.largeTitle}
              <View style={styles.controls}>
                <Segmented options={TABS} value={tab} onChange={changeTab} />
                <Segmented options={EXPLORE_RANGES} value={rangeId} onChange={setRangeId} size="s" />
              </View>
              <Text style={[type.muted, styles.summary, { color: C.faint }]}>{loading ? " " : summary}</Text>
            </>
          }
          ListEmptyComponent={loading ? <ListSkeleton /> : <Empty message="No usage in this window." />}
          renderItem={({ item, index }) =>
            tab === "sessions" ? (
              <SessionItem
                session={item as SessionRow}
                first={index === 0}
                open={expanded === item.key}
                onToggle={toggle}
              />
            ) : (
              <BreakdownItem
                row={item as BreakdownRow}
                index={index}
                maxValue={maxValue}
                totalValue={totalValue}
                modelMode={modelMode}
                open={expanded === item.key}
                onToggle={toggle}
              />
            )
          }
        />
      )}
    />
  );
}

function ListSkeleton() {
  const { C } = useTheme();
  return (
    <View style={{ paddingHorizontal: gutter, gap: 18, paddingTop: 10 }}>
      {[0.9, 0.7, 0.55, 0.4, 0.3].map((width) => (
        <View key={width} style={{ gap: 8 }}>
          <Skeleton style={{ height: 14, width: `${width * 100}%`, borderRadius: 6, backgroundColor: C.panelAlt }} />
          <Skeleton style={{ height: 4, width: `${width * 80}%`, borderRadius: 2, backgroundColor: C.panelAlt }} />
        </View>
      ))}
    </View>
  );
}

const BreakdownItem = memo(function BreakdownItem({
  row,
  index,
  maxValue,
  totalValue,
  modelMode,
  open,
  onToggle,
}: {
  row: BreakdownRow;
  index: number;
  maxValue: number;
  totalValue: number;
  modelMode: boolean;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const { C } = useTheme();
  const processed = eventTokens(row);
  const primary = modelMode ? processed : row.cost;
  const attribution = modelMode
    ? [...new Set([...row.providers, ...row.clients].map(humanize))].join(" · ")
    : humanize(row.subtitle ?? "") || `${row.sessions} sessions`;
  const mix = [
    { key: "Input", value: row.inputTokens },
    { key: "Cached", value: row.cacheReadTokens },
    { key: "Written", value: row.cacheWriteTokens },
    { key: "Output", value: row.outputTokens },
    { key: "Reasoning", value: row.reasoningTokens },
  ];
  return (
    <PressableScale
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={`${humanize(row.title)}, ${modelMode ? formatTokens(processed) : formatCost(row.cost)}`}
      accessibilityState={{ expanded: open }}
      onPress={() => onToggle(row.key)}
      style={[styles.item, index > 0 && { borderTopWidth: hairline, borderTopColor: C.border }]}
    >
      <View style={styles.itemTop}>
        <Text style={[styles.rank, { color: C.faint }]}>{String(index + 1).padStart(2, "0")}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[type.body, { color: C.text, fontWeight: "600" }]} numberOfLines={1}>
            {humanize(row.title)}
          </Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 1 }]} numberOfLines={1}>
            {attribution}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[styles.value, { color: C.text }]}>
            {modelMode ? formatTokens(processed) : formatCost(row.cost)}
          </Text>
          <Text style={[type.muted, { color: C.faint, marginTop: 1, fontVariant: ["tabular-nums"] }]}>
            {modelMode ? formatCost(row.cost) : `${formatTokens(processed)} tok`}
          </Text>
        </View>
      </View>
      <View style={styles.barRow}>
        <GrowBar fraction={primary / maxValue} color={C.text} track={C.panelAlt} height={3} delay={Math.min(index, 8) * 30} />
      </View>
      {open && (
        <View style={styles.detail}>
          <ShareBar
            height={6}
            shares={mix.map((part, i) => ({
              key: part.key,
              fraction: processed === 0 ? 0 : part.value / processed,
              color: C.chart[Math.min(i, C.chart.length - 1)]!,
            }))}
          />
          <View style={styles.mixGrid}>
            {mix.map((part, i) => (
              <View key={part.key} style={styles.mixCell}>
                <View style={[styles.mixSwatch, { backgroundColor: C.chart[Math.min(i, C.chart.length - 1)] }]} />
                <Text style={[type.muted, { color: C.muted }]}>{part.key}</Text>
                <Text style={[type.muted, { color: C.text, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>
                  {formatTokens(part.value)}
                </Text>
              </View>
            ))}
          </View>
          <View style={styles.detailStats}>
            <Detail label="Share" value={formatPercent(primary / (totalValue || 1))} />
            <Detail label="Cache hit" value={formatPercent(row.hitRate)} />
            <Detail label="Sessions" value={String(row.sessions)} />
            <Detail label="Messages" value={row.messages.toLocaleString("en")} />
          </View>
        </View>
      )}
    </PressableScale>
  );
});

function Detail({ label, value }: { label: string; value: string }) {
  const { C } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.muted, { color: C.faint, fontSize: 11 }]}>{label}</Text>
      <Text style={[type.body, { color: C.text, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>{value}</Text>
    </View>
  );
}

const SessionItem = memo(function SessionItem({
  session,
  first,
  open,
  onToggle,
}: {
  session: SessionRow;
  first: boolean;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const { C } = useTheme();
  return (
    <PressableScale
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => onToggle(session.key)}
      style={[styles.item, !first && { borderTopWidth: hairline, borderTopColor: C.border }]}
    >
      <View style={styles.itemTop}>
        <View style={{ flex: 1 }}>
          <Text style={[type.body, { color: C.text, fontWeight: "600" }]} numberOfLines={open ? 3 : 1}>
            {session.title ?? session.sessionId}
          </Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 2 }]} numberOfLines={1}>
            {`${humanize(session.client)} · ${formatRelative(new Date(session.lastActivityMs).toISOString())}`}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={[styles.value, { color: C.text }]}>{formatCost(session.cost)}</Text>
          <Text style={[type.muted, { color: C.faint, marginTop: 1, fontVariant: ["tabular-nums"] }]}>
            {`${formatTokens(session.tokens)} tok`}
          </Text>
        </View>
      </View>
      {open && (
        <View style={[styles.detail, { marginLeft: 0 }]}>
          <View style={styles.modelChips}>
            {session.models.map((model) => (
              <View key={model} style={[styles.modelChip, { backgroundColor: C.panelAlt }]}>
                <Text style={[type.muted, { color: C.text }]}>{humanize(model)}</Text>
              </View>
            ))}
          </View>
          <View style={styles.detailStats}>
            <Detail label="Messages" value={session.messages.toLocaleString("en")} />
            <Detail label="Tokens" value={formatTokens(session.tokens)} />
            <Detail label="Cost" value={formatCost(session.cost)} />
          </View>
        </View>
      )}
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  controls: { paddingHorizontal: gutter, gap: spacing.s, marginTop: spacing.xs },
  summary: { marginHorizontal: gutter, marginTop: spacing.m, marginBottom: spacing.xs },
  item: { marginHorizontal: gutter, paddingVertical: 14 },
  itemTop: { flexDirection: "row", alignItems: "center", gap: spacing.m },
  rank: { width: 20, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  value: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -0.2 },
  barRow: { marginTop: 10, marginLeft: 32 },
  detail: { marginTop: spacing.m, marginLeft: 32, gap: spacing.m },
  mixGrid: { flexDirection: "row", flexWrap: "wrap", rowGap: 6 },
  mixCell: { width: "50%", flexDirection: "row", alignItems: "center", gap: 6 },
  mixSwatch: { width: 7, height: 7, borderRadius: 2 },
  detailStats: { flexDirection: "row", gap: spacing.s },
  modelChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  modelChip: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
});
