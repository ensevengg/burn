import { useState } from "react";
import { LayoutAnimation, StyleSheet, Text, View } from "react-native";
import { useSystemsQuery } from "../data/queries";
import type { MachineMetricRow, SystemRow } from "../data/repository";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { gutter, hairline, radius, spacing, type } from "../theme";
import { Card, Chip, Empty, SectionTitle } from "../ui/primitives";
import { FadeIn, PressableScale, TweenText } from "../ui/motion";
import { Sparkline } from "../ui/charts";
import { Screen } from "../ui/screen";

type MetricKey = "cpuLoadPct" | "cpuTempC" | "ramUsedPct" | "ramTempC" | "gpuUtilPct" | "gpuTempC";

const STALE_AFTER_MS = 20 * 60_000;
const formatWhole = (n: number) => String(Math.round(n));

function MetricTile({
  label,
  unit,
  samples,
  field,
  warnAt,
}: {
  label: string;
  unit: "%" | "°";
  samples: MachineMetricRow[];
  field: MetricKey;
  warnAt: number;
}) {
  const { C } = useTheme();
  const values = samples.flatMap((sample) => {
    const value = sample[field];
    return value === null ? [] : [value];
  });
  const latest = samples.at(-1)?.[field] ?? null;
  const hot = latest !== null && latest >= warnAt;
  return (
    <View style={[styles.tile, { backgroundColor: C.panelAlt }]}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <View style={styles.tileValueRow}>
        {latest === null ? (
          <Text style={[styles.tileValue, { color: C.faint }]}>—</Text>
        ) : (
          <TweenText value={latest} format={formatWhole} style={[styles.tileValue, { color: hot ? C.warn : C.text }]} />
        )}
        {latest !== null && <Text style={[styles.tileUnit, { color: C.muted }]}>{unit === "°" ? "°C" : "%"}</Text>}
      </View>
      {values.length > 1 ? (
        <Sparkline values={values} ceiling={100} height={34} color={hot ? C.warn : C.text} />
      ) : (
        <View style={{ height: 34, justifyContent: "flex-end" }}>
          <Text style={[styles.tileNote, { color: C.faint }]}>{latest === null ? "no sensor" : "first sample"}</Text>
        </View>
      )}
      {values.length > 1 && (
        <Text style={[styles.tileNote, { color: C.faint }]}>
          {`${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}${unit} · 24h`}
        </Text>
      )}
    </View>
  );
}

function machineState(system: SystemRow, now: number): { label: string; tone: "green" | "yellow" | "red" | "muted" } {
  const latest = system.metrics.at(-1);
  if (latest === undefined) return { label: "no data", tone: "muted" };
  if (now - latest.capturedAtMs > STALE_AFTER_MS) return { label: "stale", tone: "yellow" };
  if ((latest.ramTempC ?? 0) >= 90 || (latest.gpuTempC ?? 0) >= 90) return { label: "hot", tone: "red" };
  if (latest.ramUsedPct >= 90 || (latest.gpuUtilPct ?? 0) >= 95) return { label: "busy", tone: "yellow" };
  return { label: "healthy", tone: "green" };
}

