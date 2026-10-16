import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTheme } from "../lib/theme-context";
import { gutter, hairline, motion, radius, spacing, type } from "../theme";
import { GrowBar, PressableScale, useTweenedNumber } from "./motion";

/** Raised graphite surface. Hairline edge so it reads on true black. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { C } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: C.panel, borderColor: C.border }, style]}>{children}</View>
  );
}

/** Small uppercase section label with an optional trailing note or action. */
export function SectionTitle({
  children,
  trailing,
  onTrailingPress,
}: {
  children: ReactNode;
  trailing?: string | undefined;
  onTrailingPress?: (() => void) | undefined;
}) {
  const { C } = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[type.eyebrow, { color: C.muted, flex: 1 }]}>{children}</Text>
      {trailing !== undefined &&
        (onTrailingPress ? (
          <Pressable hitSlop={10} onPress={onTrailingPress} accessibilityRole="button">
            <Text style={[type.muted, { color: C.text, fontWeight: "600" }]}>{trailing}</Text>
          </Pressable>
        ) : (
          <Text style={[type.muted, { color: C.faint }]}>{trailing}</Text>
        ))}
    </View>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  const { C } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <Text style={[type.stat, { color: C.text, marginTop: 2 }]} numberOfLines={1}>
        {value}
      </Text>
      {sub !== undefined && <Text style={[type.muted, { color: C.faint, marginTop: 1 }]}>{sub}</Text>}
    </View>
  );
}

type Tone = "muted" | "green" | "red" | "yellow" | "blue" | "accent";

export function Chip({ children, tone = "muted", dot = false }: { children: string; tone?: Tone; dot?: boolean }) {
  const { C } = useTheme();
  const fg = { muted: C.muted, accent: C.text, green: C.ok, red: C.err, yellow: C.warn, blue: C.text }[tone];
  return (
    <View style={[styles.chip, { backgroundColor: C.panelAlt }]}>
      {dot && <View style={[styles.chipDot, { backgroundColor: fg }]} />}
      <Text style={{ fontSize: 11.5, color: fg, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

/**
 * Segmented control with a sliding selection pill (UI-thread spring). The
 * indicator is measured once per layout; labels swap color instantly so the
 * motion reads as the pill moving, not text flickering.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "m",
  style,
}: {
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
  size?: "s" | "m";
  style?: StyleProp<ViewStyle>;
}) {
  const { C, resolved } = useTheme();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const position = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    Animated.spring(position, { toValue: index, useNativeDriver: true, ...motion.snappy }).start();
  }, [index, position]);
  const inset = 3;
  const segment = width === 0 ? 0 : (width - inset * 2) / options.length;
  const height = size === "s" ? 32 : 38;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.segmentTrack,
        { height, padding: inset, backgroundColor: resolved === "light" ? C.panelAlt : C.panel, borderColor: C.border },
        style,
      ]}
    >
      {segment > 0 && (
        <Animated.View
          style={[
            styles.segmentPill,
            {
              top: inset,
              left: inset,
              width: segment,
              height: height - inset * 2,
              backgroundColor: C.selection,
              borderColor: resolved === "light" ? C.border : "#33373d",
              transform: [
                {
                  translateX: position.interpolate({
                    inputRange: [0, Math.max(1, options.length - 1)],
                    outputRange: [0, segment * Math.max(1, options.length - 1)],
                  }),
                },
              ],
            },
          ]}
        />
      )}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            unstable_pressDelay={50}
            onPress={() => onChange(option.value)}
            style={styles.segment}
          >
            <Text
              numberOfLines={1}
              style={{ fontSize: size === "s" ? 12.5 : 13, fontWeight: "600", color: active ? C.text : C.muted }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MeterBar({ percent, tone }: { percent: number; tone?: string }) {
  const { C } = useTheme();
  return <GrowBar fraction={percent / 100} color={tone ?? C.text} track={C.panelAlt} />;
}

/** Circular gauge: `fraction` of the ring filled, label centered. */
export function Ring({
  fraction,
  size = 52,
  stroke = 5,
  color,
  children,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  color: string;
  children?: ReactNode;
}) {
  const { C } = useTheme();
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  // Sweeps to new values on refresh rather than snapping.
  const swept = useTweenedNumber(Math.max(0, Math.min(1, fraction)), 650);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.panelAlt} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - swept)}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      {children}
    </View>
  );
}

