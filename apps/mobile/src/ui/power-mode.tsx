/**
 * Power mode panel for a Systems card (ADR 0004): live fan rotors whose spin
 * tracks the machine's tachometers, and a mode selector whose thumb moves the
 * moment it is tapped, then confirms or springs back with the machine's answer.
 */
import type { MachineFan } from "@burn/sync-api";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { humanize } from "../lib/labels";
import { usePowerMode, useSetPowerMode, type ControlledMachine } from "../lib/power-mode";
import {
  controlFailure,
  fanFraction,
  formatRpm,
  modeMeta,
  modeTint,
  orderModes,
  rotorPeriodMs,
  type ModeGlyph,
} from "../lib/power-mode-meta";
import { useTheme } from "../lib/theme-context";
import { hairline, motion, radius, spacing, type } from "../theme";
import { easeOut, Pulse, Skeleton, useTweenedColor } from "./motion";
import { Ring } from "./primitives";

function Glyph({ glyph, color, size = 18 }: { glyph: ModeGlyph; color: string; size?: number }) {
  const stroke = { stroke: color, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {glyph === "leaf" && (
        <>
          <Path d="M5 19C5 10.5 10.5 5 19 5c0 8.5-5.5 14-14 14Z" {...stroke} />
          <Path d="M5 19l7.5-7.5" {...stroke} />
        </>
      )}
      {glyph === "balance" && (
        <>
          <Circle cx={12} cy={12} r={7.5} {...stroke} />
          <Path d="M12 4.5a7.5 7.5 0 0 1 0 15Z" fill={color} />
        </>
      )}
      {glyph === "bolt" && <Path d="M13.5 3 6 13.5h5.5L10.5 21 18 10.5h-5.5Z" {...stroke} />}
      {glyph === "flame" && (
        <Path
          d="M12 3c.5 3.5 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2.2 1.2-3.6 2.4-4.6.2 1.7 1 2.8 2.1 3.1C11 9 10.8 6 12 3Z"
          {...stroke}
        />
      )}
      {glyph === "dot" && <Circle cx={12} cy={12} r={3.5} fill={color} />}
    </Svg>
  );
}

/** One swept blade from hub to tip; five copies rotate around the hub. */
const BLADE = "M-3 -11 C -12 -22, -10 -38, 4 -45 C 14 -48, 22 -42, 20 -36 C 10 -34, 4 -24, 7 -10 Z";

/** Turns continuously at `periodMs` per revolution; null coasts to a stop. */
function useSpin(periodMs: number | null) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let active = true;
    turn.stopAnimation((from) => {
      if (!active) return;
      if (periodMs === null) {
        Animated.timing(turn, { toValue: from + 0.3, duration: 1_100, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
        return;
      }
      const lap = (start: number) =>
        Animated.timing(turn, { toValue: start + 1, duration: periodMs, easing: Easing.linear, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished && active) lap(start + 1);
          },
        );
      lap(from);
    });
    return () => {
      active = false;
      turn.stopAnimation();
    };
  }, [periodMs, turn]);
  return Animated.modulo(turn, 1).interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
}

/** `tint` follows the selected mode (blue quiet, neutral balanced, red
 * performance) and fades on change. A stopped fan stays faint; a `stale`
 * reading (machine unreachable) coasts to a stop and greys out, so a
 * spinning rotor always means live data. */
function FanRotor({ fan, tint, stale, size = 48 }: { fan: MachineFan; tint: string; stale: boolean; size?: number }) {
  const { C } = useTheme();
  const ink = useTweenedColor(fan.rpm > 0 && !stale ? tint : C.faint);
  const rotate = useSpin(stale ? null : rotorPeriodMs(fan.rpm, fan.maxRpm));
  const fraction = fanFraction(fan.rpm, fan.maxRpm);
  const loud = fraction >= 0.85;
  const inner = size - 12;
  return (
    <View style={styles.fan} accessible accessibilityLabel={`${fan.label}: ${formatRpm(fan.rpm)}`}>
      <Ring fraction={fraction} size={size} stroke={3} color={ink}>
        <Animated.View style={{ width: inner, height: inner, transform: [{ rotate }] }}>
          <Svg width={inner} height={inner} viewBox="-50 -50 100 100">
            <G>
              {[0, 72, 144, 216, 288].map((angle) => (
                <Path key={angle} d={BLADE} fill={ink} opacity={0.92} transform={`rotate(${angle})`} />
              ))}
              <Circle r={12} fill={C.panelAlt} stroke={ink} strokeWidth={3} />
            </G>
          </Svg>
        </Animated.View>
      </Ring>
      <Text style={[styles.fanRpm, { color: stale ? C.faint : loud ? C.warn : C.muted }]}>{fan.rpm > 0 ? formatRpm(fan.rpm) : "stopped"}</Text>
    </View>
  );
}

