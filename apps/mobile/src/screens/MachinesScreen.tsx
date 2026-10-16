import { useState } from "react";
import { Alert, LayoutAnimation, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { reporterIssue } from "../lib/system-health";
import { useMachinesQuery } from "../data/queries";
import type { EnvironmentRow } from "../data/repository";
import { formatRelative } from "../lib/format";
import { humanize } from "../lib/labels";
import { useApp, useSyncStatus } from "../lib/app-context";
import type { DirectPullStatus } from "../lib/direct";
import { useTheme } from "../lib/theme-context";
import { confirmDestructive } from "../lib/confirm-destructive";
import { gutter, hairline, radius, spacing, type } from "../theme";
import { Button, Card, Empty, SectionTitle } from "../ui/primitives";
import { FadeIn, PressableScale } from "../ui/motion";
import { Screen, SyncPill } from "../ui/screen";
import { Sheet } from "../ui/sheet";

export function MachinesScreen() {
  const machines = useMachinesQuery();
  const { mode, reportingTimezone, addDirectMachine } = useApp();
  const { C } = useTheme();
  const [showAdd, setShowAdd] = useState(false);

  const trailing = (
    <View style={styles.trailing}>
      <SyncPill />
      {mode === "direct" && (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Add a machine"
          hitSlop={6}
          onPress={() => setShowAdd(true)}
          style={[styles.addButton, { backgroundColor: C.accent }]}
        >
          <Svg width={14} height={14} viewBox="0 0 14 14">
            <Path d="M7 1.5v11M1.5 7h11" stroke={C.accentInk} strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </PressableScale>
      )}
    </View>
  );

  // Machine count is dynamic; each installation is registered by URL.
  return (
    <Screen title="Machines" trailing={trailing}>
      <Text style={[type.muted, styles.subtitle, { color: C.muted }]}>
        {mode === "direct"
          ? `Read directly over Tailscale. Pull down to refresh every machine. Days bucket in ${reportingTimezone}.`
          : "Demo machines. Connect over Tailscale for live data."}
      </Text>

      {machines.data !== undefined && machines.data.length === 0 ? (
        <Empty message="Add a machine URL to start tracking usage." />
      ) : (
        <>
          <SectionTitle trailing={`${machines.data?.length ?? 0} reporters`}>Environments</SectionTitle>
          {machines.data?.map((machine, index) => (
            <FadeIn key={machine.id} delay={index * 50}>
              <MachineCard machine={machine} />
            </FadeIn>
          ))}
        </>
      )}

      {mode === "direct" && (
        <Sheet visible={showAdd} onClose={() => setShowAdd(false)}>
          <AddMachine onAdded={() => setShowAdd(false)} addMachine={addDirectMachine} />
        </Sheet>
      )}
    </Screen>
  );
}

/** Friendly one-line state; the raw error lives behind "Details". */
function describe(
  machine: EnvironmentRow,
  live: DirectPullStatus | undefined,
  demo: boolean,
): { text: string; tone: "ok" | "muted" | "warn" } {
  if (demo) return { text: `Demo machine · last report ${formatRelative(machine.lastHeartbeatAt)}`, tone: "muted" };
  if (live === undefined) return { text: `Not checked yet · last contact ${formatRelative(machine.lastHeartbeatAt)}`, tone: "muted" };
  if (live.state === "offline") return { text: `Unreachable · showing cached history · seen ${formatRelative(machine.lastHeartbeatAt)}`, tone: "muted" };
  if (live.state === "skipped") return { text: "Endpoint answered as a different machine", tone: "warn" };
  if (live.state === "error") return { text: "Pull failed · showing cached history", tone: "warn" };
  if (live.quotaError) return { text: "Live · quota refresh failed", tone: "warn" };
  if (live.metricsError) return { text: "Live · health refresh failed", tone: "warn" };
  const events = live.pulledEvents > 0 ? `+${live.pulledEvents.toLocaleString("en")} events` : "no new events";
  const extra = live.hasMore ? " · loading history" : "";
  return { text: `Live · ${events} · ${live.pulledQuotas} quotas · ${(live.elapsedMs / 1000).toFixed(1)}s${extra}`, tone: "ok" };
}

function MachineCard({ machine }: { machine: EnvironmentRow }) {
  const { C } = useTheme();
  const { mode, requestSync, removeMachine, fullSync } = useApp();
  const { refreshingMachines, liveMachines, pass } = useSyncStatus();
  const [details, setDetails] = useState(false);
  const live = liveMachines.find((status) => status.slug === machine.slug);
  const issue = reporterIssue(machine, live);
  const summary = describe(machine, live, mode === "demo");
  const pending = pass !== null && pass.ids.includes(machine.id) && pass.settled[machine.id] === undefined;
  const dot = pending ? C.text : summary.tone === "ok" ? C.ok : summary.tone === "warn" ? C.warn : C.faint;
  const toneColor = summary.tone === "ok" ? C.ok : summary.tone === "warn" ? C.warn : C.muted;

  // Removing a machine clears its local history only, after confirmation.
  const confirmRemove = () =>
    confirmDestructive(
      Alert,
      "Remove machine?",
      mode === "direct"
        ? `Remove "${machine.displayName}" and its cached usage and quotas from this phone? You will need to add its URL again to reconnect. Machine files stay intact.`
        : `Remove "${machine.displayName}" and its demo usage and quotas from this phone?`,
      () => removeMachine(machine.id),
    );

  return (
    <Card>
      <View style={styles.cardTop}>
        <View style={[styles.statusDot, { backgroundColor: dot }]} />
        <Text style={[type.h2, { color: C.text, flex: 1, fontSize: 17 }]} numberOfLines={1}>
          {machine.displayName}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${machine.displayName}`}
          hitSlop={8}
          onPress={confirmRemove}
          style={[styles.removeButton, { borderColor: C.border }]}
        >
          <Svg width={12} height={12} viewBox="0 0 12 12">
            <Path d="M2 6h8" stroke={C.err} strokeWidth={1.8} strokeLinecap="round" />
          </Svg>
        </Pressable>
      </View>
      <Text style={[type.muted, styles.meta, { color: C.muted }]} numberOfLines={1}>
        {[humanize(machine.osKind), machine.slug, machine.hostGroup === null ? null : `host ${machine.hostGroup}`]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <Text style={[type.muted, styles.meta, { color: C.faint }]} numberOfLines={1}>
        {[
          machine.reporterVersion === null ? null : `reporter ${machine.reporterVersion}`,
          machine.tokscaleVersion === null ? null : `tokscale ${machine.tokscaleVersion}`,
          `pulled ${formatRelative(machine.lastSuccessAt)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View style={[styles.statusLine, { backgroundColor: C.panelAlt }]}>
        <Text style={[type.muted, { color: pending ? C.text : toneColor, flex: 1 }]} numberOfLines={2}>
          {pending ? "Syncing…" : summary.text}
        </Text>
        {issue !== null && (
          <Pressable
            hitSlop={8}
            accessibilityRole="button"
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setDetails(!details);
            }}
          >
            <Text style={[type.muted, { color: C.text, fontWeight: "600" }]}>{details ? "Hide" : "Details"}</Text>
          </Pressable>
        )}
      </View>
      {details && issue !== null && (
        <Text selectable style={[styles.issue, { color: C.muted, borderColor: C.border }]}>
          {issue}
        </Text>
      )}
      {mode === "direct" && (
        // Refresh reads only what changed; reconcile forces a machine rescan
        // and re-downloads every row.
        <View style={styles.actions}>
          <Button
            label="Refresh"
            disabled={refreshingMachines}
            onPress={() => void requestSync(machine.id)}
            grow
            style={styles.action}
          />
          <Button
            label="Reconcile history"
            disabled={refreshingMachines}
            onPress={() => void fullSync(machine.id)}
            grow
            style={styles.action}
          />
        </View>
      )}
    </Card>
  );
}

