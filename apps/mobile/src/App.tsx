import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { AppState, StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "./lib/theme-context";
import { AppProvider } from "./lib/app-context";
import { PairingLinks } from "./lib/pairing-links";
import Navigation from "./navigation";

// React Native has no visibility events, so TanStack would treat the app as
// always focused and keep interval refetches running in the background.
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener("change", (state) => setFocused(state === "active"));
  return () => subscription.remove();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Returning to the app already pulls (app-context); queries opt in.
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
});

function ThemedShell() {
  const { C } = useTheme();
  return (
    <>
      <StatusBar barStyle={C.statusBar} backgroundColor={C.bg} />
      <AppProvider>
        <PairingLinks />
        <Navigation />
      </AppProvider>
    </>
  );
}

export default function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* Android 15 enforces edge-to-edge: without the provider every inset
            is zero and the tab bar renders under the system nav buttons. */}
        <SafeAreaProvider>
          <ThemedShell />
        </SafeAreaProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
