import { expect, test } from "bun:test";
import type { BurnBackend, MobileSyncApi } from "@burn/sync-api";
import { createConnectionCache } from "../src/lib/connection-cache";

const phone: MobileSyncApi = {
  fetchDelta: async () => ({ cursorVersion: 2, environments: [], events: [], maxRevision: 0, hasMore: false }),
  fetchQuotaLatest: async () => [],
  requestSync: async () => ({ generation: 1 }),
  removeEnvironment: async () => ({ removedSlug: "windows" }),
};

test("a cleared stale failure cannot evict the replacement connection", async () => {
  let rejectFirst!: (error: Error) => void;
  let loads = 0;
  const config = {
    url: "https://example.supabase.co",
    publishableKey: "publishable-key",
    readToken: "read-token",
  };
  const cache = createConnectionCache(
    () => {
      loads += 1;
      if (loads === 1) {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve(config);
    },
    () => ({ phone: () => phone }) as BurnBackend,
  );

  const stale = cache.get().catch(() => null);
  cache.clear();
  const replacement = await cache.get();
  rejectFirst(new Error("old SecureStore read failed"));
  await stale;

  expect((await cache.get())).toBe(replacement);
  expect(loads).toBe(2);
});

test("connected phone cache reads SecureStore and creates its backend once per lifecycle", async () => {
  let loads = 0;
  let backends = 0;
  const config = {
    url: "https://example.supabase.co",
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
