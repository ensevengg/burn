/**
 * Keep-awake panel for a Systems card (ADR 0007): hold off the machine's
 * sleep for a fixed time so a long agent run is not cut short, from anywhere
 * on the tailnet. Every hold ends by itself; "Off" ends it early.
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { HOLD_CHOICES, holdChoiceLabel, holdLeft } from "../lib/keep-awake-meta";
import { useKeepAwake, useSetKeepAwake } from "../lib/keep-awake";
import type { ControlledMachine } from "../lib/power-mode";
import { controlFailure } from "../lib/power-mode-meta";
import { useTheme } from "../lib/theme-context";
import { useNow } from "../lib/use-now";
import { hairline, radius, spacing, type } from "../theme";
import { PressableScale, Pulse, Skeleton, useTweenedColor } from "./motion";

function AwakeGlyph({ awake, color }: { awake: boolean; color: string }) {
  const stroke = { stroke: color, strokeWidth: 1.8, strokeLinecap: "round" as const, fill: "none" };
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      {awake ? (
        <>
          <Circle cx={12} cy={12} r={4} {...stroke} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <Path key={angle} d="M12 3.5v2" {...stroke} transform={`rotate(${angle} 12 12)`} />
          ))}
        </>
      ) : (
        <Path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" {...stroke} />
      )}
    </Svg>
  );
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function KeepAwakePanel({
  machine,
  online: reachable,
  machineName,
}: {
  machine: ControlledMachine;
  online: boolean | null;
  machineName: string;
}) {
  const { C } = useTheme();
  const now = useNow(15_000);
  const state = useKeepAwake(machine, reachable !== false);
  const write = useSetKeepAwake(machine);
  const online = reachable ?? (state.isSuccess && !state.isError);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (failure === null) return;
    const timer = setTimeout(() => setFailure(null), 7_000);
    return () => clearTimeout(timer);
  }, [failure]);

  const untilMs = state.data?.until ? Date.parse(state.data.until) : null;
  const left = holdLeft(untilMs, now);
  const awake = left !== null;
  const ink = useTweenedColor(awake ? C.ok : C.muted);

  const apply = (minutes: number) => {
    setFailure(null);
    write.mutate(minutes, { onError: (err) => setFailure(controlFailure(err, machineName, "change it")) });
  };

  if (state.data === undefined) {
    return (
      <View style={[styles.panel, { borderTopColor: C.border }]}>
        <Text style={[type.eyebrow, { color: C.muted }]}>Keep awake</Text>
        {state.isError || reachable === false ? (
          <Text style={[type.muted, { color: C.warn, marginTop: spacing.s }]} numberOfLines={2}>
            {state.isError ? controlFailure(state.error, machineName) : `${machineName} is offline.`}
          </Text>
        ) : (
          <Skeleton style={[styles.skeleton, { backgroundColor: C.panelAlt }]} />
        )}
      </View>
    );
  }

  const pending = write.isPending ? (write.variables ?? null) : null;
  const disabled = !online || pending !== null;
  return (
    <View style={[styles.panel, { borderTopColor: C.border }]}>
      <Text style={[type.eyebrow, { color: C.muted }]}>Keep awake</Text>
      <View style={styles.hero}>
        <View style={[styles.badge, { backgroundColor: C.panelAlt, borderColor: awake ? ink : C.border }]}>
          <AwakeGlyph awake={awake} color={ink} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.title, { color: C.text }]} numberOfLines={1}>
            {awake ? `Awake · ${left} left` : "Sleeps normally"}
          </Text>
          <Text accessibilityLiveRegion="polite" style={[type.muted, { color: C.muted, marginTop: 2, lineHeight: 17 }]} numberOfLines={2}>
            {!online
              ? "Machine offline · showing the last reading"
              : awake
                ? `Won't sleep until ${clockTime(untilMs!)}. Tap a duration to restart the timer.`
                : "Hold off sleep while an agent runs. The display can still turn off."}
          </Text>
        </View>
      </View>
      <View style={styles.choices} accessibilityRole="toolbar">
        {HOLD_CHOICES.map((minutes) => (
          <PressableScale
            key={minutes}
            accessibilityRole="button"
            accessibilityLabel={`Keep ${machineName} awake for ${holdChoiceLabel(minutes)}`}
            accessibilityState={{ disabled, busy: pending === minutes }}
            disabled={disabled}
            onPress={() => apply(minutes)}
            containerStyle={{ flex: 1 }}
            style={[styles.choice, { backgroundColor: C.panelAlt, borderColor: C.border, opacity: disabled && pending !== minutes ? 0.45 : 1 }]}
          >
            <Pulse active={pending === minutes}>
              <Text style={[styles.choiceLabel, { color: C.text }]}>{holdChoiceLabel(minutes)}</Text>
            </Pulse>
          </PressableScale>
        ))}
        {awake && (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Let ${machineName} sleep normally`}
            accessibilityState={{ disabled, busy: pending === 0 }}
            disabled={disabled}
            onPress={() => apply(0)}
            containerStyle={{ flex: 1 }}
            style={[styles.choice, { backgroundColor: C.accent, borderColor: C.accent, opacity: disabled && pending !== 0 ? 0.45 : 1 }]}
          >
            <Pulse active={pending === 0}>
              <Text style={[styles.choiceLabel, { color: C.accentInk }]}>Off</Text>
            </Pulse>
          </PressableScale>
        )}
      </View>
      {failure !== null && (
        <Text accessibilityLiveRegion="assertive" style={[type.muted, { color: C.err, marginTop: spacing.s, lineHeight: 17 }]}>
          {failure}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: spacing.m, paddingTop: spacing.m, borderTopWidth: hairline },
  hero: { flexDirection: "row", alignItems: "center", gap: spacing.m, marginTop: spacing.s, marginBottom: spacing.m },
  badge: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 16, fontWeight: "700", letterSpacing: -0.3, fontVariant: ["tabular-nums"] },
  choices: { flexDirection: "row", gap: spacing.s },
  choice: { height: 38, borderRadius: radius.m - 4, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  choiceLabel: { fontSize: 13.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  skeleton: { height: 92, borderRadius: radius.m, marginTop: spacing.s },
});
