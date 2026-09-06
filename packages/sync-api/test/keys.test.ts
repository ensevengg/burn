import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { liveEventId, sha256HexUtf8 } from "../src/keys";

/**
 * The live-pull merge depends on this hash being byte-identical to Postgres
 * `encode(sha256(convert_to(s, 'utf8')), 'hex')`. node:crypto is the oracle.
 */
describe("sha256HexUtf8", () => {
  const vectors: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ];
  for (const [input, expected] of vectors) {
    test(`published vector: ${JSON.stringify(input.slice(0, 12))}`, () => {
      expect(sha256HexUtf8(input)).toBe(expected);
      expect(createHash("sha256").update(input, "utf8").digest("hex")).toBe(expected);
    });
  }

  test("matches node:crypto across lengths around block boundaries", () => {
    for (const length of [0, 1, 31, 32, 55, 56, 63, 64, 65, 111, 119, 120, 127, 128, 1000]) {
      const input = randomBytes(length).toString("hex");
      expect(sha256HexUtf8(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
  });

  test("matches node:crypto for multi-byte UTF-8 (client names, session ids)", () => {
    const inputs = [
      "claude|v1:claude:session|1",
      "zcode|v1:zcode:セッション-01|2",
      "opencode|v1:oe:\u00e9\u00fc\u4e2d\u6587|3",
      "pi|v1:pi:\ud83d\ude80\ud83d\udd25|4", // surrogate pairs
      "|client-with-empty-slug|5",
    ];
    for (const input of inputs) {
      expect(sha256HexUtf8(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
  });
});

describe("liveEventId", () => {
  test("mirrors the server recipe: slug | '|' | client | '|' | dedup_key", () => {
    const slug = "lenovo-windows";
    const client = "codex";
    const dedupKey = "v1:codex:abc123:1725600000000:1";
    expect(liveEventId(slug, client, dedupKey)).toBe(
      createHash("sha256").update(`${slug}|${client}|${dedupKey}`, "utf8").digest("hex"),
    );
  });

  test("empty client normalizes to 'unknown' exactly like the server's nullif", () => {
    const slug = "cachyos";
    const dedupKey = "v1:opencode:s:1:1";
    expect(liveEventId(slug, "", dedupKey)).toBe(liveEventId(slug, "unknown", dedupKey));
  });

  test("different slug, client, or dedup_key yields different ids", () => {
    const base = liveEventId("slug", "codex", "k");
    expect(base).not.toBe(liveEventId("slug2", "codex", "k"));
    expect(base).not.toBe(liveEventId("slug", "claude", "k"));
    expect(base).not.toBe(liveEventId("slug", "codex", "k2"));
  });
});
