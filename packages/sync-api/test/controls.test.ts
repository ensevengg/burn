import { expect, test } from "bun:test";
import {
  CONTROL_HEADER,
  parsePowerModeRequest,
  parsePowerModeState,
  supportsPowerMode,
} from "../src/controls";
import { httpLiveApiFor, LiveError, validateLiveApi } from "../src/live";

const state = {
  generatedAt: "2026-11-09T08:00:00.000Z",
  backend: "power-profiles-daemon",
  mode: "balanced",
  modes: ["power-saver", "balanced", "performance"],
  degraded: null,
  fans: [{ label: "CPU fan", rpm: 2400, maxRpm: 5100 }],
};

test("power mode state validates and keeps an unlisted active mode", () => {
  expect(parsePowerModeState(state)).toEqual(state as never);
  // Firmware hotkeys can select a mode the backend does not offer.
  expect(parsePowerModeState({ ...state, mode: "max-power" }).mode).toBe("max-power");
  expect(parsePowerModeState({ ...state, mode: null }).mode).toBeNull();
  // Older reporters omit maxRpm; it is not invented.
  expect(parsePowerModeState({ ...state, fans: [{ label: "Fan 1", rpm: 0 }] }).fans).toEqual([
    { label: "Fan 1", rpm: 0, maxRpm: null },
  ]);
});

test("malformed power mode state is rejected, never coerced", () => {
  const bad: unknown[] = [
    { ...state, modes: [] },
    { ...state, modes: ["balanced", "balanced"] },
    { ...state, modes: ["Balanced"] },
    { ...state, modes: ["rm -rf /"] },
    { ...state, backend: "acpi" },
    { ...state, fans: [{ label: "fan", rpm: -1 }] },
    { ...state, fans: [{ label: "fan", rpm: 1.5 }] },
    { ...state, fans: [{ label: "fan", rpm: 90_000 }] },
    { ...state, fans: [{ label: "", rpm: 10 }] },
    { ...state, generatedAt: "yesterday" },
    { ...state, mode: 3 },
    { ...state, fans: [{ label: "fan", rpm: 10, maxRpm: 0 }] },
  ];
  for (const value of bad) expect(() => parsePowerModeState(value)).toThrow();
});

test("write requests accept exactly one well-formed mode", () => {
  expect(parsePowerModeRequest({ mode: "performance" })).toEqual({ mode: "performance" });
  expect(() => parsePowerModeRequest({ mode: "performance", force: true })).toThrow(LiveError);
  expect(() => parsePowerModeRequest({ mode: "../../etc" })).toThrow(LiveError);
  expect(() => parsePowerModeRequest(["performance"])).toThrow();
});

test("capability gate reads ping capabilities", () => {
  expect(supportsPowerMode(["paged-events", "power-mode"])).toBe(true);
  expect(supportsPowerMode(["paged-events"])).toBe(false);
  expect(supportsPowerMode(undefined)).toBe(false);
});

test("HTTP adapter sends a JSON POST with the control header and validates the reply", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ ...state, mode: "performance" }));
  }) as typeof fetch;
  const api = httpLiveApiFor("http://machine:8787/", fetchImpl);
  const result = await api.setPowerMode!("performance");
  expect(result.mode).toBe("performance");
  expect(seen[0]!.url).toBe("http://machine:8787/controls/power-mode");
  expect(seen[0]!.init?.method).toBe("POST");
  expect(seen[0]!.init?.body).toBe(JSON.stringify({ mode: "performance" }));
  const headers = seen[0]!.init?.headers as Record<string, string>;
  expect(headers["content-type"]).toBe("application/json");
  expect(headers[CONTROL_HEADER]).toBe("1");

  await api.powerMode!();
  expect(seen[1]!.init?.method).toBeUndefined();
  expect(seen[1]!.init?.body).toBeUndefined();
});

test("control errors keep the reporter's message and status", async () => {
  const api = httpLiveApiFor("http://machine", (async () =>
    new Response(JSON.stringify({ error: "nobody is signed in" }), { status: 503 })) as unknown as typeof fetch);
  const err = await api.setPowerMode!("balanced").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LiveError);
  expect((err as LiveError).status).toBe(503);
  expect((err as Error).message).toContain("nobody is signed in");
});

test("injected adapters validate mode before it leaves the phone", async () => {
  let called = false;
  const api = validateLiveApi({
    ping: async () => ({}),
    events: async () => ({}),
    quotas: async () => ({}),
    setPowerMode: async () => {
      called = true;
      return state;
    },
  });
  await expect(api.setPowerMode!("BAD MODE")).rejects.toThrow();
  expect(called).toBe(false);
  expect((await api.setPowerMode!("balanced")).mode).toBe("balanced");
});
