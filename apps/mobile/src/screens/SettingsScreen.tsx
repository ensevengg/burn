import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp } from "../lib/app-context";
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
  const { mode, reportingTimezone, setReportingTimezone, disconnect, clearData, sync, lastSync } = useApp();
  const { C, themeMode, setThemeMode } = useThemeExtras();
  const [tzPicker, setTzPicker] = useState(false);

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
            <Chip tone={mode === "cloud" ? "green" : mode === "demo" ? "yellow" : "muted"}>{mode}</Chip>
          </View>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            BYO Supabase (D4). The app holds only a scoped read token (D7); the secret key never leaves your
            dashboard.
          </Text>
          {mode === "cloud" && (
            <View style={[styles.dangerButton, { borderColor: C.border }]} onTouchEnd={() => void disconnect()}>
              <Text style={{ color: C.err, fontWeight: "600" }}>Disconnect & wipe local cache</Text>
            </View>
          )}
          {mode === "demo" && (
            <View style={[styles.dangerButton, { borderColor: C.border }]} onTouchEnd={() => void clearData()}>
              <Text style={{ color: C.err, fontWeight: "600" }}>Clear demo data</Text>
            </View>
          )}
        </Card>

        <SectionTitle>Reporting timezone</SectionTitle>
        <Card>
          <Text style={[type.body, { color: C.text }]}>{reportingTimezone}</Text>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            Persisted at setup and stable until you change it (D8). History is re-bucketed at render time from
            stored UTC instants — nothing is rewritten.
          </Text>
          <View style={[styles.tzToggle, { backgroundColor: C.panelAlt, borderColor: C.border }]} onTouchEnd={() => setTzPicker(!tzPicker)}>
            <Text style={{ color: C.text, fontWeight: "600" }}>{tzPicker ? "Hide options" : "Change…"}</Text>
          </View>
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
            <View style={[styles.tzToggle, { backgroundColor: C.panelAlt, borderColor: C.border }]} onTouchEnd={() => void sync()}>
              <Text style={{ color: C.text, fontWeight: "600" }}>Pull delta now</Text>
            </View>
          </View>
          <Text style={[type.muted, { color: C.muted, marginTop: 6 }]}>
            {mode === "cloud"
              ? `Fetches revision > watermark. Last pulled ${lastSync === null ? "never" : lastSync.toISOString()}.`
              : "Available when connected to a backend."}
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
            machines run the `burn-report` reporter; this app is the reader. Both talk only to your own Supabase
            project through scoped, revocable tokens — no burn servers, no accounts, no telemetry (D12). Remove a
            machine with − on its card; rotate access by revoking its token in Supabase.
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
