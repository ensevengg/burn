import { randomBytes, createHash } from "node:crypto";

/**
 * Scoped tokens (D7): random URL-safe strings; only sha256 hex reaches the
 * database. The same sha256-hex recipe must match burn_api's
 * encode(sha256(convert_to(token,'utf8')),'hex').
 */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
