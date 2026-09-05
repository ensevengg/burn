import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Card } from "../ui/primitives";

export function SetupScreen() {
  const { enterDemo, connect } = useApp();
  const { C } = useTheme();
  const [url, setUrl] = useState("");
  const [publishableKey, setKey] = useState("");
  const [readToken, setToken] = useState("");
  const [busy, setBusy] = useState<null | "demo" | "cloud">(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedUrl = url.trim().replace(/\/+$/, "");
  const valid = trimmedUrl.startsWith("https://") && publishableKey.trim().length >= 10 && readToken.trim().length >= 24;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.title, { color: C.text }]}>burn</Text>
        <Text style={[type.muted, { color: C.muted, marginBottom: spacing.xl }]}>
          Token burn-rate tracking for AI coding agents. Your machines push to your own Supabase; this app reads it.
        </Text>

        <Card>
          <Text style={[type.h2, { color: C.text }]}>Try it instantly</Text>
          <Text style={[type.muted, { color: C.muted, marginVertical: spacing.s }]}>
            Loads a bundled 30-day dataset (Codex, Z.ai, OpenCode across three machines) into the local cache.
          </Text>
          {busy === "demo" ? (
            <ActivityIndicator color={C.text} />
          ) : (
            <View
              style={[styles.actionButton, { backgroundColor: C.accent }]}
              onTouchEnd={() => {
                setBusy("demo");
                void enterDemo().finally(() => setBusy(null));
              }}
            >
              <Text style={{ color: C.accentInk, fontWeight: "700" }}>Explore with demo data</Text>
            </View>
          )}
        </Card>

        <Card>
          <Text style={[type.h2, { color: C.text }]}>Connect your Supabase</Text>
          <Text style={[type.muted, { color: C.muted, marginVertical: spacing.s }]}>
            Paste supabase/migrations/0001 + 0002 and the setup-tokens.sql from
            <Text style={{ color: C.text }}> npx burn-report init </Text>
            into your project's SQL editor first.
          </Text>
          <Field label="Project URL" value={url} onChangeText={setUrl} placeholder="https://xyz.supabase.co" />
          <Field label="Publishable key" value={publishableKey} onChangeText={setKey} placeholder="sb_publishable_…" />
          <Field label="Read token" value={readToken} onChangeText={setToken} placeholder="from burn-report init" secure />
          {error !== null && <Text style={{ color: C.err, marginTop: spacing.s }}>{error}</Text>}
          {busy === "cloud" ? (
            <ActivityIndicator color={C.text} />
          ) : (
            <View
              style={[styles.actionButton, { backgroundColor: C.accent, opacity: valid ? 1 : 0.35 }]}
              onTouchEnd={() => {
                if (!valid) return;
                setBusy("cloud");
                setError(null);
                void connect({ url: trimmedUrl, publishableKey: publishableKey.trim(), readToken: readToken.trim() })
                  .catch((err: Error) => setError(err.message))
                  .finally(() => setBusy(null));
              }}
            >
              <Text style={{ color: C.accentInk, fontWeight: "700" }}>Connect & sync</Text>
            </View>
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  secure?: boolean;
}) {
  const { C } = useTheme();
  return (
    <View style={{ marginTop: spacing.m }}>
      <Text style={[type.muted, { color: C.muted, marginBottom: 4 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        keyboardType="default"
        style={[styles.input, { backgroundColor: C.panelAlt, borderColor: C.border, color: C.text }]}
      />
    </View>
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
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
});