/**
 * Adding a machine = its tailnet endpoint. The ping validates it and the slug
 * dedupes it; the machine card appears immediately.
 */
function AddMachine({
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
    <View>
      <Text style={[type.title, { color: C.text, fontSize: 24 }]}>Add a machine</Text>
      <Text style={[type.muted, { color: C.muted, marginTop: 6, lineHeight: 18 }]}>
        Run this on the machine and keep the daemon running. With both devices on your tailnet, paste the URL it
        prints.
      </Text>
      <Text selectable style={[styles.command, { color: C.text, backgroundColor: C.panelAlt, borderColor: C.border }]}>
        {'npx burn-report init --slug <machine-slug> --name "<Display Name>"\nnpx burn-report daemon'}
      </Text>
      <Text style={[type.muted, { color: C.faint, marginTop: 8, lineHeight: 17 }]}>
        Give each Windows, WSL or dual-boot installation its own slug; share --host-group across one physical machine.
      </Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="http://machine-name:8787"
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={submit}
        style={[styles.input, { backgroundColor: C.panelAlt, borderColor: valid ? C.muted : C.border, color: C.text }]}
      />
      {error !== null && <Text style={{ color: C.err, marginTop: 8 }}>{error}</Text>}
      <Button
        label={busy ? "Checking…" : "Add machine"}
        variant="solid"
        disabled={!valid || busy}
        onPress={submit}
        style={{ marginTop: spacing.m }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  subtitle: { marginHorizontal: gutter, lineHeight: 18 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  addButton: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  meta: { marginTop: 3, marginLeft: 19 },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s,
    marginTop: spacing.m,
    borderRadius: radius.s,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  issue: {
    marginTop: spacing.s,
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: "monospace",
    borderLeftWidth: 2,
    paddingLeft: 10,
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: { flexDirection: "row", gap: spacing.s, marginTop: spacing.m },
  action: { paddingVertical: 9 },
  command: {
    borderWidth: hairline,
    borderRadius: radius.s,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: spacing.m,
    fontSize: 11.5,
    lineHeight: 17,
    fontFamily: "monospace",
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.s,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: spacing.m,
    fontSize: 14,
  },
});
