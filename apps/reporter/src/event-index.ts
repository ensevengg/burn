import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
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

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const isNonempty = (error: unknown) =>
  ["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Atomically publish a nonempty owner directory. rename cannot replace another
 * nonempty directory; stale cleanup removes only its unique owner filename,
 * then rmdir refuses to delete any newly acquired nonempty lock. */
function createProcessLock(path: string): () => void {
  const name = `owner-${process.pid}-${randomUUID()}`;
  const temp = `${path}.${name}.tmp`;
  mkdirSync(temp, { mode: 0o700 });
  try {
    writeFileSync(join(temp, name), "", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return () => {
    try {
      unlinkSync(join(path, name));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    try {
      rmdirSync(path);
    } catch (error) {
      if (!isMissing(error) && !isNonempty(error)) throw error;
    }
  };
}

function isDead(pid: number, path: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(
      `Invalid push lock at ${path}; inspect it before removing it`,
    );
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function recoverDeadLock(path: string): boolean {
  try {
    const info = statSync(path);
    if (info.isDirectory()) {
      const names = readdirSync(path);
      if (names.length === 0) {
        // Legacy/interrupted cleanup only: new locks publish with their owner.
        if (Date.now() - info.mtimeMs < 30_000) return false;
      } else {
        const match =
          names.length === 1
            ? /^owner-(\d+)-[a-f0-9-]{36}$/.exec(names[0]!)
            : null;
        if (!match)
          throw new Error(
            `Invalid push lock at ${path}; inspect it before removing it`,
          );
        if (!isDead(Number(match[1]), path)) return false;
        try {
          unlinkSync(join(path, names[0]!));
        } catch (error) {
          if (isMissing(error)) return true;
          throw error;
        }
      }
      try {
        rmdirSync(path);
      } catch (error) {
        if (!isMissing(error) && !isNonempty(error)) throw error;
      }
      return true;
    }
    // Upgrade from PID-file locks. New lock directories cannot be unlinked by
    // racing legacy-file cleanup, and old recovery guard files are unused.
    const contents = readFileSync(path, "utf8");
    if (!contents.trim()) {
      if (Date.now() - info.mtimeMs < 30_000) return false;
    } else {
      let pid: number;
      try {
        pid = contents.startsWith("{")
          ? Number(JSON.parse(contents).pid)
          : Number(contents);
      } catch {
        throw new Error(
          `Invalid push lock at ${path}; inspect it before removing it`,
        );
      }
      if (!isDead(pid, path)) return false;
    }
    try {
      unlinkSync(path);
    } catch (error) {
      if (
        !isMissing(error) &&
        (error as NodeJS.ErrnoException).code !== "EISDIR" &&
        (error as NodeJS.ErrnoException).code !== "EPERM"
      )
        throw error;
    }
    return true;
  } catch (error) {
    if (
      isMissing(error) ||
      ["EISDIR", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return true;
    throw error;
  }
}

/** Cron and daemon pushes serialize their acknowledgement index. The owner
 * directory recovers dead processes without a second, potentially stale guard. */
export function lockPush(config: BurnConfig): () => void {
  const path = `${indexPath(config)}.lock`;
  mkdirSync(configDir(), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return createProcessLock(path);
    } catch (error) {
      // POSIX returns ENOTEMPTY for directories, ENOTDIR for legacy files;
      // Windows may return EEXIST/EPERM when rename encounters an existing lock.
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        !["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(code) &&
        !(code === "EPERM" && existsSync(path))
      )
        throw error;
    }
    if (!recoverDeadLock(path))
      throw new Error(
        "Another reporter push is still running; retry after it finishes",
      );
  }
  throw new Error("Could not acquire reporter push lock; retry later");
}
