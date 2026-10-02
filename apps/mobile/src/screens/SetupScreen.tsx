import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card } from "../ui/primitives";

export function SetupScreen() {
  const { enterDemo, connectDirect } = useApp();
  const { C } = useTheme();
  const [busy, setBusy] = useState<null | "demo" | "direct">(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: C.text }]}>burn</Text>
        <Text style={[type.muted, { color: C.muted, marginBottom: spacing.xl }]}>
          Token burn-rate tracking for AI coding agents. Connect to your machines over Tailscale and keep your history on this phone.
        </Text>

        <Card>
          <Text style={[type.h2, { color: C.text }]}>Try it instantly</Text>
          <Text style={[type.muted, { color: C.muted, marginVertical: spacing.s }]}>
            Loads a bundled 120-day dataset (Codex, Z.ai, OpenCode across three machines) into the local cache.
          </Text>
          {busy === "demo" ? (
            <ActivityIndicator color={C.text} />
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={busy !== null}
              android_ripple={{ color: C.accentInk, foreground: true, borderless: false }}
              style={[styles.actionButton, { backgroundColor: C.accent }]}
              onPress={() => {
                if (busy !== null) return;
                setBusy("demo");
                setError(null);
                void enterDemo().catch((err: Error) => setError(err.message)).finally(() => setBusy(null));
              }}
            >
              <Text style={{ color: C.accentInk, fontWeight: "700" }}>Explore with demo data</Text>
            </Pressable>
          )}
        </Card>

        <Card>
          <Text style={[type.h2, { color: C.text }]}>Connect machines directly</Text>
          <Text style={[type.muted, { color: C.muted, marginVertical: spacing.s }]}>
            Your phone talks to your machines over Tailscale; history lives on this device and on
            the machines. Add machines on the Machines tab afterwards.
          </Text>
          {busy === "direct" ? (
            <ActivityIndicator color={C.text} />
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={busy !== null}
              android_ripple={{ color: C.border, foreground: true, borderless: false }}
              style={[styles.actionButton, { borderColor: C.accent, borderWidth: 1 }]}
              onPress={() => {
                if (busy !== null) return;
                setBusy("direct");
                setError(null);
                void connectDirect().catch((err: Error) => setError(err.message)).finally(() => setBusy(null));
              }}
            >
              <Text style={{ color: C.text, fontWeight: "700" }}>Use machines directly</Text>
            </Pressable>
          )}
        </Card>

        {error !== null && <Text style={{ color: C.err, marginTop: spacing.s }}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: spacing.xl, paddingBottom: 64 },
  actionButton: {
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 13,
    marginTop: spacing.s,
  },
});
