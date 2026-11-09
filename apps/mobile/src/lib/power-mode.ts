/**
 * Live power-mode control (ADR 0004). Unlike usage data this is never
 * mirrored: a stale mode must not be shown as current, and nothing is queued
 * for an offline machine. Reads poll only while the Systems screen is
 * focused; writes are optimistic and roll back on refusal.
 */
import { httpLiveApiFor, type PowerModeState } from "@burn/sync-api";
import { useIsFocused } from "@react-navigation/native";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { withTimeout } from "./transport";

export interface ControlledMachine {
  environmentId: string;
  endpoint: string;
}

const POLL_MS = 3_000;
const READ_TIMEOUT_MS = 5_000;
/** Covers the daemon applying and the reporter's read-back. */
const WRITE_TIMEOUT_MS = 12_000;

export const powerModeKey = (environmentId: string) => ["power-mode", environmentId] as const;

async function withDeadline<T>(
  signal: AbortSignal | undefined,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = withTimeout(signal, ms);
  try {
    return await run(timeout.signal);
  } finally {
    timeout.cancel();
  }
}

export function usePowerMode(machine: ControlledMachine, enabled: boolean) {
  const focused = useIsFocused();
  const writing = useIsMutating({ mutationKey: powerModeKey(machine.environmentId) }) > 0;
  return useQuery({
    queryKey: powerModeKey(machine.environmentId),
    queryFn: ({ signal }) =>
      withDeadline(signal, READ_TIMEOUT_MS, (deadline) =>
        httpLiveApiFor(machine.endpoint).powerMode!(deadline),
      ),
    enabled: enabled && focused,
    // Paused during a write so a read cannot overwrite the optimistic mode.
    refetchInterval: enabled && focused && !writing ? POLL_MS : false,
    staleTime: 0,
    retry: false,
  });
}

export function useSetPowerMode(machine: ControlledMachine) {
  const queryClient = useQueryClient();
  const key = powerModeKey(machine.environmentId);
  return useMutation({
    mutationKey: key,
    mutationFn: (mode: string) =>
      withDeadline(undefined, WRITE_TIMEOUT_MS, (deadline) =>
        httpLiveApiFor(machine.endpoint).setPowerMode!(mode, deadline),
      ),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PowerModeState>(key);
      if (previous) queryClient.setQueryData<PowerModeState>(key, { ...previous, mode });
      return { previous };
    },
    onError: (_error, _mode, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      // The machine may have moved anyway (e.g. timed out after applying).
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: (state) => {
      queryClient.setQueryData(key, state);
    },
  });
}
