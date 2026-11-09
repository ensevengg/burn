import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlError,
  PowerModeController,
  detectPowerModeDriver,
  parseProfilesList,
  platformProfile,
  powerProfilesDaemon,
  readFans,
  sortModes,
  type PowerModeDriver,
} from "../src/power-mode.js";
import { polkitRule } from "../src/commands.js";

// Captured from power-profiles-daemon 0.30 on a Lenovo 83LT.
const PPD_LIST = `  performance:
    CpuDriver:\tamd_pstate
    PlatformDriver:\tplatform_profile
    Degraded:   no

* balanced:
    CpuDriver:\tamd_pstate
    PlatformDriver:\tplatform_profile

  power-saver:
    CpuDriver:\tamd_pstate
    PlatformDriver:\tplatform_profile
`;

describe("power-profiles-daemon", () => {
  test("parses the active profile and orders modes coolest first", () => {
    expect(parseProfilesList(PPD_LIST)).toEqual({
      mode: "balanced",
      modes: ["power-saver", "balanced", "performance"],
      degraded: null,
    });
  });

  test("surfaces a degraded reason", () => {
    const degraded = PPD_LIST.replace("Degraded:   no", "Degraded:   lap-detected");
    expect(parseProfilesList(degraded).degraded).toBe("lap-detected");
  });

  test("unknown vocabularies sort after known ones without being dropped", () => {
    expect(sortModes(["turbo", "max-power", "quiet", "balanced"])).toEqual(["quiet", "balanced", "max-power", "turbo"]);
  });

  test("polkit denial becomes an actionable 403", async () => {
    const driver = powerProfilesDaemon(async () => {
      throw new Error("GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Not authorized");
    });
    const err = await driver.set("performance").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).status).toBe(403);
    expect((err as Error).message).toContain("polkit-rule");
  });

  test("set passes the mode as one argument, never through a shell", async () => {
    const calls: string[][] = [];
    await powerProfilesDaemon(async (command, args) => {
      calls.push([command, ...args]);
      return "";
    }).set("performance");
    expect(calls).toEqual([["powerprofilesctl", "set", "performance"]]);
  });
});

function sysRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "burn-sys-"));
  mkdirSync(join(root, "firmware/acpi"), { recursive: true });
  writeFileSync(join(root, "firmware/acpi/platform_profile"), "balanced\n");
  writeFileSync(join(root, "firmware/acpi/platform_profile_choices"), "low-power balanced performance max-power custom\n");
  return root;
}

describe("kernel platform_profile", () => {
  test("reads choices without custom and writes the selected mode", async () => {
    const root = sysRoot();
    const driver = platformProfile(root);
    expect(await driver.read()).toEqual({
      mode: "balanced",
      modes: ["low-power", "balanced", "performance", "max-power"],
      degraded: null,
    });
    await driver.set("performance");
    expect(readFileSync(join(root, "firmware/acpi/platform_profile"), "utf8")).toBe("performance");
  });

  test("detection prefers the daemon and falls back to the kernel file", async () => {
    const root = sysRoot();
    const working = await detectPowerModeDriver({ os: "linux", root, run: async () => PPD_LIST });
    expect(working?.backend).toBe("power-profiles-daemon");
    const fallback = await detectPowerModeDriver({
      os: "linux",
      root,
      run: async () => {
        throw new Error("spawn powerprofilesctl ENOENT");
      },
    });
    expect(fallback?.backend).toBe("platform-profile");
    expect(await detectPowerModeDriver({ os: "win32", root, run: async () => PPD_LIST })).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), "burn-sys-"));
    expect(await detectPowerModeDriver({ os: "linux", root: empty, run: async () => "" })).toBeNull();
  });
});

function hwmon(root: string, name: string, chip: string, fans: Record<string, string>): void {
  const real = join(root, "devices", chip);
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "name"), `${chip}\n`);
  for (const [file, value] of Object.entries(fans)) writeFileSync(join(real, file), `${value}\n`);
  mkdirSync(join(root, "class/hwmon"), { recursive: true });
  symlinkSync(real, join(root, "class/hwmon", name));
}

