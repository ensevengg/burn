import { describe, expect, test } from "bun:test";
import { withWriteLock } from "../src/lib/writelock";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withWriteLock", () => {
  test("serializes overlapping writers in call order", async () => {
    const events: string[] = [];
    const a = withWriteLock(async () => {
      events.push("a:start");
      await delay(15);
      events.push("a:end");
    });
    const b = withWriteLock(async () => {
      events.push("b:start");
      await delay(5);
      events.push("b:end");
    });
    const c = withWriteLock(async () => {
      events.push("c:start");
      events.push("c:end");
    });
    await Promise.all([a, b, c]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("a rejected task reaches its caller but never poisons the queue", async () => {
    await expect(
      withWriteLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const value = await withWriteLock(async () => "recovered");
    expect(value).toBe("recovered");
  });

  test("passes through the task's value", async () => {
    const value = await withWriteLock(async () => 41 + 1);
    expect(value).toBe(42);
  });
});
