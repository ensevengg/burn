import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef,
  useState, type ReactNode,
} from "react";
import { AppState as NativeAppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { openDb, resetDb, kvSet, type SQLiteDatabase } from "./db";
import { getMode, getReportingTimezone, setReportingTimezone, type AppMode } from "./settings";
import { seedDemoData } from "./sync";
import {
  pullDirectFromMachines, cancelDirectPull, addDirectMachine,
  removeDirectMachine, type DirectPullStatus, type DirectPullOptions,
} from "./direct";
import { removeEnvironmentLocal } from "../data/repository";
import { advanceSyncGeneration, subscribeMirrorChanges } from "./sync-state";

interface AppState {
  db: SQLiteDatabase | null;
  mode: AppMode;
  reportingTimezone: string;
  enterDemo: () => Promise<void>;
  connectDirect: () => Promise<void>;
  addDirectMachine: (url: string) => Promise<{ slug: string; displayName: string }>;
  disconnect: () => Promise<void>;
  sync: () => Promise<void>;
  requestSync: (environmentId: string | null) => Promise<void>;
  removeMachine: (environmentId: string) => Promise<void>;
  setReportingTimezone: (tz: string) => Promise<void>;
  clearData: () => Promise<void>;
  fullSync: (environmentId: string) => Promise<void>;
}

/** Progress is separate from app state so updates do not rerender all screens. */
interface SyncStatus {
  lastSync: Date | null;
  syncError: string | null;
  syncNotice: string | null;
  refreshingMachines: boolean;
  checkingMachines: boolean;
  liveMachines: DirectPullStatus[];
}
const AppContext = createContext<AppState | null>(null);
const SyncStatusContext = createContext<SyncStatus | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [mode, setMode] = useState<AppMode>("unconfigured");
  const [reportingTimezone, setTzState] = useState("Asia/Kolkata");
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null, syncError: null, syncNotice: null,
    refreshingMachines: false, checkingMachines: false, liveMachines: [],
  });
  const lifecycle = useRef(0);
  const refreshCount = useRef(0);
  const backfillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continueSync = useRef<() => Promise<void>>(async () => {});
  const patchStatus = useCallback((patch: Partial<SyncStatus>) => {
    setStatus((current) => ({ ...current, ...patch }));
  }, []);

  /** Invalidate in-flight pulls and timers; probe results stay visible. */
  const cancelActive = useCallback(() => {
    lifecycle.current++;
    refreshCount.current = 0;
    if (backfillTimer.current) clearTimeout(backfillTimer.current);
    backfillTimer.current = null;
    patchStatus({ refreshingMachines: false, checkingMachines: false });
    if (db) {
      advanceSyncGeneration(db);
      cancelDirectPull(db);
    }
  }, [db, patchStatus]);
  const stop = useCallback(() => {
    cancelActive();
    patchStatus({ liveMachines: [] });
  }, [cancelActive, patchStatus]);

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
    })().catch((err: Error) => {
      if (active) patchStatus({ syncError: err.message });
    });
    return () => { active = false; };
  }, [patchStatus]);

  useEffect(() => subscribeMirrorChanges((changedDb, kind) => {
    if (changedDb !== db) return;
    void queryClient.invalidateQueries({
      predicate: (query) => kind === "events"
        ? query.queryKey[0] !== "quotas" && query.queryKey[0] !== "machines" && query.queryKey[0] !== "systems"
        : query.queryKey[0] === kind || (kind === "machines" && query.queryKey[0] === "systems"),
    });
  }), [db, queryClient]);

  const pull = useCallback(async (options: DirectPullOptions = {}) => {
    if (!db || mode !== "direct") return;
    const epoch = lifecycle.current;
    try {
      const statuses = await pullDirectFromMachines(db, options);
      if (epoch !== lifecycle.current) return;
      if (statuses.some((s) => s.hasMore) && NativeAppState.currentState === "active") {
        if (backfillTimer.current) clearTimeout(backfillTimer.current);
        backfillTimer.current = setTimeout(() => {
          backfillTimer.current = null;
          void continueSync.current();
        }, 1000);
      }
      setStatus((current) => {
        // Targeted and continuation passes report a subset of machines.
        const liveMachines = options.environmentId || options.continuation
          ? [
              ...current.liveMachines.filter((s) => !statuses.some((next) => next.environmentId === s.environmentId)),
              ...statuses,
            ]
          : statuses;
        const failed = liveMachines.filter((s) => s.state !== "live" || s.quotaError || s.metricsError).length;
        return {
          ...current,
          lastSync: statuses.some((s) => s.state === "live") ? new Date() : current.lastSync,
          syncError: failed ? `${failed} machine${failed === 1 ? "" : "s"} could not refresh fully. Showing cached data.` : null,
          syncNotice: liveMachines.some((s) => s.hasMore) ? "Loading machine history in the background." : null,
          liveMachines,
        };
      });
    } catch (err) {
      if (epoch === lifecycle.current) patchStatus({ syncError: (err as Error).message, syncNotice: null });
    }
  }, [db, mode, patchStatus]);
  const sync = useCallback(() => pull(), [pull]);
  continueSync.current = () => pull({ continuation: true });

  useEffect(() => {
    if (mode !== "direct") return;
    void sync();
    const subscription = NativeAppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => { subscription.remove(); stop(); };
  }, [mode, sync, stop]);

  const refresh = useCallback(async (environmentId: string | null, full = false) => {
    if (!db || mode !== "direct") return;
    const epoch = lifecycle.current;
    refreshCount.current++;
    patchStatus({ refreshingMachines: true, checkingMachines: true });
    try {
      await pull({ ...(environmentId ? { environmentId } : {}), ...(full ? { full: true } : {}) });
    } finally {
      if (epoch === lifecycle.current && --refreshCount.current === 0)
        patchStatus({ refreshingMachines: false, checkingMachines: false });
    }
  }, [db, mode, pull, patchStatus]);

  const value = useMemo<AppState>(() => {
    const invalidate = () => { void queryClient.invalidateQueries(); };
    const prepareReset = async () => {
      stop();
      await queryClient.cancelQueries();
      queryClient.removeQueries();
      patchStatus({ lastSync: null, syncError: null, syncNotice: null });
    };
    const clearData = async () => {
      if (!db) return;
      await prepareReset();
      setMode("unconfigured");
      await resetDb(db);
      await kvSet(db, "mode", "unconfigured");
      invalidate();
    };
    return {
      db, mode, reportingTimezone, sync,
      async enterDemo() {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        await seedDemoData(db);
        setMode("demo");
        invalidate();
      },
      async connectDirect() {
        if (!db) return;
        await prepareReset();
        setMode("unconfigured");
        if (mode === "demo") await resetDb(db);
        await kvSet(db, "machine_backend_v1", "1");
        await kvSet(db, "mode", "direct");
        setMode("direct");
        invalidate();
      },
      async addDirectMachine(url) {
        if (!db) throw new Error("App not started");
        const epoch = lifecycle.current;
        const added = await addDirectMachine(db, url);
        if (epoch !== lifecycle.current) throw new Error("add machine cancelled");
        invalidate();
        void pull({ environmentId: added.id });
        return added;
      },
      disconnect: clearData,
      clearData,
      requestSync: (environmentId) => refresh(environmentId),
      fullSync: (environmentId) => refresh(environmentId, true),
      async removeMachine(environmentId) {
        if (!db) return;
        // In-flight pulls must not write the removed machine back. Other
        // machines keep their status and resume pending backfills afterwards.
        cancelActive();
        setStatus((current) => ({
          ...current,
          liveMachines: current.liveMachines.filter((s) => s.environmentId !== environmentId),
        }));
        if (mode === "direct") await removeDirectMachine(db, environmentId);
        else await removeEnvironmentLocal(db, environmentId);
        invalidate();
        if (mode === "direct") void pull({ continuation: true });
      },
      async setReportingTimezone(tz) {
        if (!db) return;
        await setReportingTimezone(db, tz);
        setTzState(tz);
        invalidate();
      },
    };
  }, [db, mode, reportingTimezone, sync, stop, cancelActive, pull, refresh, queryClient, patchStatus]);

  return <AppContext.Provider value={value}>
    <SyncStatusContext.Provider value={status}>{children}</SyncStatusContext.Provider>
  </AppContext.Provider>;
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
