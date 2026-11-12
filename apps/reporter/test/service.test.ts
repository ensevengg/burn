import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyUnits, serviceEnv, windowsArg, windowsInstallScript, windowsLauncher, windowsUninstallScript,
} from "../src/service.js";

describe("install-service", () => {
  test("the service keeps the shell's tools without bun run's package-local or temporary PATH entries", () => {
    const env = serviceEnv(
      {
        PATH: ["/repo/node_modules/.bin", join(tmpdir(), "bun-node-1"), "/usr/bin", "/home/me/.cargo/bin", "/usr/bin"].join(":"),
        BURN_CONFIG_DIR: "relative/config",
        BURN_EVENTS_BIN: "burn-events-dev",
      },
      "/home/me/.bun/bin/bun",
    );
    expect(env["PATH"]).toBe("/home/me/.bun/bin:/usr/bin:/home/me/.cargo/bin");
    expect(env["BURN_CONFIG_DIR"]).toBe(join(process.cwd(), "relative/config"));
    expect(env["BURN_EVENTS_BIN"]).toBe("burn-events-dev");
    expect(serviceEnv({ PATH: "/usr/bin" }, "/usr/bin/bun")).toEqual({ PATH: "/usr/bin" });
  });

  test("Windows launchers quote arguments and PowerShell strings", () => {
    expect(windowsArg("daemon")).toBe("daemon");
    expect(windowsArg("C:\\Users\\Jo Doe\\index.ts")).toBe('"C:\\Users\\Jo Doe\\index.ts"');
    expect(windowsArg("C:\\a dir\\")).toBe('"C:\\a dir\\\\"');
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsArg("")).toBe('""');
    const script = windowsLauncher(
      "burn-report",
      "C:\\Users\\O'Neil\\AppData\\Roaming\\burn",
      "C:\\Users\\O'Neil\\.bun\\bin\\bun.exe",
      ["C:\\code\\my burn\\apps\\reporter\\src\\index.ts", "daemon"],
      { PATH: "C:\\Users\\O'Neil\\.bun\\bin", BURN_CONFIG_DIR: "D:\\burn" },
    );
    expect(script).toContain("New-Object System.Threading.Mutex($false, 'Local\\burn-report')");
    expect(script).toContain("$env:PATH = 'C:\\Users\\O''Neil\\.bun\\bin;' + $env:PATH");
    expect(script).toContain("$env:BURN_CONFIG_DIR = 'D:\\burn'");
    expect(script).toContain(
      "Start-Process -FilePath 'C:\\Users\\O''Neil\\.bun\\bin\\bun.exe' -ArgumentList '\"C:\\code\\my burn\\apps\\reporter\\src\\index.ts\" daemon' -NoNewWindow -Wait",
    );
    expect(script).toContain("-RedirectStandardError 'C:\\Users\\O''Neil\\AppData\\Roaming\\burn\\burn-report.err.log'");
    expect(script).toContain("Start-Sleep -Seconds 10");
  });

  test("Windows registration replaces running launchers/daemons, never the installer, and starts hidden", () => {
    const launcher = "C:\\Users\\Jo Doe\\AppData\\Roaming\\burn\\burn-report.ps1";
    const install = windowsInstallScript("burn-report", launcher, "C:\\burn\\burn-report.exe");
    expect(install).toContain("$_.ProcessId -ne $PID");
    expect(install).toContain("$_.CommandLine.Contains('C:\\burn\\burn-report.exe')");
    expect(install).toContain("$_.CommandLine -match ' (daemon|serve)( |$)'");
    expect(install).toContain(
      "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'burn-report' " +
        "-Value 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\\Users\\Jo Doe\\AppData\\Roaming\\burn\\burn-report.ps1\"'",
    );
    expect(install).toContain("Start-Process -FilePath powershell.exe -WindowStyle Hidden");
    const uninstall = windowsUninstallScript("burn-report", launcher, "C:\\burn\\burn-report.exe");
    expect(uninstall).toContain("Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'burn-report'");
    expect(uninstall).not.toContain("Start-Process");
  });

  test("older hand-written reporter units are found so they cannot hold the port", () => {
    const dir = mkdtempSync(join(tmpdir(), "burn-units-"));
    writeFileSync(join(dir, "burn-report-daemon.service"), "[Service]\nWorkingDirectory=/code/burn/apps/reporter\nExecStart=/bun src/index.ts daemon --no-live\n");
    writeFileSync(join(dir, "burn-report-serve.service"), "[Service]\nExecStart=/bun /code/burn/apps/reporter/src/index.ts serve --bind 127.0.0.1\n");
    writeFileSync(join(dir, "burn-report.service"), "[Service]\nExecStart=/bun /code/burn/apps/reporter/src/index.ts daemon\n");
    writeFileSync(join(dir, "syncthing.service"), "[Service]\nExecStart=/usr/bin/syncthing serve\n");
    expect(legacyUnits(dir).sort()).toEqual(["burn-report-daemon.service", "burn-report-serve.service"]);
    expect(legacyUnits(join(dir, "missing"))).toEqual([]);
  });
});
