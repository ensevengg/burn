import { useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMachinesQuery } from "../data/queries";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { loadConnection } from "../lib/settings";
import { spacing, type } from "../theme";
import { Card, Chip, Empty, SectionTitle } from "../ui/primitives";

export function MachinesScreen() {
  const machines = useMachinesQuery();
  const { mode, requestSync, reportingTimezone, removeMachine } = useApp();
  const { refreshingMachines, liveMachines } = useSyncStatus();
  const { C } = useTheme();
  const [showAdd, setShowAdd] = useState(false);
  // Gesture-driven spinner for demo mode: the machines query heartbeats every
  // minute, and isFetching would blip the pull-to-refresh control.
  const [demoRefreshing, setDemoRefreshing] = useState(false);
  const liveBySlug = new Map(liveMachines.map((status) => [status.slug, status]));

  // Removal is destructive (server-side cascade of the machine's events +
  // quotas), so it always confirms first (user direction).
  const confirmRemove = (machineId: string, name: string) => {
    Alert.alert(
      "Remove machine",
      `Stop managing "${name}"? Its usage history and quota snapshots are deleted from your backend. A machine that still exists must re-run \`npx burn-report init\` to re-pair.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void removeMachine(machineId).catch((err: Error) =>
              Alert.alert("Remove failed", err.message),
            );
          },
        },
      ],
    );
  };

  // Machine count is dynamic (updated matrix): reporters self-register on
  // their first push; "+" shows the exact command to run on the new machine.
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={mode === "cloud" ? refreshingMachines : demoRefreshing}
            onRefresh={() => {
              if (mode === "cloud") {
                void requestSync(null);
                return;
              }
              setDemoRefreshing(true);
              void machines.refetch().finally(() => setDemoRefreshing(false));
            }}
            tintColor={C.muted}
          />
        }
      >
        <View style={styles.headerRow}>
          <Text style={[type.title, { color: C.text, flex: 1 }]}>Machines</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add a machine"
            android_ripple={{ color: C.border, foreground: true, borderless: false }}
            style={[styles.addButton, { borderColor: C.border, backgroundColor: C.panelAlt }]}
            onPress={() => setShowAdd(!showAdd)}
          >
            <Text style={{ color: C.text, fontSize: 20, fontWeight: "600", lineHeight: 26 }}>+</Text>
          </Pressable>
        </View>
        <Text style={[type.muted, { color: C.muted, marginHorizontal: spacing.l }]}>
          Reporters push on a schedule; a resident daemon answers refresh requests within ~30s. Pull down to request a
          sync from every machine. Reporting timezone: {reportingTimezone}.
        </Text>

        {showAdd && <AddMachineSheet />}

        {mode !== "cloud" && !showAdd && (
          <Card>
            <Text style={[type.body, { color: C.text }]}>
              {mode === "demo" ? "Showing demo data — connect a backend for real machines." : "Not connected yet."}
            </Text>
          </Card>
        )}

        {machines.data !== undefined && machines.data.length === 0 ? (
          <Empty message="No machines have reported yet." />
        ) : (
          <>
            <SectionTitle trailing={`${machines.data?.length ?? 0} reporters`}>Environments</SectionTitle>
            {machines.data?.map((machine) => {
              const healthy = machine.lastError === null && machine.lastHeartbeatAt !== null;
              const live = liveBySlug.get(machine.slug);
              return (
                <Card key={machine.id}>
                  <View style={styles.header}>
                    <Text style={[type.h2, { color: C.text, flex: 1 }]} numberOfLines={1}>{machine.displayName}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${machine.displayName}`}
                      android_ripple={{ color: C.border, foreground: true, borderless: false }}
                      style={[styles.removeButton, { borderColor: C.border }]}
                      onPress={() => confirmRemove(machine.id, machine.displayName)}
                    >
                      <Text style={{ color: C.err, fontSize: 16, lineHeight: 20, fontWeight: "600" }}>−</Text>
                    </Pressable>
                    <Chip tone={healthy ? "green" : "yellow"}>{healthy ? "ok" : "attention"}</Chip>
                  </View>
                  <Text style={[type.muted, { color: C.muted }]}>
                    {`${machine.slug} · ${humanize(machine.osKind)}${machine.hostGroup !== null ? ` · host ${machine.hostGroup}` : ""}`}
                  </Text>
                  <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
                    {`heartbeat ${formatRelative(machine.lastHeartbeatAt)} · last push ${formatRelative(machine.lastSuccessAt)} · revision ${machine.latestRevision}`}
                  </Text>
                  <Text style={[type.muted, { color: C.muted, marginTop: 4 }]}>
                    {`tokscale ${machine.tokscaleVersion ?? "?"} · reporter ${machine.reporterVersion ?? "?"}`}
                  </Text>
                  {live !== undefined && <LiveLine status={live} />}
                  {machine.lastError !== null && (
                    <Text style={{ color: C.err, marginTop: 6 }} numberOfLines={3}>
                      {machine.lastError}
                    </Text>
                  )}
                  {mode === "cloud" && (
                    <Pressable
                      accessibilityRole="button"
                      android_ripple={{ color: C.border, foreground: true, borderless: false }}
                      style={[styles.requestButton, { backgroundColor: C.panelAlt, borderColor: C.border }]}
                      onPress={() => void requestSync(machine.id)}
                    >
                      <Text style={{ color: C.text, fontWeight: "600" }}>Request sync now</Text>
                    </Pressable>
                  )}
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * "+" sheet: machines can't be minted phone-side (their ingest token lives on
 * the machine, D7) — so adding a machine = running the prefilled init command
 * there. The machine appears in this list after its first push.
 */
function AddMachineSheet() {
  const { C } = useTheme();
  const [connection, setConnection] = useState<{ url: string; publishableKey: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const config = await loadConnection();
      if (config !== null) {
        setConnection({ url: config.url, publishableKey: config.publishableKey });
      }
      setLoaded(true);
    })();
  }, []);

  const command =
    connection !== null
      ? `npx burn-report init \\\n  --url ${connection.url} \\\n  --key ${connection.publishableKey} \\\n  --slug <machine-slug> \\\n  --name "<Display Name>"`
      : "npx burn-report init --url <project-url> --key <publishable-key> --slug <machine-slug> --name \"<Display Name>\"";

  return (
    <Card>
      <Text style={[type.h2, { color: C.text }]}>Add a machine</Text>
      <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
        1. On the new machine (Node required), run:
      </Text>
      <Text style={[styles.command, { backgroundColor: C.panelAlt, borderColor: C.border, color: C.text }]} selectable>
        {command}
      </Text>
      <Text style={[type.muted, { color: C.muted, marginTop: 8 }]}>
        2. Paste the generated <Text style={{ color: C.text }}>setup-tokens.sql</Text> into your Supabase SQL editor.
      </Text>
      <Text style={[type.muted, { color: C.muted, marginTop: 4 }]}>
        3. Run `npx burn-report doctor` there. The machine appears in this list after its first push — this screen
        refreshes on pull.
      </Text>
      <Text style={[type.muted, { color: C.faint, marginTop: 8 }]}>
        Dual-boot or WSL on the same box? Give each side its own --slug and the same --host-group so they group here.
      </Text>
      {loaded && connection === null && (
        <Text style={[type.muted, { color: C.err, marginTop: 8 }]}>
          Connect a backend first (Settings → Mode) to get your command prefilled.
        </Text>
      )}
    </Card>
  );
}

