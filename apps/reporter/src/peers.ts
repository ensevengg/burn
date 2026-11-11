/**
 * Peer discovery (ADR 0005): which other machines on this tailnet run a burn
 * reporter. The phone cannot list tailnet devices itself, so once it knows
 * one machine it asks that machine, and the rest are offered in the add sheet
 * instead of being typed in one by one.
 *
 * The only addresses contacted are the peers Tailscale itself reports for
 * this node, on this reporter's own port, with `GET /ping`. Nothing from the
 * request chooses a target.
 */
import { parseLivePing, type LivePeer } from "@burn/sync-api";
import { spawnRunner } from "./tokscale.js";

export interface PeerDeps {
  now?: () => number;
  /** Online peers' tailnet IPv4 addresses. */
  listPeers?: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

/** Online peers from `tailscale status --json`; empty when the CLI is absent. */
export async function tailscalePeers(timeoutMs = 5_000): Promise<string[]> {
  try {
    const { stdout } = await spawnRunner({ command: "tailscale", prefix: [] }, ["status", "--json"], timeoutMs);
    const status = JSON.parse(stdout) as { Peer?: Record<string, { Online?: boolean; TailscaleIPs?: unknown }> };
    const addresses: string[] = [];
    for (const peer of Object.values(status.Peer ?? {})) {
      if (peer.Online !== true || !Array.isArray(peer.TailscaleIPs)) continue;
      const ipv4 = peer.TailscaleIPs.find((ip): ip is string => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (ipv4) addresses.push(ipv4);
    }
    return addresses;
  } catch {
    return [];
  }
}

const MAX_PEERS = 64;
const CACHE_MS = 60_000;

export class PeerDirectory {
  private cached: { at: number; peers: LivePeer[] } | null = null;
  private pending: Promise<LivePeer[]> | null = null;
  constructor(
    private readonly port: number,
    private readonly deps: PeerDeps = {},
  ) {}

  list(): Promise<LivePeer[]> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now >= this.cached.at && now - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.peers);
    if (this.pending) return this.pending;
    const pending = this.probe()
      .then((peers) => {
        this.cached = { at: (this.deps.now ?? Date.now)(), peers };
        return peers;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  private async probe(): Promise<LivePeer[]> {
    const addresses = (await (this.deps.listPeers ?? tailscalePeers)()).slice(0, MAX_PEERS);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const found = await Promise.all(
      addresses.map(async (address): Promise<LivePeer | null> => {
        const url = `http://${address}:${this.port}`;
        try {
          const response = await fetchImpl(`${url}/ping`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(1_500),
          });
          if (!response.ok) return null;
          // Anything else listening on the port fails validation and is skipped.
          const ping = parseLivePing(await response.json());
          return { url, slug: ping.slug, displayName: ping.displayName, osKind: ping.osKind };
        } catch {
          return null;
        }
      }),
    );
    const bySlug = new Map<string, LivePeer>();
    for (const peer of found) if (peer !== null && !bySlug.has(peer.slug)) bySlug.set(peer.slug, peer);
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }
}