export function SystemsScreen() {
  const { liveMachines } = useSyncStatus();
  const systems = useSystemsQuery();
  const { C } = useTheme();
  const [openId, setOpenId] = useState<string | null>(null);
  const now = Date.now();
  const reporting = (systems.data ?? []).filter((system) => {
    const latest = system.metrics.at(-1);
    return latest !== undefined && now - latest.capturedAtMs <= STALE_AFTER_MS;
  });
  const quiet = (systems.data ?? []).filter((system) => !reporting.includes(system));

  return (
    <Screen title="Systems">
      <Text style={[type.muted, styles.subtitle, { color: C.muted }]}>
        Vitals sampled every 30 seconds. Trends cover the trailing 24 hours.
      </Text>
      {systems.data !== undefined && systems.data.length === 0 && <Empty message="No machines have reported yet." />}
      {reporting.map((system, index) => {
        const state = machineState(system, now);
        const latest = system.metrics.at(-1)!;
        const probe = liveMachines.find((machine) => machine.environmentId === system.id);
        return (
          <FadeIn key={system.id} delay={index * 60}>
            <Card>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[type.h2, { color: C.text, fontSize: 17 }]} numberOfLines={1}>
                    {system.displayName}
                  </Text>
                  <Text style={[type.muted, { color: C.muted, marginTop: 1 }]}>
                    {`${humanize(system.osKind)} · sampled ${formatRelative(new Date(latest.capturedAtMs).toISOString(), now)}`}
                  </Text>
                </View>
                <Chip tone={state.tone} dot>
                  {state.label}
                </Chip>
              </View>
              {probe?.metricsError ? (
                <Text style={[type.muted, { color: C.warn, marginTop: spacing.s }]} numberOfLines={2}>
                  {`Health refresh failed: ${probe.metricsError}`}
                </Text>
              ) : null}
              <View style={styles.grid}>
                <MetricTile label="RAM" unit="%" samples={system.metrics} field="ramUsedPct" warnAt={90} />
                <MetricTile label="GPU" unit="%" samples={system.metrics} field="gpuUtilPct" warnAt={95} />
                <MetricTile label="RAM temp" unit="°" samples={system.metrics} field="ramTempC" warnAt={85} />
                <MetricTile label="GPU temp" unit="°" samples={system.metrics} field="gpuTempC" warnAt={85} />
              </View>
            </Card>
          </FadeIn>
        );
      })}
      {quiet.length > 0 && (
        <>
          <SectionTitle trailing={`${quiet.length}`}>Not reporting</SectionTitle>
          <Card style={{ paddingVertical: 4 }}>
            {quiet.map((system, index) => {
              const latest = system.metrics.at(-1);
              const probe = liveMachines.find((machine) => machine.environmentId === system.id);
              const reason = probe?.metricsError ?? (probe !== undefined && probe.state !== "live" ? probe.error : null);
              const open = openId === system.id;
              return (
                <PressableScale
                  key={system.id}
                  scaleTo={0.985}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setOpenId(open ? null : system.id);
                  }}
                  style={[styles.quietRow, index > 0 && { borderTopWidth: hairline, borderTopColor: C.border }]}
                >
                  <View style={styles.quietTop}>
                    <View style={[styles.quietDot, { borderColor: C.faint }]} />
                    <Text style={[type.body, { color: C.text, fontWeight: "600", flex: 1 }]} numberOfLines={1}>
                      {system.displayName}
                    </Text>
                    <Text style={[type.muted, { color: C.faint }]}>
                      {latest === undefined
                        ? `seen ${formatRelative(system.lastHeartbeatAt, now)}`
                        : `sampled ${formatRelative(new Date(latest.capturedAtMs).toISOString(), now)}`}
                    </Text>
                  </View>
                  {open && (
                    <Text style={[type.muted, styles.quietDetail, { color: C.muted }]}>
                      {reason
                        ? `Last attempt: ${reason}`
                        : latest === undefined
                          ? "No health samples yet. Update this machine's reporter, then keep its daemon running."
                          : "The machine stopped answering; showing its last known samples."}
                    </Text>
                  )}
                </PressableScale>
              );
            })}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { marginHorizontal: gutter, marginBottom: spacing.m, lineHeight: 18 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.s },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.s, marginTop: spacing.l },
  tile: { width: "48.6%", borderRadius: radius.m, padding: spacing.m, paddingBottom: 10 },
  tileValueRow: { flexDirection: "row", alignItems: "baseline", marginTop: 2, marginBottom: 6 },
  tileValue: { fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -0.8 },
  tileUnit: { fontSize: 13, fontWeight: "600", marginLeft: 2 },
  tileNote: { fontSize: 10.5, marginTop: 4, fontVariant: ["tabular-nums"] },
  quietRow: { paddingVertical: 12 },
  quietTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  quietDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  quietDetail: { marginTop: 6, marginLeft: 18, lineHeight: 17 },
});
