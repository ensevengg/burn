import { useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { reporterIssue } from "../lib/system-health";
import { useMachinesQuery } from "../data/queries";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { confirmDestructive } from "../lib/confirm-destructive";
import { spacing, type } from "../theme";
import { Card, Chip, Empty, SectionTitle } from "../ui/primitives";

export function MachinesScreen() {
  const machines = useMachinesQuery();
  const {
    mode,
    requestSync,
    reportingTimezone,
    removeMachine,
    addDirectMachine,
    fullSync,
  } = useApp();
  const { refreshingMachines, liveMachines } = useSyncStatus();
  const { C } = useTheme();
  const [showAdd, setShowAdd] = useState(false);
  // Gesture-driven spinner for demo mode: the machines query heartbeats every
  // minute, and isFetching would blip the pull-to-refresh control.
  const [demoRefreshing, setDemoRefreshing] = useState(false);
  const liveBySlug = new Map(
    liveMachines.map((status) => [status.slug, status]),
  );

  // Removing a machine clears its local history only, after confirmation.
  const confirmRemove = (machineId: string, name: string) => {
    confirmDestructive(
      Alert,
      "Remove machine?",
      mode === "direct"
        ? `Remove "${name}" and its cached usage and quotas from this phone? You will need to add its URL again to reconnect. Machine files stay intact.`
        : `Remove "${name}" and its demo usage and quotas from this phone?`,
      () => removeMachine(machineId),
    );
  };

  // Machine count is dynamic; each installation is registered by URL.
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: C.bg }]}
      edges={["top"]}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={
              mode === "direct"
                ? refreshingMachines
                : demoRefreshing
            }
            onRefresh={() => {
              if (mode === "direct") {
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
            android_ripple={{
              color: C.border,
              foreground: true,
              borderless: false,
            }}
            style={[
              styles.addButton,
              { borderColor: C.border, backgroundColor: C.panelAlt },
            ]}
            onPress={() => setShowAdd(!showAdd)}
          >
            <Text
              style={{
                color: C.text,
                fontSize: 20,
                fontWeight: "600",
                lineHeight: 26,
              }}
            >
              +
            </Text>
          </Pressable>
        </View>
        <Text
          style={[type.muted, { color: C.muted, marginHorizontal: spacing.l }]}
        >
          {mode === "direct"
            ? "Pull down (or open the app) to refresh every machine over Tailscale. Reporting timezone: "
            : "Demo machines. Connect over Tailscale for live data. Reporting timezone: "}
          {reportingTimezone}.
        </Text>

        {showAdd && mode === "direct" && (
          <AddDirectMachineSheet onAdded={() => setShowAdd(false)} addMachine={addDirectMachine} />
        )}

        {mode !== "direct" && !showAdd && (
          <Card>
            <Text style={[type.body, { color: C.text }]}>
              {mode === "demo"
                ? "Showing demo data — connect over Tailscale for real machines."
                : "Not connected yet."}
            </Text>
          </Card>
        )}

        {machines.data !== undefined && machines.data.length === 0 ? (
          <Empty message="Add a machine URL to start tracking usage." />
        ) : (
          <>
            <SectionTitle trailing={`${machines.data?.length ?? 0} reporters`}>
              Environments
            </SectionTitle>
            {machines.data?.map((machine) => {
              const live = liveBySlug.get(machine.slug);
              const issue = reporterIssue(machine, live);
              const healthy = issue === null;
              return (
                <Card key={machine.id}>
                  <View style={styles.header}>
                    <Text
                      style={[type.h2, { color: C.text, flex: 1 }]}
                      numberOfLines={1}
                    >
                      {machine.displayName}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${machine.displayName}`}
                      android_ripple={{
                        color: C.border,
                        foreground: true,
                        borderless: false,
                      }}
                      style={[styles.removeButton, { borderColor: C.border }]}
                      onPress={() =>
                        confirmRemove(machine.id, machine.displayName)
                      }
                    >
                      <Text
                        style={{
                          color: C.err,
                          fontSize: 16,
                          lineHeight: 20,
                          fontWeight: "600",
                        }}
                      >
                        −
                      </Text>
                    </Pressable>
                    <Chip tone={healthy ? "green" : "yellow"}>
                      {healthy ? "ok" : "attention"}
                    </Chip>
                  </View>
                  <Text style={[type.muted, { color: C.muted }]}>
                    {`${machine.slug} · ${humanize(machine.osKind)}${machine.hostGroup !== null ? ` · host ${machine.hostGroup}` : ""}`}
                  </Text>
                  <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
                    {`last contact ${formatRelative(machine.lastHeartbeatAt)} · last pull ${formatRelative(machine.lastSuccessAt)}`}
                  </Text>
                  <Text style={[type.muted, { color: C.muted, marginTop: 4 }]}>
                    {`tokscale ${machine.tokscaleVersion ?? "?"} · reporter ${machine.reporterVersion ?? "?"}`}
                  </Text>
                  {live !== undefined && <LiveLine status={live} />}
                  {issue !== null && (
                    <Text
                      style={{ color: C.err, marginTop: 6 }}
                      numberOfLines={3}
                    >
                      {issue}
                    </Text>
                  )}
                  {mode === "direct" && (
                    // Refresh reads only what changed; reconcile forces a
                    // machine rescan and re-downloads every row.
                    <View style={styles.actions}>
                      {([
                        ["Refresh", () => requestSync(machine.id)],
                        ["Reconcile history", () => fullSync(machine.id)],
                      ] as const).map(([label, action]) => (
                        <Pressable
                          key={label}
                          accessibilityRole="button"
                          accessibilityLabel={`${label} ${machine.displayName}`}
                          accessibilityState={{ disabled: refreshingMachines }}
                          disabled={refreshingMachines}
                          onPress={() => void action()}
                          style={[
                            styles.requestButton,
                            styles.action,
                            {
                              backgroundColor: C.panelAlt,
                              borderColor: C.border,
                              opacity: refreshingMachines ? 0.35 : 1,
                            },
                          ]}
                        >
                          <Text style={{ color: C.text, fontWeight: "600" }}>
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
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
 * Direct pull result for one machine. Rendered only after a probe ran —
 * absence means "not probed yet", not "offline", so the card never implies a
 * machine is down before the user asked.
 */
function LiveLine({
  status,
}: {
  status: import("../lib/direct").DirectPullStatus;
}) {
  const { C } = useTheme();
  if (status.state === "live") {
    const tail =
      status.pulledEvents > 0
        ? `live · +${status.pulledEvents} changed event${status.pulledEvents === 1 ? "" : "s"}`
        : "live · no event changes";
    const quota =
      "pulledQuotas" in status
        ? ` · ${status.pulledQuotas} quota${status.pulledQuotas === 1 ? "" : "s"}`
        : "";
    const timing = ` · ${(status.elapsedMs / 1000).toFixed(1)}s`;
    const scan =
      "scanMs" in status && status.scanMs != null
        ? ` · scan ${(status.scanMs / 1000).toFixed(1)}s`
        : "";
    return (
      <>
        <Text style={{ color: C.ok ?? C.muted, marginTop: 4 }}>
          {tail}
          {quota}
          {timing}
          {scan}
          {status.hasMore ? " · loading history" : ""}
        </Text>
        {"quotaError" in status && status.quotaError ? (
          <Text style={{ color: C.err, marginTop: 4 }} numberOfLines={2}>
            Quota refresh: {status.quotaError}
          </Text>
        ) : null}
      </>
    );
  }
  if (status.state === "offline") {
    return (
      <Text style={[type.muted, { color: C.muted, marginTop: 4 }]}>
        live probe: unreachable — showing cached data
      </Text>
    );
  }
  if (status.state === "skipped") {
    return (
      <Text
        style={{ color: C.err, marginTop: 4 }}
      >{`live probe skipped: ${status.error ?? "identity mismatch"}`}</Text>
    );
  }
  return (
    <Text
      style={{ color: C.err, marginTop: 4 }}
      numberOfLines={2}
    >{`live probe failed: ${status.error ?? "unknown"}`}</Text>
  );
}

/**
 * Direct mode (ADR 0002): adding a machine = its tailnet endpoint. The ping
 * validates it and the slug dedupes it; the machine card appears immediately.
 */
function AddDirectMachineSheet({
  onAdded,
  addMachine,
}: {
  onAdded: () => void;
  addMachine: (url: string) => Promise<{ slug: string; displayName: string }>;
}) {
  const { C } = useTheme();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^https?:\/\//.test(url.trim());

  const submit = () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    void addMachine(url.trim())
      .then(() => onAdded())
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <Text style={[type.h2, { color: C.text }]}>Add a machine</Text>
      <Text style={[type.muted, { color: C.muted, marginVertical: 6 }]}>
        Run this on the machine, then keep the daemon running. Connect both
        devices to your tailnet and paste the printed URL below.
      </Text>
      <Text selectable style={[styles.command, { color: C.text, backgroundColor: C.panelAlt }]}>
        {'npx burn-report init --slug <machine-slug> --name "<Display Name>"\nnpx burn-report daemon'}
      </Text>
      <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
        Give each Windows, WSL or dual-boot installation a distinct slug; use
        the same --host-group for installations on one physical machine.
      </Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="http://machine-name:8787"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[
          styles.command,
          { backgroundColor: C.panelAlt, borderColor: C.border, color: C.text },
        ]}
      />
      {error !== null && (
        <Text style={{ color: C.err, marginTop: 6 }}>{error}</Text>
      )}
      <Pressable
        accessibilityRole="button"
        android_ripple={{
          color: C.border,
          foreground: true,
          borderless: false,
        }}
        style={[
          styles.requestButton,
          {
            backgroundColor: C.panelAlt,
            borderColor: C.border,
            opacity: valid && !busy ? 1 : 0.35,
          },
        ]}
        disabled={!valid || busy}
        onPress={submit}
      >
        <Text style={{ color: C.text, fontWeight: "600" }}>
          {busy ? "Checking…" : "Add machine"}
        </Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: spacing.l,
    marginTop: spacing.m,
  },
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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.s,
  },
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
  actions: { flexDirection: "row", gap: spacing.s },
  action: { flex: 1 },
});
