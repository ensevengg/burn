import { expect, test } from "bun:test";
import type { Alert } from "react-native";
import { confirmDestructive } from "../src/lib/confirm-destructive";

function fixture(action: () => Promise<void>) {
  const calls: Parameters<typeof Alert.alert>[] = [];
  confirmDestructive(
    {
      alert: (...args) => {
        calls.push(args);
      },
    },
    "Remove?",
    "Data will be removed.",
    action,
  );
  return { calls, buttons: calls[0]![2]!, options: calls[0]![3]! };
}

test("destructive confirmation requires Yes; cancel and native dismissal perform no action", async () => {
  for (const cancel of ["Cancel", "dismiss"] as const) {
    let writes = 0;
    const f = fixture(async () => {
      writes++;
    });
    expect(f.buttons.map((b) => b.text)).toEqual(["Cancel", "Yes"]);
    expect(writes).toBe(0);
    if (cancel === "Cancel") f.buttons[0]!.onPress!();
    else f.options.onDismiss!();
    f.buttons[1]!.onPress!();
    await Promise.resolve();
    expect(writes).toBe(0);
  }
});

test("Yes performs the destructive action exactly once and reports failures", async () => {
  let writes = 0;
  const f = fixture(async () => {
    writes++;
    throw new Error("backend offline");
  });
  f.buttons[1]!.onPress!();
  f.buttons[1]!.onPress!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toBe(1);
  expect(f.calls[1]?.slice(0, 2)).toEqual(["Action failed", "backend offline"]);
});
