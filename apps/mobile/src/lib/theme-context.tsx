import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SQLite from "expo-sqlite";
import { darkColors, lightColors, type ThemeColors } from "../theme";
import { openDb, kvGet, kvSet } from "./db";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeState {
  C: ThemeColors;
  /** Resolved palette actually in use. */
  resolved: "light" | "dark";
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const db = await openDb();
      const saved = await kvGet(db, "theme_mode");
      if (saved === "light" || saved === "dark" || saved === "system") setModeState(saved);
      setLoaded(true);
    })();
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    void openDb().then((db: SQLite.SQLiteDatabase) => kvSet(db, "theme_mode", next));
  };

  const value = useMemo<ThemeState>(() => {
    const resolved: "light" | "dark" =
      mode === "system" ? (system === "light" ? "light" : "dark") : mode;
    return { C: resolved === "light" ? lightColors : darkColors, resolved, mode, setMode };
  }, [mode, system]);

  // Render once after the persisted mode loads to avoid a light/dark flash.
  if (!loaded) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (state === null) throw new Error("useTheme outside ThemeProvider");
  return state;
}
