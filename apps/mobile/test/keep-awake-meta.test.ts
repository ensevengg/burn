import { expect, test } from "bun:test";
import { holdChoiceLabel, holdLeft } from "../src/lib/keep-awake-meta";

test("remaining hold time reads in hours and minutes", () => {
  const now = 1_000_000;
  expect(holdLeft(null, now)).toBeNull();
  expect(holdLeft(now - 1, now)).toBeNull();
  expect(holdLeft(now + 20_000, now)).toBe("<1m");
  expect(holdLeft(now + 45 * 60_000, now)).toBe("45m");
  expect(holdLeft(now + 60 * 60_000, now)).toBe("1h");
  expect(holdLeft(now + 72 * 60_000 - 500, now)).toBe("1h 12m");
  expect(holdChoiceLabel(240)).toBe("4h");
});
