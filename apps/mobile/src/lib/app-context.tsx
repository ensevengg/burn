import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openDb, resetDb, kvSet, type SQLiteDatabase } from "./db";
import {
  clearConnection,
  getMode,
  getReportingTimezone,
  loadConnection,
  saveConnection,
  setReportingTimezone,
  type AppMode,
  type ConnectionConfig,
} from "./settings";
import { seedDemoData, syncFromCloud, requestMachineSync, type SyncResult } from "./sync";
import { removeEnvironmentLocal } from "../data/repository";
import { createBurnBackend } from "@burn/sync-api";

interface AppState {
  db: SQLiteDatabase | null;
  mode: AppMode;
  reportingTimezone: string;
  lastSync: Date | null;
  syncError: string | null;
  enterDemo: () => Promise<void>;
  connect: (config: ConnectionConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  sync: () => Promise<void>;
  requestSync: (environmentId: string | null) => Promise<void>;
  /** Stop managing a machine (server delete + local mirror cleanup). */
  removeMachine: (environmentId: string) => Promise<void>;
  setReportingTimezone: (tz: string) => Promise<void>;
  clearData: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [mode, setMode] = useState<AppMode>("unconfigured");
  const [reportingTimezone, setTzState] = useState("Asia/Kolkata");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const opened = await openDb();
      setDb(opened);
      setMode(await getMode(opened));
      setTzState(await getReportingTimezone(opened));
      // Cloud mode: pull the delta on open (stale-while-revalidate — the UI
      // renders cached SQLite data immediately, this just refreshes it).
      const currentMode = await getMode(opened);
      if (currentMode === "cloud") {
        try {
          await syncFromCloud(opened);
          queryClient.invalidateQueries();
        } catch (err) {
          setSyncError((err as Error).message);
        }
      }
    })();
  }, [queryClient]);

  const value = useMemo<AppState>(() => {
    const invalidate = () => queryClient.invalidateQueries();
    return {
      db,
      mode,
      reportingTimezone,
      lastSync,
      syncError,
      async enterDemo() {
        if (db === null) return;
        await seedDemoData(db);
        setMode("demo");
        setSyncError(null);
        invalidate();
      },
      async connect(config) {
        if (db === null) return;
        await resetDb(db);
        await saveConnection(db, config);
        const result = await syncFromCloud(db);
        setMode("cloud");
        setSyncError(null);
        setLastSync(new Date());
        console.log(`[burn] initial backfill: ${result.pulledEvents} events across ${result.pages} pages`);
        invalidate();
      },
      async disconnect() {
        if (db === null) return;
        await clearConnection(db);
        await resetDb(db);
        setMode("unconfigured");
        invalidate();
      },
      async sync() {
        if (db === null || mode !== "cloud") return;
        try {
          await syncFromCloud(db);
          setLastSync(new Date());
          setSyncError(null);
          invalidate();
        } catch (err) {
          setSyncError((err as Error).message);
        }
      },
      async requestSync(environmentId) {
        if (db === null || mode !== "cloud") return;
        try {
          await requestMachineSync(db, environmentId);
          // Daemons poll every ~30s; give them a beat, then pull what landed.
          setTimeout(() => {
            void (async () => {
              try {
                await syncFromCloud(db);
                setLastSync(new Date());
                invalidate();
              } catch {
                /* surfaced on next manual sync */
              }
            })();
          }, 6_000);
        } catch (err) {
          setSyncError((err as Error).message);
        }
      },
      async removeMachine(environmentId) {
        if (db === null) return;
        // Server row first (cascades events + quotas); local mirror always
        // cleans up so demo mode can "remove" too.
        if (mode === "cloud") {
          const connection = await loadConnection();
          if (connection === null) throw new Error("Not connected to a backend");
          await createBurnBackend(connection).phone(connection.readToken).removeEnvironment(environmentId);
        }
        await removeEnvironmentLocal(db, environmentId);
        invalidate();
      },
      async setReportingTimezone(tz) {
        if (db === null) return;
        await setReportingTimezone(db, tz);
        setTzState(tz);
        invalidate();
      },
      async clearData() {
        if (db === null) return;
        await resetDb(db);
        // Reset to Setup so an emptied app doesn't linger in demo/cloud mode
        // with nothing to show (user-visible bug: empty history after clear).
        await kvSet(db, "mode", "unconfigured");
        setMode("unconfigured");
        invalidate();
      },
    };
  }, [db, mode, reportingTimezone, lastSync, syncError, queryClient]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (state === null) throw new Error("useApp outside AppProvider");
  return state;
}
