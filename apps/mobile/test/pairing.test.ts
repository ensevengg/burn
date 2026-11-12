import { describe, expect, test } from "bun:test";
import { parsePairingCode } from "../src/lib/pairing";

describe("pairing codes", () => {
  test("reads the link burn-report pair prints", () => {
    expect(parsePairingCode("burn://add?url=http%3A%2F%2F100.64.0.7%3A8788")).toBe("http://100.64.0.7:8788");
    expect(parsePairingCode("  burn://add/?url=http%3A%2F%2Fcachyos%3A8787\n")).toBe("http://cachyos:8787");
  });

  test("accepts a plain machine URL", () => {
    expect(parsePairingCode("https://box.tail1234.ts.net")).toBe("https://box.tail1234.ts.net");
  });

  test("ignores anything else", () => {
    expect(parsePairingCode("hello")).toBeNull();
    expect(parsePairingCode("burn://add")).toBeNull();
    expect(parsePairingCode("burn://add?url=ftp%3A%2F%2Fx")).toBeNull();
    expect(parsePairingCode("burn://remove?url=http%3A%2F%2Fx")).toBeNull();
    expect(parsePairingCode("javascript:alert(1)")).toBeNull();
  });
});
