import { useState } from "react";
import { Alert, LayoutAnimation, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { SYNC_SCHEMA_VERSION, TOKSCALE_PIN } from "@burn/sync-api";
import { useApp, useSyncStatus } from "../lib/app-context";
import { confirmDestructive } from "../lib/confirm-destructive";
import { formatRelative } from "../lib/format";
import { useTheme, type ThemeMode } from "../lib/theme-context";
import { hairline, radius, spacing, type } from "../theme";
import { Card, Chip, Row, SectionTitle, Segmented } from "../ui/primitives";
import { PressableScale } from "../ui/motion";
import { Screen } from "../ui/screen";

const TIMEZONES = [
  "Asia/Kolkata",
  "UTC",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
];

const THEME_OPTIONS = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const satisfies readonly { label: string; value: ThemeMode }[];

function Chevron({ open, color }: { open: boolean; color: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 12 12" style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
      <Path d="M4.5 2.5 8 6l-3.5 3.5" stroke={color} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function SettingsScreen() {
  const { mode, reportingTimezone, setReportingTimezone, disconnect, clearData, sync } = useApp();
  const { lastSync } = useSyncStatus();
  const { C, mode: themeMode, setMode: setThemeMode } = useTheme();
  const [tzPicker, setTzPicker] = useState(false);
  const confirmWipe = () =>
    confirmDestructive(
      Alert,
      mode === "demo" ? "Clear demo data?" : "Disconnect and wipe local cache?",
      mode === "direct"
        ? "This removes all machine connections, cached usage, quotas and reference prices from this phone. You will need to add your machine URLs again. Data on your machines stays intact."
        : "This clears the demo data from this phone and returns to setup.",
      mode === "direct" ? disconnect : clearData,
    );

  return (
    <Screen title="Settings" refreshable={false}>
      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <Segmented options={THEME_OPTIONS} value={themeMode} onChange={setThemeMode} />
        <Text style={[type.muted, { color: C.muted, marginTop: spacing.m, lineHeight: 18 }]}>
          Graphite dark uses true black for OLED panels. System follows your phone.
        </Text>
      </Card>

      <SectionTitle>Connection</SectionTitle>
      <Card style={styles.list}>
        <Row
          first
          title="Backend"
          subtitle={
            mode === "direct"
              ? "Reads your machines directly over Tailscale. Cached history stays available offline."
              : "Bundled demo data. Choose Tailscale during setup to connect real machines."
          }
          trailing={<Chip tone={mode === "direct" ? "green" : "yellow"} dot>{mode === "direct" ? "Tailscale" : "Demo"}</Chip>}
        />
        {mode === "direct" && (
          <Row
            title="Sync machines now"
            subtitle={`Last pulled ${lastSync === null ? "never" : formatRelative(lastSync.toISOString())}`}
            onPress={() => void sync()}
            trailing={<Chevron open={false} color={C.faint} />}
          />
        )}
        <Row
          title="Reporting timezone"
          subtitle={`${reportingTimezone} · days and months bucket here at render time`}
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setTzPicker(!tzPicker);
          }}
          trailing={<Chevron open={tzPicker} color={C.faint} />}
        />
        {tzPicker && (
          <View style={styles.tzGrid}>
            {TIMEZONES.map((tz) => {
              const active = tz === reportingTimezone;
              return (
                <PressableScale
                  key={tz}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    void setReportingTimezone(tz);
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setTzPicker(false);
                  }}
                  style={[
                    styles.tzChip,
                    { backgroundColor: active ? C.accent : C.panelAlt, borderColor: active ? C.accent : C.border },
                  ]}
                >
                  <Text style={{ fontSize: 12.5, fontWeight: "600", color: active ? C.accentInk : C.text }}>
                    {tz.replace("_", " ")}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
        )}
      </Card>

      <SectionTitle>Data</SectionTitle>
      <Card style={styles.list}>
        <Row
          first
          destructive
          title={mode === "direct" ? "Disconnect & wipe local cache" : "Clear demo data"}
          subtitle="Asks before deleting anything. Your machines keep their data."
          onPress={confirmWipe}
        />
      </Card>

      <SectionTitle>About</SectionTitle>
      <Card>
        <View style={styles.aboutTop}>
          <Text style={[type.h2, { color: C.text }]}>burn 0.1.0</Text>
          <Text style={[type.mono, { color: C.faint }]}>{`schema v${SYNC_SCHEMA_VERSION} · tokscale ${TOKSCALE_PIN}`}</Text>
        </View>
        <Text style={[type.muted, { color: C.muted, marginTop: 10, lineHeight: 18 }]}>
          burn wraps tokscale (MIT, by junhoyeo) to parse 50+ AI coding agents, priced with LiteLLM data. Your machines
          run the burn-report reporter; this app reads them over your tailnet. No burn servers, accounts or telemetry.
        </Text>
        <Text style={[type.muted, { color: C.faint, marginTop: 8, lineHeight: 18 }]}>
          Open source under MIT. AGENTS.md documents every architectural decision (D1–D12).
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 2 },
  tzGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 14,
    paddingTop: 4,
    marginHorizontal: -2,
  },
  tzChip: { borderRadius: radius.pill, borderWidth: hairline, paddingHorizontal: 12, paddingVertical: 8 },
  aboutTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.s },
});
