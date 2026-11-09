import { expect, test } from "bun:test";
import { fanFraction, formatRpm, modeMeta, orderModes, rotorPeriodMs } from "../src/lib/power-mode-meta";

test("mode ids never render raw", () => {
  expect(modeMeta("power-saver").label).toBe("Power Saver");
  expect(modeMeta("max-power").label).toBe("Max Power");
  expect(modeMeta("balanced").glyph).toBe("balance");
  // Unknown vendor vocabulary still reads as words, with a neutral glyph.
  expect(modeMeta("turbo-boost")).toMatchObject({ label: "Turbo Boost", glyph: "dot" });
});

test("modes order coolest to hottest, unknown last in their own order", () => {
  expect(orderModes(["performance", "balanced", "power-saver"])).toEqual(["power-saver", "balanced", "performance"]);
  expect(orderModes(["zeta", "max-power", "alpha", "low-power"])).toEqual(["low-power", "max-power", "zeta", "alpha"]);
});

test("heat rises with the mode", () => {
  const heats = ["power-saver", "balanced", "performance", "max-power"].map((mode) => modeMeta(mode).heat);
  expect(heats).toEqual([...heats].sort((a, b) => a - b));
});

test("fan gauges use the rated maximum when known", () => {
  expect(fanFraction(2_550, 5_100)).toBe(0.5);
  expect(fanFraction(9_000, 5_100)).toBe(1);
  expect(fanFraction(3_000, null)).toBe(0.5);
  expect(fanFraction(0, 5_100)).toBe(0);
  expect(fanFraction(Number.NaN, 5_100)).toBe(0);
});

test("rotor speed stays readable and stops with the fan", () => {
  expect(rotorPeriodMs(0, 5_100)).toBeNull();
  const slow = rotorPeriodMs(500, 5_100)!;
  const fast = rotorPeriodMs(5_100, 5_100)!;
  expect(fast).toBe(350);
  expect(slow).toBeGreaterThan(fast);
  expect(slow).toBeLessThanOrEqual(2_400);
});

test("rpm formatting groups thousands", () => {
  expect(formatRpm(4300)).toBe("4,300 rpm");
  expect(formatRpm(812.6)).toBe("813 rpm");
});
