import {
  createBurnBackend,
  type BurnBackend,
  type ReporterSyncApi,
} from "@burn/sync-api";
import type { BurnConfig } from "./config";

export function backendFor(config: BurnConfig): BurnBackend {
  if (!config.supabaseUrl || !config.publishableKey)
    throw new Error(
      "Cloud backup is not configured; use serve for direct mode",
    );
  return createBurnBackend({
    url: config.supabaseUrl,
    publishableKey: config.publishableKey,
  });
}

export function reporterApiFor(
  config: BurnConfig,
  backend?: BurnBackend,
): ReporterSyncApi {
  if (!config.ingestToken) throw new Error("No cloud ingest token configured");
  return (backend ?? backendFor(config)).reporter(config.ingestToken);
}
