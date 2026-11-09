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
  fanFraction,
  formatRpm,
  modeMeta,
  orderModes,
  rotorPeriodMs,
  type ModeGlyph,
} from "../lib/power-mode-meta";
import { useTheme } from "../lib/theme-context";
import { hairline, motion, radius, spacing, type } from "../theme";
import { easeOut, Pulse, Skeleton } from "./motion";
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

function FanRotor({ fan, size = 64 }: { fan: MachineFan; size?: number }) {
  const { C } = useTheme();
  const rotate = useSpin(rotorPeriodMs(fan.rpm, fan.maxRpm));
  const fraction = fanFraction(fan.rpm, fan.maxRpm);
  const loud = fraction >= 0.85;
  const inner = size - 16;
  return (
    <View style={styles.fan} accessible accessibilityLabel={`${fan.label}: ${formatRpm(fan.rpm)}`}>
      <Ring fraction={fraction} size={size} stroke={3} color={loud ? C.warn : C.text}>
        <Animated.View style={{ width: inner, height: inner, transform: [{ rotate }] }}>
          <Svg width={inner} height={inner} viewBox="-50 -50 100 100">
            <G>
              {[0, 72, 144, 216, 288].map((angle) => (
                <Path key={angle} d={BLADE} fill={fan.rpm > 0 ? C.text : C.faint} opacity={0.92} transform={`rotate(${angle})`} />
              ))}
              <Circle r={12} fill={C.panelAlt} stroke={fan.rpm > 0 ? C.text : C.faint} strokeWidth={3} />
            </G>
          </Svg>
        </Animated.View>
      </Ring>
      <Text style={[styles.fanRpm, { color: loud ? C.warn : C.text }]}>{fan.rpm > 0 ? formatRpm(fan.rpm) : "stopped"}</Text>
      <Text style={[styles.fanLabel, { color: C.faint }]} numberOfLines={1}>
        {fan.label}
      </Text>
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
  const height = 66;
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
            <Glyph glyph={meta.glyph} color={ink} />
            <Text numberOfLines={1} style={[styles.segmentLabel, { color: ink, fontSize: modes.length > 3 ? 11.5 : 12.5 }]}>
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
              <View style={styles.segmentInner}>{label}</View>
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

/** Shown inside a live machine's Systems card when it advertises power-mode. */
export function PowerModePanel({
  machine,
  online,
  machineName,
}: {
  machine: ControlledMachine;
  online: boolean;
  machineName: string;
}) {
  const { C } = useTheme();
  const state = usePowerMode(machine, online);
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
        setFailure(`Couldn't switch: ${(err as Error).message.replace(/^https?:\/\/\S+: /, "")}`);
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
        {state.isError ? (
          <Text style={[type.muted, { color: C.warn, marginTop: spacing.s }]} numberOfLines={2}>
            {`Unavailable: ${(state.error as Error).message.replace(/^https?:\/\/\S+: /, "")}`}
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

  return (
    <View style={[styles.panel, { borderTopColor: C.border }]}>
      <View style={styles.header}>
        <Text style={[type.eyebrow, { color: C.muted }]}>Power mode</Text>
        {online && !state.isError && message === null && (
          <View style={styles.liveBadge}>
            <Pulse active>
              <View style={[styles.liveDot, { backgroundColor: C.ok }]} />
            </Pulse>
            <Text style={[type.muted, { color: C.muted }]}>live</Text>
          </View>
        )}
      </View>

      <View style={styles.hero}>
        {data.fans.length > 0 && (
          <View style={styles.fans}>
            {data.fans.slice(0, 2).map((fan) => (
              <FanRotor key={fan.label} fan={fan} />
            ))}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.stat, { color: C.text }]} numberOfLines={1}>
            {meta?.label ?? "Unknown"}
          </Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 3, lineHeight: 17 }]} numberOfLines={3}>
            {data.mode !== null && !data.modes.includes(data.mode)
              ? "Selected on the machine itself; pick a mode below to take over."
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

      <View style={styles.footer}>
        {message !== null && (
          <Text accessibilityLiveRegion="polite" style={[type.muted, { color: toneColor[message.tone], flex: 1 }]} numberOfLines={2}>
            {message.text}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: spacing.l, paddingTop: spacing.l, borderTopWidth: hairline },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  hero: { flexDirection: "row", alignItems: "center", gap: spacing.l, marginTop: spacing.m, marginBottom: spacing.l },
  fans: { flexDirection: "row", gap: spacing.m },
  fan: { alignItems: "center", width: 72 },
  fanRpm: { fontSize: 11.5, fontWeight: "600", marginTop: 6, fontVariant: ["tabular-nums"] },
  fanLabel: { fontSize: 10.5, marginTop: 1 },
  track: { flexDirection: "row", borderRadius: radius.m, borderWidth: hairline },
  thumb: { position: "absolute", borderRadius: radius.m - 4 },
  segment: { flex: 1 },
  segmentFill: { flex: 1 },
  segmentInner: { flex: 1, alignItems: "center", justifyContent: "center", gap: 5 },
  segmentLabel: { fontWeight: "600" },
  footer: { minHeight: 20, marginTop: spacing.s, flexDirection: "row", alignItems: "center" },
  skeleton: { height: 150, borderRadius: radius.m, marginTop: spacing.m },
});
