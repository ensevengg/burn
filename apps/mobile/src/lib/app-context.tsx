import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState as NativeAppState } from "react-native";
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
import { seedDemoData, syncFromCloud, requestMachineSync, cancelCloudSync } from "./sync";
import { removeEnvironmentLocal } from "../data/repository";
import { subscribeMirrorChanges } from "./sync-state";
import { followMachineUpdates } from "./refresh";
import { createBurnBackend } from "@burn/sync-api";

interface AppState {
  db: SQLiteDatabase | null;
  mode: AppMode;
  reportingTimezone: string;
  enterDemo: () => Promise<void>;
  connect: (config: ConnectionConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  sync: () => Promise<void>;
  requestSync: (environmentId: string | null) => Promise<void>;
  removeMachine: (environmentId: string) => Promise<void>;
  setReportingTimezone: (tz: string) => Promise<void>;
  clearData: () => Promise<void>;
}

/**
 * Pull progress lives in its own context: lastSync ticks on every successful
 * minute-cycle even when nothing changed, and without the split that would
 * re-render every useApp() consumer app-wide.
 */
interface SyncStatus {
  lastSync: Date | null;
  syncError: string | null;
  /** Backfill progress is informational, not a failure — rendered apart from errors. */
  syncNotice: string | null;
  /** True while the first pull after a machine-refresh request is running. */
  refreshingMachines: boolean;
  /** True for the whole bounded follow-up window, not just the first pull. */
  checkingMachines: boolean;
}

const AppContext = createContext<AppState | null>(null);
const SyncStatusContext = createContext<SyncStatus | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [mode, setMode] = useState<AppMode>("unconfigured");
  const [reportingTimezone, setTzState] = useState("Asia/Kolkata");
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null,
    syncError: null,
    syncNotice: null,
    refreshingMachines: false,
    checkingMachines: false,
  });
  const followup = useRef<{
    controller: AbortController;
    target: string | null;
    promise: Promise<void>;
  } | null>(null);
  const lifecycle = useRef(0);

  const patchStatus = useCallback((patch: Partial<SyncStatus>) => {
    setStatus((current) => ({ ...current, ...patch }));
  }, []);

  const stop = useCallback(() => {
    lifecycle.current++;
    followup.current?.controller.abort();
    followup.current = null;
    patchStatus({ refreshingMachines: false, checkingMachines: false });
    if (db) cancelCloudSync(db);
  }, [db, patchStatus]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const opened = await openDb();
      const currentMode = await getMode(opened);
      const tz = await getReportingTimezone(opened);
      if (!active) return;
      setDb(opened);
      setTzState(tz);
      setMode(currentMode);
    })().catch((err) => {
      if (active) patchStatus({ syncError: (err as Error).message });
    });
    return () => {
      active = false;
    };
  }, [patchStatus]);

  useEffect(
    () =>
      subscribeMirrorChanges((changedDb, kind) => {
        if (changedDb !== db) return;
        // Quota-only refreshes must not restart all historical aggregations.
        void queryClient.invalidateQueries({
          predicate: (query) =>
            kind === "events"
              ? query.queryKey[0] !== "quotas" && query.queryKey[0] !== "machines"
              : query.queryKey[0] === kind,
        });
      }),
    [db, queryClient],
  );

  const sync = useCallback(async () => {
    if (db === null || mode !== "cloud") return;
    const epoch = lifecycle.current;
    try {
      const result = await syncFromCloud(db);
      if (epoch !== lifecycle.current) return;
      patchStatus({
        lastSync: new Date(),
        syncError: null,
        syncNotice: result.hasMore ? "History backfill continues on the next sync." : null,
      });
    } catch (err) {
      if (epoch === lifecycle.current) patchStatus({ syncError: (err as Error).message, syncNotice: null });
    }
  }, [db, mode, patchStatus]);

  useEffect(() => {
    if (mode !== "cloud") return;
    void sync();
    const subscription = NativeAppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    const timer = setInterval(() => {
      if (NativeAppState.currentState === "active") void sync();
    }, 60_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
      stop();
    };
  }, [mode, sync, stop]);

  const value = useMemo<AppState>(() => {
    const invalidate = () => {
      void queryClient.invalidateQueries();
    };
    const prepareReset = async () => {
      stop();
      await queryClient.cancelQueries();
      queryClient.removeQueries();
      patchStatus({ lastSync: null, syncError: null, syncNotice: null });
    };
    return {
      db,
      mode,
      reportingTimezone,
      sync,
      async enterDemo() {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        await seedDemoData(db);
        setMode("demo");
        invalidate();
      },
      async connect(config) {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        await resetDb(db);
        await saveConnection(db, config);
        // Mount cached screens immediately; the cloud effect backfills in the background.
        setMode("cloud");
        invalidate();
      },
      async disconnect() {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        await clearConnection(db);
        await resetDb(db);
        invalidate();
      },
      async requestSync(environmentId) {
        if (!db || mode !== "cloud") return;
        const existing = followup.current;
        if (existing && (existing.target === null || existing.target === environmentId))
          return existing.promise;
        existing?.controller.abort();
        const controller = new AbortController();
        const epoch = lifecycle.current;
        const pending = (async () => {
          patchStatus({ refreshingMachines: true, checkingMachines: true });
          try {
            await requestMachineSync(db, environmentId);
            if (controller.signal.aborted || epoch !== lifecycle.current) return;
            // The spinner covers the first pull; the follow-up keeps checking
            // in the background via checkingMachines.
            await followMachineUpdates(controller.signal, sync, {
              onSettle: () => patchStatus({ refreshingMachines: false }),
            });
          } catch (err) {
            if (!controller.signal.aborted && epoch === lifecycle.current)
              patchStatus({ syncError: (err as Error).message, syncNotice: null });
          } finally {
            if (followup.current?.controller === controller) {
              followup.current = null;
              patchStatus({ refreshingMachines: false, checkingMachines: false });
            }
          }
        })();
        followup.current = { controller, target: environmentId, promise: pending };
        return pending;
      },
      async removeMachine(environmentId) {
        if (!db) return;
        stop();
        if (mode === "cloud") {
          const connection = await loadConnection();
          if (!connection) throw new Error("Not connected to a backend");
          await createBurnBackend(connection).phone(connection.readToken).removeEnvironment(environmentId);
        }
        await removeEnvironmentLocal(db, environmentId);
        invalidate();
      },
      async setReportingTimezone(tz) {
        if (!db) return;
        await setReportingTimezone(db, tz);
        setTzState(tz);
        invalidate();
      },
      async clearData() {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        await resetDb(db);
        await kvSet(db, "mode", "unconfigured");
        invalidate();
      },
    };
  }, [db, mode, reportingTimezone, sync, stop, queryClient, patchStatus]);

  return (
    <AppContext.Provider value={value}>
      <SyncStatusContext.Provider value={status}>{children}</SyncStatusContext.Provider>
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error("useApp outside AppProvider");
  return state;
}

export function useSyncStatus(): SyncStatus {
  const state = useContext(SyncStatusContext);
  if (!state) throw new Error("useSyncStatus outside AppProvider");
  return state;
}
