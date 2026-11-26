/**
 * Live keep-awake control (ADR 0007). Like power mode it is never mirrored
 * and nothing is queued for an offline machine: reads poll only while Systems
 * is focused, and writes show the new deadline at once, rolling back if the
 * machine refuses.
 */
import { httpLiveApiFor, type KeepAwakeState } from "@burn/sync-api";
import { useIsFocused } from "@react-navigation/native";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ControlledMachine } from "./power-mode";
import { withTimeout } from "./transport";

/** The deadline only changes when someone sets it; a slow poll is enough to
 * notice a hold that ended early or was changed from another phone. */
const POLL_MS = 15_000;
const TIMEOUT_MS = 6_000;

export const keepAwakeKey = (environmentId: string) => ["keep-awake", environmentId] as const;

async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const timeout = withTimeout(signal, ms);
  try {
    return await run(timeout.signal);
  } finally {
    timeout.cancel();
  }
}

export function useKeepAwake(machine: ControlledMachine, enabled: boolean) {
  const focused = useIsFocused();
  const writing = useIsMutating({ mutationKey: keepAwakeKey(machine.environmentId) }) > 0;
  return useQuery({
    queryKey: keepAwakeKey(machine.environmentId),
    queryFn: ({ signal }) =>
      withDeadline(TIMEOUT_MS, (deadline) => httpLiveApiFor(machine.endpoint).keepAwake!(deadline), signal),
    enabled: enabled && focused,
    refetchInterval: enabled && focused && !writing ? POLL_MS : false,
    refetchOnWindowFocus: !writing,
    staleTime: 0,
    retry: false,
  });
}

export function useSetKeepAwake(machine: ControlledMachine) {
  const queryClient = useQueryClient();
  const key = keepAwakeKey(machine.environmentId);
  return useMutation({
    mutationKey: key,
    mutationFn: (minutes: number) =>
      withDeadline(TIMEOUT_MS, (deadline) => httpLiveApiFor(machine.endpoint).setKeepAwake!(minutes, deadline)),
    onMutate: async (minutes) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<KeepAwakeState>(key);
      if (previous)
        queryClient.setQueryData<KeepAwakeState>(key, {
          ...previous,
          until: minutes === 0 ? null : new Date(Date.now() + minutes * 60_000).toISOString(),
        });
      return { previous };
    },
    onError: (_error, _minutes, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: (state) => {
      queryClient.setQueryData(key, state);
    },
  });
}
