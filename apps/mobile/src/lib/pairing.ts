/**
 * Pairing codes: `burn-report pair` prints a QR code holding
 * `burn://add?url=<machine URL>`. The same link opens the app from another
 * scanner. Plain machine URLs are accepted too. Nothing here registers a
 * machine: the add flow still validates it with /ping (D4).
 */
import { normalizeMachineUrl } from "./direct";

/** The machine URL in a scanned code or opened link, or null for anything else. */
export function parsePairingCode(text: string): string | null {
  const trimmed = text.trim();
  let candidate = trimmed;
  const link = /^burn:\/\/add\/?\?(.*)$/i.exec(trimmed);
  if (link) {
    const url = new URLSearchParams(link[1]).get("url");
    if (url === null) return null;
    candidate = url;
  } else if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const normalized = normalizeMachineUrl(candidate);
    return /^https?:\/\//i.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

const RELEASES = "https://github.com/ensevengg/burn/releases/latest/download";
/** One line per machine; each installs the reporter, starts it with the
 * machine and prints the pairing QR code. */
export const INSTALL_COMMANDS = {
  unix: `curl -fsSL ${RELEASES}/install.sh | sh`,
  windows: `irm ${RELEASES}/install.ps1 | iex`,
} as const;
