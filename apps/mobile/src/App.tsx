import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "./lib/theme-context";
import { AppProvider } from "./lib/app-context";
import Navigation from "./navigation";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
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