describe("fans", () => {
  test("duplicate drivers for the same fans collapse to the one with maxima", async () => {
    const root = mkdtempSync(join(tmpdir(), "burn-sys-"));
    hwmon(root, "hwmon6", "yogafan", { fan1_input: "0", fan2_input: "0" });
    hwmon(root, "hwmon9", "lenovo_wmi_other", {
      fan1_input: "3000",
      fan1_max: "5100",
      fan2_input: "2900",
      fan2_max: "5100",
    });
    hwmon(root, "hwmon4", "amdgpu", { temp1_input: "40000" });
    expect(await readFans(root)).toEqual([
      { label: "Fan 1", rpm: 3000, maxRpm: 5100 },
      { label: "Fan 2", rpm: 2900, maxRpm: 5100 },
    ]);
  });

  test("labels win, distinct chips stay, junk readings are skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "burn-sys-"));
    hwmon(root, "hwmon1", "nct6775", { fan1_input: "900", fan2_input: "1100", fan3_input: "garbage" });
    hwmon(root, "hwmon2", "amdgpu", { fan1_input: "1500", fan1_label: "GPU", fan1_max: "0" });
    expect(await readFans(root)).toEqual([
      { label: "Fan 1", rpm: 900, maxRpm: null },
      { label: "Fan 2", rpm: 1100, maxRpm: null },
      { label: "GPU", rpm: 1500, maxRpm: null },
    ]);
    expect(await readFans(join(root, "missing"))).toEqual([]);
  });
});

function fakeDriver(initial = "balanced", settleAfter = 0) {
  let mode = initial;
  let pending: string | null = null;
  let reads = 0;
  const sets: string[] = [];
  const driver: PowerModeDriver = {
    backend: "power-profiles-daemon",
    read: async () => {
      reads++;
      if (pending !== null && reads > settleAfter) {
        mode = pending;
        pending = null;
      }
      return { mode, modes: ["power-saver", "balanced", "performance"], degraded: null };
    },
    set: async (next) => {
      sets.push(next);
      reads = 0;
      pending = next;
    },
  };
  return { driver, sets };
}

function controller(driver: PowerModeDriver | null, clock = { t: 1_000 }) {
  return new PowerModeController({
    detect: async () => driver,
    fans: async () => [{ label: "Fan 1", rpm: 2400, maxRpm: 5100 }],
    now: () => clock.t,
    sleep: async () => {},
  });
}

describe("controller", () => {
  test("applies a mode and answers with the settled read-back", async () => {
    const { driver, sets } = fakeDriver("balanced", 2);
    const state = await controller(driver).set("performance");
    expect(sets).toEqual(["performance"]);
    expect(state.mode).toBe("performance");
    expect(state.fans).toEqual([{ label: "Fan 1", rpm: 2400, maxRpm: 5100 }]);
    expect(state.generatedAt).toBe(new Date(1_000).toISOString());
  });

  test("selecting the current mode does not touch the backend", async () => {
    const { driver, sets } = fakeDriver("balanced");
    expect((await controller(driver).set("balanced")).mode).toBe("balanced");
    expect(sets).toEqual([]);
  });

  test("unknown modes are refused before the backend runs", async () => {
    const { driver, sets } = fakeDriver();
    const err = await controller(driver).set("max-power").catch((e: unknown) => e);
    expect((err as ControlError).status).toBe(409);
    expect(sets).toEqual([]);
  });

  test("a mode that never sticks is reported, not assumed", async () => {
    const { driver } = fakeDriver("balanced", 1_000);
    const err = await controller(driver).set("performance").catch((e: unknown) => e);
    expect((err as ControlError).status).toBe(502);
    expect((err as Error).message).toContain("balanced");
  });

  test("concurrent writes run one at a time in arrival order", async () => {
    const { driver, sets } = fakeDriver("balanced", 1);
    const control = controller(driver);
    const [a, b] = await Promise.all([control.set("performance"), control.set("power-saver")]);
    expect(sets).toEqual(["performance", "power-saver"]);
    expect([a.mode, b.mode]).toEqual(["performance", "power-saver"]);
  });

  test("reads within a second share one backend call", async () => {
    let reads = 0;
    const clock = { t: 0 };
    const control = controller(
      {
        backend: "platform-profile",
        read: async () => {
          reads++;
          return { mode: "balanced", modes: ["balanced"], degraded: null };
        },
        set: async () => {},
      },
      clock,
    );
    await Promise.all([control.state(), control.state()]);
    clock.t = 500;
    await control.state();
    expect(reads).toBe(1);
    clock.t = 1_500;
    await control.state();
    expect(reads).toBe(2);
  });

  test("a machine without power modes answers 404 and is re-detected later", async () => {
    let detections = 0;
    const clock = { t: 0 };
    const control = new PowerModeController({
      detect: async () => {
        detections++;
        return null;
      },
      now: () => clock.t,
    });
    expect(await control.supported()).toBe(false);
    expect(((await control.state().catch((e: unknown) => e)) as ControlError).status).toBe(404);
    expect(detections).toBe(1);
    clock.t = 61_000;
    await control.supported();
    expect(detections).toBe(2);
  });
});

test("polkit rule names only the switch action and a validated user", () => {
  const rule = polkitRule("enseven");
  expect(rule).toContain('action.id === "org.freedesktop.UPower.PowerProfiles.switch-profile"');
  expect(rule).toContain('subject.user === "enseven"');
  expect(() => polkitRule('x"; return polkit.Result.YES; //')).toThrow();
});
