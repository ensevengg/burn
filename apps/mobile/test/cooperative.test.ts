import { expect, test } from "bun:test";
import { runCooperatively } from "../src/lib/cooperative";

test("cancelled aggregation stops before consuming obsolete work", async () => {
  const controller = new AbortController();
  let consumed = 0;
  function* work(): Generator<void, number> {
    for (let i = 0; i < 1000; i++) {
      consumed++;
      yield;
    }
    return consumed;
  }
  const pending = runCooperatively(work(), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("Query cancelled");
  expect(consumed).toBe(0);
});
