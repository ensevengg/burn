import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp, useSyncStatus } from "../lib/app-context";
import { confirmDestructive } from "../lib/confirm-destructive";
import { useTheme, type ThemeMode } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card, SectionTitle, Segmented, Chip } from "../ui/primitives";
import { SYNC_SCHEMA_VERSION, TOKSCALE_PIN } from "@burn/sync-api";

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

export function SettingsScreen() {
  const { mode, reportingTimezone, setReportingTimezone, disconnect, clearData, sync } = useApp();
  const { lastSync } = useSyncStatus();
  const { C, themeMode, setThemeMode } = useThemeExtras();
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
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={[type.title, { color: C.text }, styles.title]}>Settings</Text>

        <SectionTitle>Appearance</SectionTitle>
        <Card>
          <Segmented options={THEME_OPTIONS} value={themeMode} onChange={setThemeMode} />
          <Text style={[type.muted, { color: C.muted, marginTop: spacing.s }]}>
            Grey-dark accent in dark mode, near-black in light. System follows your phone.
          </Text>
        </Card>

        <SectionTitle>Backend</SectionTitle>
        <Card>
          <View style={styles.rowBetween}>
            <Text style={[type.body, { color: C.text }]}>Mode</Text>
            <Chip tone={mode === "direct" ? "green" : mode === "demo" ? "yellow" : "muted"}>{mode === "direct" ? "Tailscale" : "Demo"}</Chip>
          </View>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            {mode === "direct"
              ? "Your phone reads directly from your machines over Tailscale. Cached history stays available when a machine is offline."
              : "Bundled demo data. Choose Tailscale during setup to connect real machines."}
          </Text>
          {mode === "direct" && (
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: C.border, foreground: true, borderless: false }}
              style={[styles.dangerButton, { borderColor: C.border }]}
              onPress={confirmWipe}
            >
              <Text style={{ color: C.err, fontWeight: "600" }}>Disconnect & wipe local cache</Text>
            </Pressable>
          )}
          {mode === "demo" && (
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: C.border, foreground: true, borderless: false }}
              style={[styles.dangerButton, { borderColor: C.border }]}
              onPress={confirmWipe}
            >
              <Text style={{ color: C.err, fontWeight: "600" }}>Clear demo data</Text>
            </Pressable>
          )}
        </Card>

        <SectionTitle>Reporting timezone</SectionTitle>
        <Card>
          <Text style={[type.body, { color: C.text }]}>{reportingTimezone}</Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            Persisted at setup and stable until you change it (D8). History is re-bucketed at render time from
            stored UTC instants — nothing is rewritten.
          </Text>
          <Pressable
            accessibilityRole="button"
            android_ripple={{ color: C.border, foreground: true, borderless: false }}
            style={[styles.tzToggle, { backgroundColor: C.panelAlt, borderColor: C.border }]}
            onPress={() => setTzPicker(!tzPicker)}
          >
            <Text style={{ color: C.text, fontWeight: "600" }}>{tzPicker ? "Hide options" : "Change…"}</Text>
          </Pressable>
          {tzPicker && (
            <Segmented
              options={TIMEZONES.map((tz) => ({ label: tz.split("/").pop() ?? tz, value: tz }))}
              value={reportingTimezone}
              onChange={(tz) => {
                void setReportingTimezone(tz);
                setTzPicker(false);
              }}
            />
          )}
        </Card>

        <SectionTitle>Sync</SectionTitle>
        <Card>
          <View style={styles.rowBetween}>
            <Text style={[type.body, { color: C.text }]}>Manual refresh</Text>
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: C.border, foreground: true, borderless: false }}
              style={[styles.tzToggle, { backgroundColor: C.panelAlt, borderColor: C.border }]}
              onPress={() => void sync()}
            >
              <Text style={{ color: C.text, fontWeight: "600" }}>Sync machines now</Text>
            </Pressable>
          </View>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            {mode === "direct"
              ? `Probes every registered machine. Last pulled ${lastSync === null ? "never" : lastSync.toISOString()}.`
              : "Available when connected to your machines."}
          </Text>
        </Card>

        <SectionTitle>About</SectionTitle>
        <Card>
          <Text style={[type.body, { color: C.text }]}>burn 0.1.0</Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            {`Sync schema v${SYNC_SCHEMA_VERSION} · tokscale pin ${TOKSCALE_PIN} · Expo SDK 57 / React Native 0.86`}
          </Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 8 }]}>
            burn wraps tokscale (MIT, by junhoyeo) for parsing — 50+ AI coding agents, priced with LiteLLM data. Your
            machines run the `burn-report` reporter; this app reads them over your tailnet. No burn servers,
            accounts or telemetry. Remove a machine with − on its card; manage network access in Tailscale.
          </Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 8 }]}>
            Open source under MIT. Issues and PRs welcome at the burn repository — AGENTS.md documents every
            architectural decision (D1–D12) for contributors and their agents.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Bridges theme-mode state (ThemeContext) into the screen. */
function useThemeExtras() {
  const { C, mode, setMode } = useTheme();
  return { C, themeMode: mode, setThemeMode: setMode };
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  title: { marginHorizontal: spacing.l, marginTop: spacing.m, marginBottom: spacing.s },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tzToggle: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginTop: spacing.m,
  },
  dangerButton: {
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 11,
    marginTop: spacing.m,
  },
});
