import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../lib/theme-context";
import type { ThemeColors } from "../theme";
import { spacing, type } from "../theme";

const cardStyle = (C: ThemeColors): ViewStyle => ({
  backgroundColor: C.panel,
  borderColor: C.border,
  borderWidth: 1,
  borderRadius: 12,
  padding: spacing.l,
  marginHorizontal: spacing.l,
  marginVertical: spacing.s,
});

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { C } = useTheme();
  return <View style={[cardStyle(C), style]}>{children}</View>;
}

export function SectionTitle({ children, trailing }: { children: React.ReactNode; trailing?: string | undefined }) {
  const { C } = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[type.h2, { color: C.text, flex: 1 }]}>{children}</Text>
      {trailing !== undefined && <Text style={[type.muted, { color: C.muted }]}>{trailing}</Text>}
    </View>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: "accent" | "muted" | undefined;
}) {
  const { C } = useTheme();
  const valueColor = tone === "accent" ? C.muted : C.text;
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.muted, { color: C.muted }]}>{label}</Text>
      <Text style={[type.stat, { color: valueColor }]}>{value}</Text>
      {sub !== undefined && <Text style={[type.muted, { color: C.muted }]}>{sub}</Text>}
    </View>
  );
}

export function Chip({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "green" | "red" | "yellow" | "blue" | "accent";
}) {
  const { C } = useTheme();
  const map = {
    muted: { bg: C.panelAlt, fg: C.muted },
    accent: { bg: C.panelAlt, fg: C.text },
    green: { bg: C.panelAlt, fg: C.ok },
    red: { bg: C.panelAlt, fg: C.err },
    yellow: { bg: C.panelAlt, fg: C.warn },
    blue: { bg: C.panelAlt, fg: C.text },
  } as const;
  return (
    <View style={{ backgroundColor: map[tone].bg, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: "flex-start" }}>
      <Text style={{ fontSize: 11, color: map[tone].fg, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { C } = useTheme();
  return (
    <View style={[styles.segmentWrap, { backgroundColor: C.panel, borderColor: C.border }]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <View
            key={option.value}
            style={[styles.segment, { backgroundColor: active ? C.accent : "transparent" }]}
            onTouchEnd={() => onChange(option.value)}
          >
            <Text
              style={{
                fontSize: 12.5,
                fontWeight: "600",
                color: active ? C.accentInk : C.muted,
              }}
            >
              {option.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function MeterBar({ usedPercent, tone }: { usedPercent: number; tone?: string }) {
  const { C } = useTheme();
  const width = Math.max(0, Math.min(100, usedPercent));
  // Monochrome to match the dual-tone theme (user feedback); red only as the
  // single "you're about to hit the wall" signal.
  const color = tone ?? (width > 85 ? C.err : C.text);
  return (
    <View style={[styles.meterTrack, { backgroundColor: C.panelAlt }]}>
      <View style={{ width: `${width}%`, backgroundColor: color, height: "100%", borderRadius: 999 }} />
    </View>
  );
}

export function Empty({ message }: { message: string }) {
  const { C } = useTheme();
  return (
    <Card style={{ alignItems: "center", paddingVertical: spacing.xxl }}>
      <Text style={[type.muted, { color: C.muted }]}>{message}</Text>
    </Card>
  );
}

export function Dot({ ok }: { ok: boolean }) {
  const { C } = useTheme();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ok ? C.ok : C.faint }} />;
}

const styles = StyleSheet.create({
  sectionRow: { flexDirection: "row", alignItems: "center", marginHorizontal: spacing.l, marginTop: spacing.m },
  segmentWrap: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 10,
    padding: 3,
    marginHorizontal: spacing.l,
    marginVertical: spacing.s,
  },
  segment: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: 8 },
  meterTrack: { height: 6, borderRadius: 999, overflow: "hidden", marginTop: spacing.s },
});
