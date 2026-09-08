import { expect, test } from "bun:test";
import type { BurnBackend, MobileSyncApi } from "@burn/sync-api";
import { createConnectionCache } from "../src/lib/connection-cache";

const phone: MobileSyncApi = {
  fetchDelta: async () => ({ environments: [], events: [], maxRevision: 0, hasMore: false }),
  fetchQuotaLatest: async () => [],
  requestSync: async () => ({ generation: 1 }),
  removeEnvironment: async () => ({ removedSlug: "windows" }),
};

test("connected phone cache reads SecureStore and creates its backend once per lifecycle", async () => {
  let loads = 0;
  let backends = 0;
  const config = {
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key",
    readToken: "read-token",
  };
  const cache = createConnectionCache(
    async () => {
      loads += 1;
      return config;
    },
    () => {
      backends += 1;
      return { phone: () => phone } as BurnBackend;
    },
  );

  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  expect(first?.phone).toBe(phone);
  expect(second).toBe(first);
  expect({ loads, backends }).toEqual({ loads: 1, backends: 1 });

  cache.clear();
  expect((await cache.get())?.phone).toBe(phone);
  expect({ loads, backends }).toEqual({ loads: 2, backends: 2 });
});