/**
 * Live-pull result for one machine (D1 v2). Rendered only after a probe ran —
 * absence means "not probed yet", not "offline", so the card never implies a
 * machine is down before the user asked.
 */
function LiveLine({ status }: { status: import("../lib/live").LivePullStatus }) {
  const { C } = useTheme();
  if (status.state === "live") {
    const tail =
      status.pulledEvents > 0
        ? `live · +${status.pulledEvents} event${status.pulledEvents === 1 ? "" : "s"} not yet pushed`
        : "live · up to date with its push cursor";
    return <Text style={{ color: C.ok ?? C.muted, marginTop: 4 }}>{tail}</Text>;
  }
  if (status.state === "offline") {
    return <Text style={[type.muted, { color: C.muted, marginTop: 4 }]}>live probe: unreachable — showing pushed data</Text>;
  }
  if (status.state === "skipped") {
    return <Text style={{ color: C.err, marginTop: 4 }}>{`live probe skipped: ${status.error ?? "identity mismatch"}`}</Text>;
  }
  return <Text style={{ color: C.err, marginTop: 4 }} numberOfLines={2}>{`live probe failed: ${status.error ?? "unknown"}`}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", marginHorizontal: spacing.l, marginTop: spacing.m },
  addButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  command: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 6,
    fontSize: 11.5,
    fontFamily: "monospace",
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.s },
  removeButton: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  requestButton: {
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: spacing.m,
  },
});
