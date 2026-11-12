/**
 * The release version lives in four places; this keeps them in step.
 *   bun scripts/release-version.ts check [version]   all agree (and equal version)
 *   bun scripts/release-version.ts set <version>     write them all
 * The Android versionCode follows the version (1.2.3 → 10203), so every
 * release installs over the previous one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const file = (path: string) => join(root, path);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
export function versionCode(version: string): number {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`"${version}" is not a plain x.y.z version`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error("minor and patch must stay below 100 for the versionCode");
  return major * 10_000 + minor * 100 + patch;
}

const REPORTER_SOURCE = "apps/reporter/src/tokscale.ts";
const REPORTER_CONSTANT = /export const REPORTER_VERSION = "([^"]+)";/;

function read(): Record<string, string> {
  const app = JSON.parse(readFileSync(file("apps/mobile/app.json"), "utf8")).expo;
  const json = (path: string) => JSON.parse(readFileSync(file(path), "utf8")).version as string;
  return {
    "apps/mobile/app.json": app.version,
    "apps/mobile/app.json versionCode": String(app.android?.versionCode ?? "missing"),
    "apps/mobile/package.json": json("apps/mobile/package.json"),
    "apps/reporter/package.json": json("apps/reporter/package.json"),
    [REPORTER_SOURCE]: REPORTER_CONSTANT.exec(readFileSync(file(REPORTER_SOURCE), "utf8"))?.[1] ?? "missing",
  };
}

function check(expected?: string): void {
  const fields = read();
  const version = expected ?? fields["apps/mobile/app.json"]!;
  const want: Record<string, string> = Object.fromEntries(Object.keys(fields).map((key) => [key, version]));
  want["apps/mobile/app.json versionCode"] = String(versionCode(version));
  const wrong = Object.keys(fields).filter((key) => fields[key] !== want[key]);
  for (const key of wrong) console.error(`${key}: ${fields[key]} (expected ${want[key]})`);
  if (wrong.length > 0) {
    console.error("Version fields disagree; run: bun scripts/release-version.ts set <version>");
    process.exit(1);
  }
  console.log(`version ${version} (versionCode ${want["apps/mobile/app.json versionCode"]})`);
}

function set(version: string): void {
  const code = versionCode(version);
  const appPath = file("apps/mobile/app.json");
  const app = JSON.parse(readFileSync(appPath, "utf8"));
  app.expo.version = version;
  app.expo.android.versionCode = code;
  writeFileSync(appPath, JSON.stringify(app, null, 2) + "\n");
  for (const path of ["apps/mobile/package.json", "apps/reporter/package.json"]) {
    const text = readFileSync(file(path), "utf8");
    writeFileSync(file(path), text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  }
  const source = readFileSync(file(REPORTER_SOURCE), "utf8");
  writeFileSync(file(REPORTER_SOURCE), source.replace(REPORTER_CONSTANT, `export const REPORTER_VERSION = "${version}";`));
  check(version);
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2);
  if (command === "check") check(version);
  else if (command === "set" && version) set(version);
  else {
    console.error("usage: bun scripts/release-version.ts check [version] | set <version>");
    process.exit(2);
  }
}
