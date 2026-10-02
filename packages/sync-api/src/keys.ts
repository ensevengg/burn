import type { CostSource } from "./types";

/** Idempotent mirror keys (keep definitions here, not at call sites).
 *
 * usage_events.event_id = sha256(environment_slug | client | dedup_key).
 * Tokscale's dedup key is authoritative. Where absent, the D2 exporter derives
 * v1:<client>:<session_id>:<source_ts_ms>:<ordinal>. Parser/pricing corrections
 * replace content under the same event id during full reconciliation.
 *
 * quota_snapshots = environment/provider/account/metric/status. Preserve the
 * source collection time; newer samples replace older samples, and success
 * and error channels remain separate. UI freshness is account-level.
 *
 * environments and direct_machines: natural key = slug. WSL and Windows use
 * distinct slugs and may share a host_group.
 */

export function eventIdentityDescription(): string {
  return "sha256(environment_slug | client | dedup_key)";
}

/** Stable SHA-256 identity, verified against node:crypto in keys.test.ts. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** UTF-8 bytes without TextEncoder (Hermes-safe); surrogate pairs included. */
function utf8Bytes(input: string): Uint8Array {
  const out = new Uint8Array(input.length * 4);
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out[n++] = code;
    else if (code < 0x800) {
      out[n++] = 0xc0 | (code >> 6);
      out[n++] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      out[n++] = 0xe0 | (code >> 12);
      out[n++] = 0x80 | ((code >> 6) & 63);
      out[n++] = 0x80 | (code & 63);
    } else {
      out[n++] = 0xf0 | (code >> 18);
      out[n++] = 0x80 | ((code >> 12) & 63);
      out[n++] = 0x80 | ((code >> 6) & 63);
      out[n++] = 0x80 | (code & 63);
    }
  }
  return out.subarray(0, n);
}

/** Lowercase hex SHA-256 over UTF-8 bytes — no runtime dependencies. */
export function sha256HexUtf8(input: string): string {
  const message = utf8Bytes(input);
  const bitLength = message.length * 8;
  const blocks = ((message.length + 8) >> 6) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const wm15 = w[i - 15]!;
      const wm2 = w[i - 2]!;
      const s0 = rotr(wm15, 7) ^ rotr(wm15, 18) ^ (wm15 >>> 3);
      const s1 = rotr(wm2, 17) ^ rotr(wm2, 19) ^ (wm2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** Stable per-message identity across machines scans and application upgrades. */
export function liveEventId(environmentSlug: string, client: string, dedupKey: string): string {
  const normalizedClient = client.length > 0 ? client : "unknown";
  return sha256HexUtf8(`${environmentSlug}|${normalizedClient}|${dedupKey}`);
}

/** Quota account key: stable per provider account. Falls back safely. */
export function quotaAccountKey(providerAccountId: string | null | undefined): string {
  const trimmed = providerAccountId?.trim();
  return trimmed ? trimmed : "no-account";
}

/** Metric label derived from a tokscale usage metric row. */
export function quotaMetricLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_") || "unknown";
}

export function normalizeCostSource(raw: string | null | undefined): CostSource {
  switch (raw) {
    case "provider_reported":
    case "providerReported":
      return "provider_reported";
    case "estimated":
      return "estimated";
    default:
      return "unknown";
  }
}

/** Mirror snapshots retain last-success and last-error independently. Identity
 * is environment/provider/account/metric/channel; collection time gates updates. */
export function quotaMirrorKey(
  environmentId: string | null,
  provider: string,
  account: string,
  metric: string,
  status: "ok" | "error",
): string {
  return JSON.stringify([environmentId, provider, account, metric, status]);
}