function ModeSelector({
  modes,
  value,
  disabled,
  pending,
  onSelect,
  shake,
}: {
  modes: string[];
  value: string | null;
  disabled: boolean;
  pending: string | null;
  onSelect: (mode: string) => void;
  shake: Animated.Value;
}) {
  const { C, resolved } = useTheme();
  const [width, setWidth] = useState(0);
  const index = value === null ? -1 : modes.indexOf(value);
  const position = useRef(new Animated.Value(Math.max(0, index))).current;
  const visible = useRef(new Animated.Value(index === -1 ? 0 : 1)).current;
  useEffect(() => {
    if (index !== -1) Animated.spring(position, { toValue: index, useNativeDriver: true, ...motion.gentle }).start();
    Animated.timing(visible, { toValue: index === -1 ? 0 : 1, duration: motion.fast, useNativeDriver: true }).start();
  }, [index, position, visible]);
  const inset = 4;
  const segment = width === 0 ? 0 : (width - inset * 2) / modes.length;
  // Up to three modes fit icon-beside-label; more stack, so labels never truncate.
  const stacked = modes.length > 3;
  const height = stacked ? 54 : 44;
  return (
    <Animated.View
      accessibilityRole="radiogroup"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.track,
        {
          height,
          padding: inset,
          backgroundColor: resolved === "light" ? C.panelAlt : C.bg,
          borderColor: C.border,
          opacity: disabled && pending === null ? 0.45 : 1,
          transform: [{ translateX: shake }],
        },
      ]}
    >
      {segment > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            {
              top: inset,
              left: inset,
              width: segment,
              height: height - inset * 2,
              backgroundColor: C.accent,
              opacity: visible,
              transform: [
                {
                  translateX: position.interpolate({
                    inputRange: [0, Math.max(1, modes.length - 1)],
                    outputRange: [0, segment * Math.max(1, modes.length - 1)],
                  }),
                },
              ],
            },
          ]}
        />
      )}
      {modes.map((mode) => {
        const meta = modeMeta(mode);
        const active = mode === value;
        const ink = active ? C.accentInk : C.muted;
        const label = (
          <>
            <Glyph glyph={meta.glyph} color={ink} size={14} />
            <Text numberOfLines={1} style={[styles.segmentLabel, { color: ink, fontSize: modes.length > 3 ? 11 : 12.5 }]}>
              {meta.label}
            </Text>
          </>
        );
        return (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityLabel={`${meta.label} power mode`}
            accessibilityHint={meta.description}
            accessibilityState={{ checked: active, disabled, busy: pending === mode }}
            disabled={disabled}
            unstable_pressDelay={40}
            onPress={() => {
              if (!active) onSelect(mode);
            }}
            style={styles.segment}
          >
            <Pulse active={pending === mode} style={styles.segmentFill}>
              <View style={[styles.segmentInner, stacked && styles.segmentStacked]}>{label}</View>
            </Pulse>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

type Notice = { tone: "ok" | "err" | "muted" | "warn"; text: string } | null;

function notice(
  readFailing: boolean,
  write: { pending: string | null; error: string | null; confirmed: string | null },
  online: boolean,
  machineName: string,
): Notice {
  if (write.pending !== null) return { tone: "muted", text: `Switching to ${modeMeta(write.pending).label}…` };
  if (write.error !== null) return { tone: "err", text: write.error };
  if (write.confirmed !== null) return { tone: "ok", text: `${modeMeta(write.confirmed).label} confirmed by ${machineName}` };
  if (!online) return { tone: "warn", text: "Machine offline · showing the last reading" };
  if (readFailing) return { tone: "warn", text: "Lost contact · retrying" };
  return null;
}

/** Shown inside a Systems card when the machine advertises power-mode.
 * `reachable` is null until this launch's first probe answers: the panel
 * then tries a read rather than claiming the machine is offline. */
export function PowerModePanel({
  machine,
  online: reachable,
  machineName,
}: {
  machine: ControlledMachine;
  online: boolean | null;
  machineName: string;
}) {
  const { C } = useTheme();
  const state = usePowerMode(machine, reachable !== false);
  const online = reachable ?? (state.isSuccess && !state.isError);
  const write = useSetPowerMode(machine);
  const shake = useRef(new Animated.Value(0)).current;
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (confirmed === null && failure === null) return;
    const timer = setTimeout(() => {
      setConfirmed(null);
      setFailure(null);
    }, failure === null ? 2_800 : 7_000);
    return () => clearTimeout(timer);
  }, [confirmed, failure]);

  const select = (mode: string) => {
    setConfirmed(null);
    setFailure(null);
    write.mutate(mode, {
      onSuccess: (result) => setConfirmed(result.mode),
      onError: (err) => {
        setFailure(controlFailure(err, machineName));
        Animated.sequence(
          [10, -8, 6, -3, 0].map((toValue) => Animated.timing(shake, { toValue, duration: 55, easing: easeOut, useNativeDriver: true })),
        ).start();
      },
    });
  };

  const data = state.data;
  if (data === undefined) {
    return (
      <View style={[styles.panel, { borderTopColor: C.border }]}>
        <Text style={[type.eyebrow, { color: C.muted }]}>Power mode</Text>
        {state.isError || reachable === false ? (
          <Text style={[type.muted, { color: C.warn, marginTop: spacing.s }]} numberOfLines={2}>
            {state.isError
              ? controlFailure(state.error, machineName)
              : `${machineName} is offline. Its power mode appears when it answers again.`}
          </Text>
        ) : (
          <Skeleton style={[styles.skeleton, { backgroundColor: C.panelAlt }]} />
        )}
      </View>
    );
  }

  const pending = write.isPending ? (write.variables ?? null) : null;
  const modes = orderModes(data.modes);
  const meta = data.mode === null ? null : modeMeta(data.mode);
  const message = notice(
    state.isError,
    { pending, error: failure, confirmed },
    online,
    machineName,
  );
  const toneColor = { ok: C.ok, err: C.err, muted: C.muted, warn: C.warn };
  // Errors can carry an instruction, so they get the full width below the
  // selector; short statuses replace the description and keep the panel still.
  const inline = message?.tone === "err" ? null : message;
  // data.mode is already the optimistic target while a switch is pending.
  const tint = { cool: C.modeCool, neutral: C.text, hot: C.modeHot }[modeTint(data.mode)];

  return (
    <View style={[styles.panel, { borderTopColor: C.border }]}>
      <View style={styles.header}>
        <Text style={[type.eyebrow, { color: C.muted }]}>Power mode</Text>
      </View>

      <View style={styles.hero}>
        {data.fans.length > 0 && (
          <View style={styles.fans}>
            {/* Index keys: labels come from drivers and may repeat. */}
            {data.fans.slice(0, 2).map((fan, index) => (
              <FanRotor key={index} fan={fan} tint={tint} stale={!online || state.isError} />
            ))}
            {data.fans.length > 2 && (
              <Text style={[styles.fanLabel, { color: C.faint, alignSelf: "center" }]}>{`+${data.fans.length - 2} fans`}</Text>
            )}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.modeTitle, { color: C.text }]} numberOfLines={1}>
            {meta?.label ?? "Unknown"}
          </Text>
          {/* Status takes the description's place, so the panel never grows. */}
          <Text
            accessibilityLiveRegion="polite"
            style={[type.muted, styles.modeLine, { color: inline === null ? C.muted : toneColor[inline.tone] }]}
            numberOfLines={3}
          >
            {inline !== null
              ? inline.text
              : data.mode !== null && !data.modes.includes(data.mode)
                ? "Selected on the machine itself; pick a mode to take over."
                : (meta?.description ?? "The machine did not report its current mode.")}
          </Text>
          {data.degraded !== null && (
            <Text style={[type.muted, { color: C.warn, marginTop: 4 }]} numberOfLines={2}>
              {`Performance held back: ${humanize(data.degraded)}`}
            </Text>
          )}
        </View>
      </View>

      <ModeSelector
        modes={modes}
        value={data.mode}
        disabled={!online || pending !== null}
        pending={pending}
        onSelect={select}
        shake={shake}
      />
      {message?.tone === "err" && (
        <Text accessibilityLiveRegion="assertive" style={[type.muted, styles.error, { color: C.err }]}>
          {message.text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: spacing.m, paddingTop: spacing.m, borderTopWidth: hairline },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  hero: { flexDirection: "row", alignItems: "center", gap: spacing.m, marginTop: spacing.s, marginBottom: spacing.m },
  fans: { flexDirection: "row", gap: spacing.s },
  fan: { alignItems: "center", width: 58 },
  fanRpm: { fontSize: 10.5, fontWeight: "600", marginTop: 4, fontVariant: ["tabular-nums"] },
  modeTitle: { fontSize: 17, fontWeight: "700", letterSpacing: -0.3 },
  modeLine: { marginTop: 2, lineHeight: 17 },
  error: { marginTop: spacing.s, lineHeight: 17 },
  fanLabel: { fontSize: 10.5, marginTop: 1 },
  track: { flexDirection: "row", borderRadius: radius.m, borderWidth: hairline },
  thumb: { position: "absolute", borderRadius: radius.m - 4 },
  segment: { flex: 1 },
  segmentFill: { flex: 1 },
  segmentInner: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 4 },
  segmentStacked: { flexDirection: "column", gap: 3, paddingHorizontal: 2 },
  segmentLabel: { fontWeight: "600" },
  skeleton: { height: 112, borderRadius: radius.m, marginTop: spacing.s },
});
