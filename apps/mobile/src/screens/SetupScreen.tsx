import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import { spacing, type } from "../theme";
import { Button } from "../ui/primitives";
import { FadeIn } from "../ui/motion";

/** Monochrome ember mark: a flame whose core is cut out of the canvas. */
function Mark({ color, bg }: { color: string; bg: string }) {
  return (
    <Svg width={64} height={64} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="markInk" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.55} />
          <Stop offset="1" stopColor={color} stopOpacity={1} />
        </LinearGradient>
      </Defs>
      <Path
        d="M33 4c2 10 13 16 13 31 0 9-6.3 17-14 17S18 44 18 35c0-7 4-11 7-15 1 5 3 8 6 9-1-9 0-18 2-25Z"
        fill="url(#markInk)"
      />
      <Path d="M32 33c4 4 6 7 6 11 0 4-2.7 7-6 7s-6-3-6-7c0-3 2-6 6-11Z" fill={bg} />
    </Svg>
  );
}

export function SetupScreen() {
  const { enterDemo, connectDirect } = useApp();
  const { C } = useTheme();
  const [busy, setBusy] = useState<null | "demo" | "direct">(null);
  const [error, setError] = useState<string | null>(null);

  const run = (which: "demo" | "direct", action: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(which);
    setError(null);
    void action()
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FadeIn>
          <Mark color={C.text} bg={C.bg} />
        </FadeIn>
        <FadeIn delay={80}>
          <Text style={[type.display, { color: C.text, marginTop: spacing.xl, fontSize: 52 }]}>burn</Text>
          <Text style={[type.body, { color: C.muted, marginTop: spacing.s, lineHeight: 21 }]}>
            Token burn for your AI coding agents — tokens, cache hits, spend and limits across every machine. Read
            over Tailscale, kept on this phone.
          </Text>
        </FadeIn>
        <View style={{ flex: 1, minHeight: 48 }} />
        <FadeIn delay={180} style={{ gap: spacing.m }}>
          {busy === "direct" ? (
            <ActivityIndicator color={C.text} style={styles.busy} />
          ) : (
            <Button
              label="Connect my machines"
              variant="solid"
              disabled={busy !== null}
              onPress={() => run("direct", connectDirect)}
              style={styles.cta}
            />
          )}
          {busy === "demo" ? (
            <ActivityIndicator color={C.text} style={styles.busy} />
          ) : (
            <Button
              label="Explore with demo data"
              disabled={busy !== null}
              onPress={() => run("demo", enterDemo)}
              style={styles.cta}
            />
          )}
          {error !== null && <Text style={{ color: C.err, textAlign: "center" }}>{error}</Text>}
          <Text style={[type.muted, { color: C.faint, textAlign: "center", marginTop: spacing.s }]}>
            No accounts, no servers, no telemetry. Add machines by URL afterwards.
          </Text>
        </FadeIn>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { flexGrow: 1, padding: spacing.xl, paddingTop: 72, paddingBottom: 40 },
  cta: { paddingVertical: 15 },
  busy: { height: 50 },
});
