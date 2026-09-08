import type { BurnBackend, MobileSyncApi } from "@burn/sync-api";
import type { ConnectionConfig } from "./settings";

export interface ConnectedPhone {
  config: ConnectionConfig;
  phone: MobileSyncApi;
}

/**
 * Keep decrypted connection material and its transport adapter in memory for
 * one connected app lifecycle. At-rest storage remains SecureStore; clear()
 * drops the reference before a backend switch or disconnect.
 */
export function createConnectionCache(
  load: () => Promise<ConnectionConfig | null>,
  backendFor: (config: ConnectionConfig) => BurnBackend,
): { get: () => Promise<ConnectedPhone | null>; clear: () => void } {
  let pending: Promise<ConnectedPhone | null> | null = null;
  return {
    get() {
      if (pending !== null) return pending;
      pending = load().then((config) =>
        config === null
          ? null
          : {
              config,
              phone: backendFor(config).phone(config.readToken),
            },
      );
      void pending.catch(() => {
        pending = null;
      });
      return pending;
    },
    clear() {
      pending = null;
    },
  };
}
