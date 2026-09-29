import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IngestEventInput } from "@burn/sync-api";
import { atomicJson, configDir, cursorScope, type BurnConfig } from "./config";

export const indexPath = (config: BurnConfig) =>
  join(configDir(), `events-${cursorScope(config)}.json`);
export function eventFingerprint(event: IngestEventInput): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}
export const eventIndexKey = (event: IngestEventInput) =>
  JSON.stringify([event.client, event.dedupKey]);
export function loadEventIndex(config: BurnConfig): Record<string, string> {
  const path = indexPath(config);
  return existsSync(path)
    ? z
        .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
        .parse(JSON.parse(readFileSync(path, "utf8")))
    : {};
}
export function saveEventIndex(
  config: BurnConfig,
  index: Record<string, string>,
): void {
  atomicJson(indexPath(config), index);
}

/** A cron process and a resident daemon must not race the acknowledgement
 * index. Live reads remain independent. Dead processes leave recoverable locks. */
export function lockPush(config: BurnConfig): () => void {
  const path = `${indexPath(config)}.lock`;
  // Ensure the config directory exists without changing config contents.
  mkdirSync(configDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = `${path}.recovery`;
      let guard: number;
      try {
        guard = openSync(recovery, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            `Push lock recovery in progress at ${recovery}; retry later`,
          );
        throw err;
      }
      try {
        if (!existsSync(path)) continue;
        const pid = Number(readFileSync(path, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error(
            `Invalid push lock at ${path}; inspect it before removing it`,
          );
        try {
          process.kill(pid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            unlinkSync(path);
            continue;
          }
          throw err;
        }
        throw new Error(
          "Another reporter push is still running; retry after it finishes",
        );
      } finally {
        closeSync(guard);
        unlinkSync(recovery);
      }
    }
  }
  throw new Error("Could not acquire reporter push lock");
}
