import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMachinesQuery, useQuotasQuery } from "../data/queries";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { latestQuotaAt, reporterIssue } from "../lib/system-health";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Chip, Empty, SectionTitle, Stat } from "../ui/primitives";

export function SystemsScreen() {
  const { mode, requestSync } = useApp();
  const {
    lastSync,
    syncError,
    syncNotice,
    refreshingMachines,
    checkingMachines,
    liveMachines,
  } = useSyncStatus();
  const machines = useMachinesQuery();
  const quotas = useQuotasQuery();
  const { C } = useTheme();
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const now = Date.now();

  const liveBySlug = useMemo(
    () => new Map(liveMachines.map((status) => [status.slug, status])),
    [liveMachines],
  );
  const reporterIssues = (machines.data ?? []).filter((machine) =>
    reporterIssue(machine, liveBySlug.get(machine.slug), now) !== null,
  ).length;
  const quotaFailures = liveMachines.filter(
    (status) => "quotaError" in status && status.quotaError !== null,
  ).length;
  const hasAttention =
    syncError !== null || syncNotice !== null || reporterIssues > 0 || quotaFailures > 0;
  const overall =
    refreshingMachines || checkingMachines
      ? { label: "syncing", tone: "accent" as const }
      : machines.data === undefined
        ? { label: "checking", tone: "muted" as const }
        : machines.data.length === 0
          ? { label: "waiting", tone: "yellow" as const }
          : hasAttention
            ? { label: "attention", tone: "yellow" as const }
            : { label: "healthy", tone: "green" as const };

  const refresh = () => {
    if (mode === "cloud" || mode === "direct") {
      void requestSync(null);
      return;
    }
    setLocalRefreshing(true);
    void Promise.all([machines.refetch(), quotas.refetch()]).finally(() => setLocalRefreshing(false));
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={mode === "cloud" || mode === "direct" ? refreshingMachines : localRefreshing}
            onRefresh={refresh}
            tintColor={C.muted}
          />
        }
      >
        <View style={styles.titleRow}>
          <Text style={[type.title, { color: C.text, flex: 1 }]}>System Health</Text>
          <Chip tone={overall.tone}>{overall.label}</Chip>
        </View>
        <Text style={[type.muted, { color: C.muted, marginHorizontal: spacing.l }]}>
          Local mirror, sync path, reporter freshness, and quota collection at a glance.
        </Text>

        <SectionTitle trailing={checkingMachines ? "checking machines…" : undefined}>Sync path</SectionTitle>
        <Card>
          <View style={styles.statRow}>
            <Stat label="Backend" value={humanize(mode)} />
            <Stat
              label="Last refresh"
              value={lastSync === null ? "Never" : formatRelative(lastSync.toISOString())}
            />
          </View>
          {syncError !== null && <Text style={[styles.message, { color: C.err }]}>{syncError}</Text>}
          {syncNotice !== null && <Text style={[styles.message, { color: C.warn }]}>{syncNotice}</Text>}
          {syncError === null && syncNotice === null && (
            <Text style={[styles.message, { color: C.muted }]}>No sync errors reported.</Text>
          )}
          {(mode === "cloud" || mode === "direct") && (
            <Pressable
              accessibilityRole="button"
              disabled={refreshingMachines}
              android_ripple={{ color: C.border, foreground: true, borderless: false }}
              style={[
                styles.refreshButton,
                { backgroundColor: C.panelAlt, borderColor: C.border, opacity: refreshingMachines ? 0.5 : 1 },
              ]}
              onPress={() => void requestSync(null)}
            >
              <Text style={{ color: C.text, fontWeight: "600" }}>
                {refreshingMachines ? "Refreshing…" : "Refresh all systems"}
              </Text>
            </Pressable>
          )}
        </Card>

        <SectionTitle trailing={`${machines.data?.length ?? 0} reporters`}>Reporters</SectionTitle>
        {machines.data !== undefined && machines.data.length === 0 ? (
          <Empty message="No systems have reported yet." />
        ) : (
          machines.data?.map((machine) => {
            const live = liveBySlug.get(machine.slug);
            const issue = reporterIssue(machine, live, now);
            return (
              <Card key={machine.id}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[type.h2, { color: C.text }]} numberOfLines={1}>
                      {machine.displayName}
                    </Text>
                    <Text style={[type.muted, { color: C.muted }]}>
                      {`${humanize(machine.osKind)} · ${machine.slug}`}
                    </Text>
                  </View>
                  <Chip tone={issue === null ? "green" : "yellow"}>
                    {issue === null ? "healthy" : "attention"}
                  </Chip>
                </View>
                <Text style={[type.muted, { color: C.muted, marginTop: spacing.s }]}>
                  {`heartbeat ${formatRelative(machine.lastHeartbeatAt)} · last push ${formatRelative(machine.lastSuccessAt)} · revision ${machine.latestRevision}`}
                </Text>
                <Text style={[type.muted, { color: C.faint, marginTop: 4 }]}>
                  {`tokscale ${machine.tokscaleVersion ?? "unknown"} · reporter ${machine.reporterVersion ?? "unknown"}`}
                </Text>
                {issue !== null && <Text style={{ color: C.warn, marginTop: spacing.s }}>{issue}</Text>}
              </Card>
            );
          })
        )}

        <SectionTitle trailing={`${quotas.data?.length ?? 0} metrics`}>Quota feed</SectionTitle>
        <Card>
          <View style={styles.statRow}>
            <Stat
              label="Latest snapshot"
              value={formatRelative(latestQuotaAt(quotas.data ?? []))}
            />
            <Stat
              label="Accounts"
              value={String(new Set((quotas.data ?? []).map((quota) => `${quota.provider}|${quota.accountKey}`)).size)}
            />
          </View>
          <Text style={[styles.message, { color: quotaFailures > 0 ? C.warn : C.muted }]}>
            {quotaFailures > 0
              ? `${quotaFailures} direct quota refresh${quotaFailures === 1 ? "" : "es"} failed; last-good values remain visible.`
              : "Freshest successful value wins across reporters; failures do not replace last-good values."}
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s,
    marginHorizontal: spacing.l,
    marginTop: spacing.m,
    marginBottom: spacing.s,
  },
  statRow: { flexDirection: "row", gap: spacing.m },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.s },
  message: { ...type.muted, marginTop: spacing.m },
  refreshButton: {
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: spacing.m,
    overflow: "hidden",
  },
});
