/**
 * `burn-report pair`: what the phone needs to add this machine, as a QR code
 * for Machines → + → Scan and as text for typing. The code holds a
 * `burn://add?url=…` link; the phone still validates the machine with /ping
 * before registering it, so the code carries no credentials (D7).
 */
import { renderUnicodeCompact } from "uqr";
import { loadOrInitConfig, reporterPort } from "./config.js";
import { tailscaleIp } from "./serve.js";

export function pairingLink(url: string): string {
  return `burn://add?url=${encodeURIComponent(url)}`;
}

/**
 * Half-block QR code. On a terminal the colors are set explicitly (dark
 * modules on light), so it scans on light and dark themes alike; logs get
 * plain blocks, which read correctly on a dark background.
 */
export function renderQr(text: string, color: boolean): string {
  const lines = renderUnicodeCompact(text, { ecc: "M", border: 2 }).split("\n");
  return lines.map((line) => (color ? `  \x1b[97;40m${line}\x1b[0m` : `  ${line}`)).join("\n");
}

async function answers(url: string, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/** Print the QR code and URL. `wait` gives a just-started daemon time to bind. */
export async function printPairing(
  bind?: string,
  options: { wait?: boolean; check?: boolean; port?: string } = {},
): Promise<number> {
  const { config } = loadOrInitConfig();
  // A daemon started with an unsaved --port needs the same flag here.
  const port = reporterPort(config, options.port);
  const address = bind ?? await tailscaleIp();
  if (address === null) {
    console.log(`Tailscale is not connected on this machine yet. Start it, then run: burn-report pair`);
    return 1;
  }
  const url = `http://${address}:${port}`;
  const color = process.stdout.isTTY === true && !process.env["NO_COLOR"];
  console.log(`Add "${config.environmentName}" on your phone: burn → Machines → + → Scan QR`);
  console.log();
  console.log(renderQr(pairingLink(url), color));
  console.log();
  console.log(`or type: ${url}`);
  if (options.check !== false && !(await answers(url, options.wait ? 10 : 1))) {
    console.log();
    console.warn(`warning: nothing answers at ${url} yet. Start the reporter with: burn-report install-service`);
    return 1;
  }
  return 0;
}

export async function runPair(args: Map<string, string>): Promise<number> {
  const port = args.get("port");
  return printPairing(args.get("bind"), { wait: false, ...(port === undefined ? {} : { port }) });
}