/** One horizontal bar split into shares (largest first), with a gap between segments. */
export function ShareBar({ shares, height = 8 }: { shares: { key: string; fraction: number; color: string }[]; height?: number }) {
  const { C } = useTheme();
  const visible = shares.filter((share) => share.fraction > 0.004);
  return (
    <View style={{ flexDirection: "row", height, gap: 3, borderRadius: height, overflow: "hidden" }}>
      {visible.length === 0 ? (
        <View style={{ flex: 1, backgroundColor: C.panelAlt }} />
      ) : (
        visible.map((share) => <ShareSegment key={share.key} fraction={share.fraction} color={share.color} />)
      )}
    </View>
  );
}

/** Segments glide to new shares, so a refresh or range switch re-proportions instead of jumping. */
function ShareSegment({ fraction, color }: { fraction: number; color: string }) {
  const flex = useTweenedNumber(fraction, 650);
  return <View style={{ flex, backgroundColor: color, borderRadius: 2 }} />;
}

/** Settings-style list row inside a Card. */
export function Row({
  title,
  subtitle,
  trailing,
  onPress,
  destructive = false,
  first = false,
}: {
  title: string;
  subtitle?: string | undefined;
  trailing?: ReactNode;
  onPress?: (() => void) | undefined;
  destructive?: boolean;
  first?: boolean;
}) {
  const { C } = useTheme();
  const body = (
    <View style={[styles.row, !first && { borderTopWidth: hairline, borderTopColor: C.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: destructive ? C.err : C.text, fontWeight: "500" }]}>{title}</Text>
        {subtitle !== undefined && (
          <Text style={[type.muted, { color: C.muted, marginTop: 2, lineHeight: 17 }]}>{subtitle}</Text>
        )}
      </View>
      {typeof trailing === "string" ? <Text style={[type.muted, { color: C.muted }]}>{trailing}</Text> : trailing}
    </View>
  );
  if (!onPress) return body;
  return (
    <PressableScale scaleTo={0.985} accessibilityRole="button" accessibilityLabel={title} onPress={onPress}>
      {body}
    </PressableScale>
  );
}

export function Empty({ message }: { message: string }) {
  const { C } = useTheme();
  return (
    <View style={[styles.empty, { borderColor: C.border }]}>
      <Text style={[type.muted, { color: C.muted, textAlign: "center", lineHeight: 18 }]}>{message}</Text>
    </View>
  );
}

export function Dot({ ok, color, size = 8 }: { ok?: boolean; color?: string; size?: number }) {
  const { C } = useTheme();
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? (ok ? C.ok : C.faint) }}
    />
  );
}

/** Ghost button: hairline outline, scales on press. */
export function Button({
  label,
  onPress,
  variant = "ghost",
  disabled = false,
  grow = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "ghost" | "solid" | "danger";
  disabled?: boolean;
  /** Share a row's width equally with sibling buttons. */
  grow?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { C } = useTheme();
  const solid = variant === "solid";
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      containerStyle={grow ? { flex: 1 } : undefined}
      style={[
        styles.button,
        {
          backgroundColor: solid ? C.accent : C.panelAlt,
          borderColor: solid ? C.accent : C.border,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Text style={{ color: solid ? C.accentInk : variant === "danger" ? C.err : C.text, fontWeight: "600", fontSize: 14 }}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: hairline,
    borderRadius: radius.l,
    padding: spacing.l,
    marginHorizontal: gutter - 4,
    marginVertical: 6,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: gutter,
    marginTop: spacing.xl,
    marginBottom: spacing.s,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3.5,
    alignSelf: "flex-start",
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  segmentTrack: {
    flexDirection: "row",
    borderRadius: radius.pill,
    borderWidth: hairline,
  },
  segmentPill: {
    position: "absolute",
    borderRadius: radius.pill,
    borderWidth: hairline,
  },
  segment: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 13, gap: spacing.m },
  empty: {
    marginHorizontal: gutter - 4,
    marginVertical: 6,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.l,
    borderRadius: radius.l,
    borderWidth: hairline,
    borderStyle: "dashed",
    alignItems: "center",
  },
  button: {
    borderWidth: hairline,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
});
