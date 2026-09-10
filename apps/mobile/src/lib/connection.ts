import { createBurnBackend } from "@burn/sync-api";
import { createConnectionCache } from "./connection-cache";
import { loadConnection } from "./settings";

const connectedPhone = createConnectionCache(loadConnection, createBurnBackend);

export const loadConnectedPhone = connectedPhone.get;
export const clearConnectedPhone = connectedPhone.clear;
