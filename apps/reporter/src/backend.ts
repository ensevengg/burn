import { createBurnBackend, type BurnBackend, type ReporterSyncApi } from "@burn/sync-api";
import type { BurnConfig } from "./config";

export function backendFor(config: BurnConfig): BurnBackend {
  return createBurnBackend({ url: config.supabaseUrl, publishableKey: config.publishableKey });
}

export function reporterApiFor(config: BurnConfig, backend?: BurnBackend): ReporterSyncApi {
  return (backend ?? backendFor(config)).reporter(config.ingestToken);
}
