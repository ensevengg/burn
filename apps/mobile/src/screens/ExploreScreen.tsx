import { useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useClientsQuery, useModelsQuery, useSessionsQuery, useWorkspacesQuery } from "../data/queries";
import { formatCost, formatPercent, formatRelative, formatTokens } from "../lib/format";
import { humanize } from "../lib/labels";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, Empty, MeterBar, SectionTitle, Segmented } from "../ui/primitives";
import type { BreakdownRow, SessionRow } from "../data/repository";

type Tab = "models" | "clients" | "workspaces" | "sessions";

const TABS = [
  { label: "Models", value: "models" },
  { label: "Agents", value: "clients" },
  { label: "Workspaces", value: "workspaces" },
  { label: "Sessions", value: "sessions" },
] as const;

const WINDOWS = [
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
  { label: "365d", value: "365" },
] as const;

export function ExploreScreen() {
  const [tab, setTab] = useState<Tab>("models");
  const [windowDays, setWindowDays] = useState(30);
  const { C } = useTheme();

  const models = useModelsQuery(windowDays, tab === "models");
  const clients = useClientsQuery(windowDays, tab === "clients");
  const workspaces = useWorkspacesQuery(windowDays, tab === "workspaces");
  const sessions = useSessionsQuery(windowDays, tab === "sessions");

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      {tab === "sessions" ? (
        <FlatList<SessionRow>
          key={`sessions-${windowDays}`}
          data={sessions.data ?? []}
          keyExtractor={(row) => row.key}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            <>
              <Text style={[type.title, { color: C.text }, styles.title]}>Explore</Text>
              <Segmented options={TABS} value={tab} onChange={setTab} />
              <Segmented
                options={WINDOWS}
                value={String(windowDays)}
                onChange={(v) => setWindowDays(Number(v))}
              />
              <SectionTitle trailing="recent first">{sessions.data?.length ?? 0} sessions</SectionTitle>
            </>
          }
          ListEmptyComponent={
            <Empty message={sessions.data === undefined ? "Loading…" : "No sessions in this window."} />
          }
          renderItem={({ item }) => <SessionItem session={item} />}
        />
      ) : (
        <FlatList<BreakdownRow>
          key={`${tab}-${windowDays}`}
          data={(tab === "models" ? models.data : tab === "clients" ? clients.data : workspaces.data) ?? []}
          keyExtractor={(row) => row.key}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            <>
              <Text style={[type.title, { color: C.text }, styles.title]}>Explore</Text>
              <Segmented options={TABS} value={tab} onChange={setTab} />
              <Segmented
                options={WINDOWS}
                value={String(windowDays)}
                onChange={(v) => setWindowDays(Number(v))}
              />
              <SectionTitle trailing="by spend">{humanize(tab)}</SectionTitle>
            </>
          }
          ListEmptyComponent={
            <Empty
              message={
                (tab === "models" ? models.data : tab === "clients" ? clients.data : workspaces.data) ===
                undefined
                  ? "Loading…"
                  : "No usage in this window."
              }
            />
          }
          renderItem={({ item, index }) => (
            <BreakdownItem
              row={item}
              index={index}
              maxCost={Math.max(
                (tab === "models" ? models.data : tab === "clients" ? clients.data : workspaces.data)?.[0]
                  ?.cost ?? 0,
                0.000001,
              )}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function BreakdownItem({ row, index, maxCost }: { row: BreakdownRow; index: number; maxCost: number }) {
  const { C } = useTheme();
  return (
    <Card>
      <View style={styles.rowHeader}>
        <Text style={[type.body, { color: C.text, flex: 1, fontWeight: "600" }]} numberOfLines={1}>
          {`${index + 1}. ${humanize(row.title)}`}
        </Text>
        <Text style={[type.body, { color: C.muted, fontWeight: "700" }]}>{formatCost(row.cost)}</Text>
      </View>
      <MeterBar usedPercent={(row.cost / maxCost) * 100} tone={C.text} />
      <View style={styles.rowStats}>
        <Text style={[type.muted, { color: C.muted }]}>
          {`${humanize(row.subtitle ?? "")} · ${formatTokens(row.outputTokens)} out · cache ${formatPercent(row.hitRate)}`}
        </Text>
      </View>
    </Card>
  );
}

function SessionItem({ session }: { session: SessionRow }) {
  const { C } = useTheme();
  return (
    <Card>
      <View style={styles.rowHeader}>
        <Text style={[type.h2, { color: C.text, flex: 1 }]} numberOfLines={1}>
          {session.title ?? session.sessionId}
        </Text>
        <Text style={[type.body, { color: C.muted, fontWeight: "700" }]}>{formatCost(session.cost)}</Text>
      </View>
      <View style={styles.rowStats}>
        <Text style={[type.muted, { color: C.muted }]} numberOfLines={1}>
          {`${humanize(session.client)} · ${session.models.map(humanize).join(", ")}`}
        </Text>
      </View>
      <View style={styles.rowStats}>
        <Text style={[type.muted, { color: C.muted }]}>
          {`${formatTokens(session.tokens)} · ${session.messages} msgs · ${formatRelative(new Date(session.lastActivityMs).toISOString())}`}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: { marginHorizontal: spacing.l, marginTop: spacing.m, marginBottom: spacing.s },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s },
  rowStats: { marginTop: 6 },
});
