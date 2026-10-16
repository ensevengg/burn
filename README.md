# burn

**Every token you burn. Every machine. One phone.**

Track your AI coding agents across Windows, WSL, Linux and macOS:

- **Spend**: dollars and tokens per agent, model, workspace and session
- **Cache hits**: how much of your input came from cache
- **Limits**: vendor quotas (Claude, Codex, Z.ai and more) with reset countdowns
- **Health**: RAM, GPU and temperatures per machine

No servers. No accounts. No telemetry.

<p align="center">
  <img src="assets/overview.webp" width="190" alt="Overview in light mode: 30-day spend, usage chart and agent shares">
  <img src="assets/limits.webp" width="190" alt="Token breakdown with cache hit rate, and vendor limits">
  <img src="assets/explore.webp" width="190" alt="Explore in light mode: models ranked by tokens">
  <img src="assets/systems.webp" width="190" alt="Systems: RAM and GPU usage and temperatures per machine">
</p>
<p align="center"><sub>Light or dark, your call. Demo data: machines, usage and prices are made up.</sub></p>

## How it works

```
machine: tokscale + burn-events → burn-report daemon ← Tailscale → phone: Expo + SQLite
```

- **Machines are the backend:** each runs `burn-report daemon`, a read-only server.
- **[tokscale](https://github.com/junhoyeo/tokscale) parses and prices** ~50 AI clients.
- **The phone pulls over Tailscale** and keeps an offline copy.
- **Machine offline?** Its history is still there.

## Quickstart

**1. Join one tailnet.** Install [Tailscale](https://tailscale.com/) on every machine and your phone.

**2. Run a reporter on each machine.** Needs Bun.

```bash
bun install
cargo install --path crates/burn-events   # once per machine, or use a release binary
bun run reporter -- init --slug my-machine --name "My Machine"
bun run reporter -- doctor
bun run reporter -- daemon                # keep it running; prints the URL
```

Published CLI: `npx burn-report init --slug my-machine --name "My Machine"`, then `npx burn-report daemon`.

**3. Open the app.** Run `bun run mobile` and open it in Expo Go on Android. Tap **Connect my machines**, then paste the URL under **Machines → +**.

**Just looking?** Tap **Explore with demo data**.

### Reporter tips

- **One slug per install:** Windows, WSL and each dual-boot side.
- **Same box?** Share a `--host-group`.
- **Flags:** `--port 8787`, `--bind <address>`. `serve` is an alias for `daemon`.
- **No Tailscale?** It falls back to loopback, which the phone can't reach.
- **Quotas:** `burn-report usage` prints them locally.

## The app

| Tab | What you get |
|---|---|
| **Overview** | Spend or tokens, 24h to All. Drag the chart for any day. Agents, cache hits, limits. |
| **Explore** | Models, agents, workspaces, sessions. Ranked. |
| **Systems** | RAM, GPU, temps. 24h trends. |
| **Machines** | Add by URL. Refresh or reconcile. |
| **Settings** | Theme, timezone, disconnect. |

- **Pull down** anywhere to refresh.
- **Header pill** shows progress: "Syncing 1/3".
- **Numbers glide**, and the total shows what the pull added.

## Sync, in short

- **Incremental:** only new rows travel.
- **Resumable:** big backfills continue while the app is open.
- **Self-correcting:** a daily full reconcile catches late records and price fixes.
- **Independent:** a failed quota check never wipes good data.
- **Health:** sampled every 30s, 24h kept.
- **Phone-only deletes:** removing a machine clears the phone's copy, never the machine's.

## Upgrading

- **Restart reporters.**
- **Exporter:** if `burn-events --capabilities` lacks `fingerprint-v1`, rerun `cargo install --path crates/burn-events`.
- **`push` is gone:** run `daemon` instead.
- **Kept:** reporter identity, phone history, settings and machine URLs.

Deep dives: [transfer behavior](docs/connection-transfer-fixes.md) · [why Tailscale-only](docs/adr/0003-tailscale-only-backend.md)

## Repo map

| Path | What |
|---|---|
| `apps/mobile` | Expo Android app |
| `apps/reporter` | `burn-report` CLI and read-only machine backend |
| `crates/burn-events` | Pinned Rust exporter of priced tokscale records (JSONL) |
| `packages/sync-api` | Transport, shared types, validation, mirror keys |
| `docs` | Decisions, transfer behavior, audits |

## Develop

```bash
bun run typecheck
bun run test
bun run --cwd apps/mobile android   # local Android build; needs JDK + Android SDK
```

- **Rules:** [AGENTS.md](AGENTS.md)
- **Why Tailscale-only:** [ADR 0003](docs/adr/0003-tailscale-only-backend.md)

## Next up

- Upstream `tokscale events --jsonl`
- Skia charts
- APKs on GitHub Releases
- Reporter service install
- QR onboarding
- Accurate model-price reference transport

## License

[MIT](LICENSE)
