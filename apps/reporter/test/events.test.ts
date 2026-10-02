import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TOKSCALE_PIN } from "@burn/sync-api";
import {
  costToDecimalString,
  deriveDedupKeys,
  exportRowsToMachineInputs,
  parseEventsJsonl,
} from "../src/events.js";
import { assertExporterMatchesPin } from "../src/exporter.js";
import { ExporterError } from "../src/exporter.js";

const fixtureText = readFileSync(join(import.meta.dir, "../fixtures/tokscale-events.jsonl"), "utf8");

describe("events jsonl", () => {
  test("fixture validates and keeps every row", () => {
    const rows = parseEventsJsonl(fixtureText);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.timestamp).toBeGreaterThan(0);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("invalid JSON fails loudly with the line number", () => {
    expect(() => parseEventsJsonl('{"client":"codex"\n')).toThrow(/line 1.*invalid JSON/);
  });

  test("schema drift fails loudly with the offending path (D2)", () => {
    const base = JSON.parse(fixtureText.split("\n")[0]!);
    base.timestamp = "not-a-number";
    expect(() => parseEventsJsonl(JSON.stringify(base))).toThrow(/line 1 schema drift at timestamp/);
  });
});

describe("machine payload mapping", () => {
  const rows = parseEventsJsonl(fixtureText);

  test("maps to MachineEventInput with pin-stamped parser version", () => {
    const inputs = exportRowsToMachineInputs(rows, TOKSCALE_PIN);
    expect(inputs).toHaveLength(6);
    const first = inputs[0]!;
    expect(first.client).toBe("zcode");
    expect(first.modelId).toBe("glm-4.6");
    expect(first.occurredAtMs).toBe(1778488773613);
    expect(first.sourceLocalDate).toBe("2026-05-11");
    expect(first.inputTokens).toBe(2152);
    expect(first.cacheReadTokens).toBe(16124);
    expect(first.cost).toBe("0.006065");
    expect(first.costSource).toBe("estimated");
    expect(first.costIsComplete).toBe(true);
    expect(first.parserVersion).toBe(`tokscale-${TOKSCALE_PIN}`);
    expect(first.dedupKey).toBe("tok-1001");
  });

  test("normalizes tokscale camelCase cost_source", () => {
    const inputs = exportRowsToMachineInputs(rows, TOKSCALE_PIN);
    expect(inputs[1]!.costSource).toBe("provider_reported");
  });

  test("unknown pricing and conflicted attribution are never cost-complete", () => {
    const inputs = exportRowsToMachineInputs(rows, TOKSCALE_PIN);
    expect(inputs[3]!.costSource).toBe("unknown");
    expect(inputs[3]!.costIsComplete).toBe(false);
    expect(inputs[5]!.modelAttributionConflicted).toBe(true);
    expect(inputs[5]!.costIsComplete).toBe(false);
  });

  test("decimal string costs pass through the D8 conversion", () => {
    const inputs = exportRowsToMachineInputs(rows, TOKSCALE_PIN);
    expect(inputs[5]!.cost).toBe("0.010000");
  });

  test("costToDecimalString rejects non-numeric input", () => {
    expect(costToDecimalString(0.00308)).toBe("0.003080");
    expect(costToDecimalString("0.01")).toBe("0.010000");
    expect(() => costToDecimalString("free")).toThrow(/non-numeric cost/);
  });
});

describe("dedup fallback (D2)", () => {
  test("fills v1 keys for null and empty dedup_keys", () => {
    const rows = parseEventsJsonl(fixtureText);
    deriveDedupKeys(rows);
    expect(rows[3]!.dedup_key).toBe(`v1:warp:sess-delta:1778491446420:1`);
    expect(rows[4]!.dedup_key).toBe(`v1:opencode:sess-epsilon:1778491451030:1`);
  });

  test("derived key set is stable regardless of input order", () => {
    const forward = parseEventsJsonl(fixtureText);
    const shuffled = parseEventsJsonl(fixtureText).reverse();
    deriveDedupKeys(forward);
    deriveDedupKeys(shuffled);
    const signature = (row: (typeof forward)[number]) =>
      `${row.timestamp}|${row.model_id}|${row.cost}`;
    const bySignature = (rows: typeof forward) =>
      new Map(rows.filter((r) => r.dedup_key?.startsWith("v1:")).map((r) => [signature(r), r.dedup_key]));
    expect(bySignature(shuffled)).toEqual(bySignature(forward));
  });
});

describe("exporter pin guard", () => {
  test("mismatch fails loudly with the rebuild hint", () => {
    expect(assertExporterMatchesPin("4.15.1", "4.15.1")).toBeUndefined();
    expect(() => assertExporterMatchesPin("4.14.0", "4.15.1")).toThrow(ExporterError);
    expect(() => assertExporterMatchesPin("4.14.0", "4.15.1")).toThrow(/cargo install/);
  });

  test("exporter crate stays in lockstep with the tokscale pin (D2)", () => {
    const manifest = readFileSync(
      join(import.meta.dir, "../../../crates/burn-events/Cargo.toml"),
      "utf8",
    );
    expect(manifest).toContain(`version = "${TOKSCALE_PIN}"`);
    expect(manifest).toContain(`tag = "v${TOKSCALE_PIN}"`);
  });
});
