import { useId, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Line, Path, Stop } from "react-native-svg";
import { useSystemsQuery } from "../data/queries";
import type { MachineMetricRow, SystemRow } from "../data/repository";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Chip, Empty, SectionTitle } from "../ui/primitives";

type MetricKey = "cpuLoadPct" | "cpuTempC" | "ramUsedPct" | "ramTempC" | "gpuUtilPct" | "gpuTempC";

function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  let path = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[Math.min(points.length - 1, index + 2)]!;
    path += ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(2)}, ${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

function Sparkline({ values, ceiling = 100 }: { values: number[]; ceiling?: number | undefined }) {
  const { C } = useTheme();
  const gradientId = useId();
  if (values.length < 2) return <View style={{ height: 58 }} />;
  const width = 120;
  const height = 58;
  const bottom = height - 3;
  const max = Math.max(ceiling, ...values);
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: bottom - (value / max) * (height - 8),
  }));
  const line = smoothPath(points);
  const last = points.at(-1)!;
  const area = `${line} L ${last.x.toFixed(2)} ${bottom} L 0 ${bottom} Z`;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={C.text} stopOpacity={0.28} />
          <Stop offset="1" stopColor={C.text} stopOpacity={0.02} />
        </LinearGradient>
      </Defs>
      <Line x1={0} x2={width} y1={bottom} y2={bottom} stroke={C.border} strokeWidth={1} />
      <Path d={area} fill={`url(#${gradientId})`} />
      <Path d={line} stroke={C.text} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Circle cx={last.x} cy={last.y} r={2.4} fill={C.text} />
    </Svg>
  );
}

function MetricTile({ label, unit, samples, field }: {
  label: string;
  unit: "%" | "°";
  samples: MachineMetricRow[];
  field: MetricKey;
}) {
  const { C } = useTheme();
  const values = samples.flatMap((sample) => {
    const value = sample[field];
    return value === null ? [] : [value];
  });
  const latest = values.at(-1);
  return (
    <View style={[styles.metricTile, { backgroundColor: C.panelAlt }]}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: C.text }]}>
        {latest === undefined ? "—" : `${Math.round(latest)}${unit}`}
      </Text>
      <Sparkline values={values} ceiling={100} />
      <Text style={[styles.range, { color: C.faint }]}>
        {latest === undefined
          ? "sensor unavailable"
          : values.length < 2 ? "new sample" : `${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}${unit} · 24h`}
      </Text>
    </View>
  );
}

function machineState(system: SystemRow, now: number): { label: string; tone: "green" | "yellow" | "red" | "muted" } {
  const latest = system.metrics.at(-1);
  if (latest === undefined) return { label: "no data", tone: "muted" };
  if (now - latest.capturedAtMs > 20 * 60_000) return { label: "stale", tone: "yellow" };
  if ((latest.ramTempC ?? 0) >= 90 || (latest.gpuTempC ?? 0) >= 90) return { label: "hot", tone: "red" };
  if (latest.ramUsedPct >= 90 || (latest.gpuUtilPct ?? 0) >= 95) return { label: "busy", tone: "yellow" };
  return { label: "healthy", tone: "green" };
}

export function SystemsScreen() {
  const { mode, requestSync } = useApp();
  const { refreshingMachines } = useSyncStatus();
  const systems = useSystemsQuery();
  const { C } = useTheme();
  const [demoRefreshing, setDemoRefreshing] = useState(false);
  const now = Date.now();

  const refresh = () => {
    if (mode === "cloud" || mode === "direct") {
      void requestSync(null);
      return;
    }
    setDemoRefreshing(true);
    void systems.refetch().finally(() => setDemoRefreshing(false));
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={mode === "cloud" || mode === "direct" ? refreshingMachines : demoRefreshing}
            onRefresh={refresh}
            tintColor={C.muted}
          />
        }
      >
        <Text style={[type.title, styles.title, { color: C.text }]}>Systems</Text>
        <Text style={[type.muted, styles.subtitle, { color: C.muted }]}>
          Machine vitals sampled every reporter cycle and refreshed live on probe. Sparklines show the trailing 24 hours.
        </Text>

        <SectionTitle trailing={`${systems.data?.length ?? 0} machines`}>Machine health</SectionTitle>
        {systems.data !== undefined && systems.data.length === 0 ? (
          <Empty message="No machines have reported yet." />
        ) : (
          systems.data?.map((system) => {
            const state = machineState(system, now);
            const latest = system.metrics.at(-1);
            return (
              <Card key={system.id}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[type.h2, { color: C.text }]} numberOfLines={1}>{system.displayName}</Text>
                    <Text style={[type.muted, { color: C.muted }]}>{humanize(system.osKind)} · {system.slug}</Text>
                  </View>
                  <Chip tone={state.tone}>{state.label}</Chip>
                </View>
                <Text style={[type.muted, { color: C.faint, marginTop: spacing.s }]}>
                  {latest === undefined ? "No health sample yet" : `sampled ${formatRelative(new Date(latest.capturedAtMs).toISOString())}`}
                </Text>
                {latest === undefined ? (
                  <View style={[styles.missing, { borderColor: C.border }]}>
                    <Text style={[type.muted, { color: C.muted }]}>Update this machine’s reporter, then run daemon or serve to collect vitals.</Text>
                  </View>
                ) : (
                  <View style={styles.grid}>
                    <MetricTile label="RAM usage" unit="%" samples={system.metrics} field="ramUsedPct" />
                    <MetricTile label="RAM temperature" unit="°" samples={system.metrics} field="ramTempC" />
                    <MetricTile label="GPU usage" unit="%" samples={system.metrics} field="gpuUtilPct" />
                    <MetricTile label="GPU temperature" unit="°" samples={system.metrics} field="gpuTempC" />
                  </View>
                )}
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: { marginHorizontal: spacing.l, marginTop: spacing.m },
  subtitle: { marginHorizontal: spacing.l, marginTop: spacing.s, lineHeight: 18 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.s },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.s, marginTop: spacing.m },
  metricTile: { width: "48.5%", borderRadius: 10, padding: spacing.m },
  metricValue: { fontSize: 25, fontWeight: "700", fontVariant: ["tabular-nums"], marginTop: 2 },
  range: { fontSize: 10.5, marginTop: 2 },
  missing: { borderTopWidth: 1, marginTop: spacing.m, paddingTop: spacing.m },
});
