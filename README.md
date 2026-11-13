# burn

**Every token you burn. Every machine. One phone.**

Track your AI coding agents across Windows, WSL and Linux:

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

- **Machines are the backend:** each runs `burn-report daemon`, a read-only server (plus one opt-in control, below).
- **[tokscale](https://github.com/junhoyeo/tokscale) parses and prices** ~50 AI clients.
- **The phone pulls over Tailscale** and keeps an offline copy.
- **Machine offline?** Its history is still there.

## Quickstart

**1. Join one tailnet.** Install [Tailscale](https://tailscale.com/) on every machine and your phone.

**2. Run one line on each machine.**

Linux / macOS / WSL:

```sh
curl -fsSL https://github.com/ensevengg/burn/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/ensevengg/burn/releases/latest/download/install.ps1 | iex
```

It installs `burn-report`, starts it now and with the machine, and prints a QR code. On Windows it offers to set up each WSL distro too, including the mirrored networking WSL needs to be reachable. Run it again to upgrade.

**3. On the phone.** Install [`burn.apk`](https://github.com/ensevengg/burn/releases/latest/download/burn.apk), tap **Connect my machines**, then **Machines → + → Scan QR code**. Your other machines appear in the same sheet: tap each one.

**Lost the QR code?** `burn-report pair` shows it again (add `--port` if you started the daemon with one). **Just looking?** Tap **Explore with demo data**.

### From source

Needs Bun and a Rust toolchain.

```bash
bun install
cargo install --path crates/burn-events   # once per machine
bun run reporter -- install-service   # or `daemon` to run in this terminal only
```

### Reporter tips

- **Rename a machine:** `burn-report init --slug my-machine --name "My Machine"`. Every flag is optional.
- **One slug per install:** Windows, WSL and each dual-boot side. By default Windows gets a `-windows` slug and each WSL distro a `-wsl-<distro>` slug.
- **Same box?** Share a `--host-group`. Windows and WSL share their hostname automatically.
- **Ports:** 8787, or the first free port from 8788 to 8790 for a fresh WSL install (mirrored networking gives every distro the Windows reporter's address). `--port` on `install-service` is saved for later runs. Discovery checks 8787–8790. `--bind <address>` pins the address; `serve` is an alias for `daemon`.
- **Autostart:** `install-service` keeps the daemon running and restarts it if it exits. Linux gets a systemd user unit with lingering, so it starts at boot. Windows gets a hidden launcher in the per-user Run key that starts at sign-in, with no administrator rights needed. Inside WSL it registers a Windows sign-in launcher that starts the distro; WSL needs mirrored networking or Tailscale in the distro, and a different `--port` from the Windows reporter. `--print` shows what would be installed; `uninstall-service` removes it.
- **Check a machine:** `burn-report doctor`.
- **Limits** (vendor quotas) need the tokscale CLI, which the reporter runs through Bun or Node if either is installed. Usage syncs without it.

## The app

| Tab | What you get |
|---|---|
| **Overview** | Spend or tokens, 24h to All. Drag the chart for any day. Agents, cache hits, limits. |
| **Explore** | Models, agents, workspaces, sessions. Ranked. |
| **Systems** | RAM, GPU, temps. 24h trends. Live fans and power mode on opted-in Linux machines. |
| **Machines** | Scan a QR code, tap the rest. Refresh or reconcile. |
| **Settings** | Theme, timezone, disconnect. |

- **Pull down** anywhere to refresh.
- **Header pill** shows progress: "Syncing 1/3".
- **Numbers glide**, and the total shows what the pull added.

## Sync, in short

- **Incremental:** only new rows travel.
- **Warm:** reporters scan in the background, so a pull does not wait for one.
- **Resumable:** big backfills continue while the app is open.
- **Self-correcting:** a daily reconcile catches late records and price fixes, downloading only from the first day that changed.
- **Independent:** a failed quota check never wipes good data.
- **Health:** sampled every 30s, 24h kept.
- **Phone-only deletes:** removing a machine clears the phone's copy, never the machine's.

## Upgrading

- **Machines:** run the install line again. It replaces both binaries and restarts the reporter.
- **Phone:** install the new `burn.apk` over the old one. History and machines stay. A copy you built yourself is signed with a different key, so Android asks you to uninstall it first. Uninstalling removes the machines from the phone: scan or add them again, and their history downloads again from the machines.
- **From source:** rebuild `burn-events` with each pin bump; the reporter refuses one built for another tokscale pin.
- **`push` is gone:** run `install-service` instead. Services that still pass `--no-live` or `--live-url` exit with a hint, and `install-service` disables older hand-written Linux units that ran the reporter, keeping their files.
- **Kept:** reporter identity, phone history, settings and machine URLs.

Deep dives: [transfer behavior](docs/connection-transfer-fixes.md) · [why Tailscale-only](docs/adr/0003-tailscale-only-backend.md)

## Repo map

| Path | What |
|---|---|
| `apps/mobile` | Expo Android app |
| `apps/reporter` | `burn-report` CLI and machine backend (read-only, plus opt-in power mode) |
| `crates/burn-events` | Pinned Rust exporter of priced tokscale records (JSONL) |
| `packages/sync-api` | Transport, shared types, validation, mirror keys |
| `docs` | Decisions, transfer behavior, audits |

## Develop

```bash
bun run typecheck
bun run test
bun run --cwd apps/mobile android   # local Android build; needs JDK + Android SDK
```

- **Release:** `scripts/release.sh 0.2.0` bumps every version, runs the checks, tags and pushes. The tag builds the APK, both binaries for each platform and the installers into one GitHub release ([how](docs/adr/0006-one-tag-releases.md)).
- **Rules:** [AGENTS.md](AGENTS.md)
- **Why Tailscale-only:** [ADR 0003](docs/adr/0003-tailscale-only-backend.md)
- **Why the one write endpoint:** [ADR 0004](docs/adr/0004-opt-in-machine-controls.md)

## Next up

- Upstream `tokscale events --jsonl`
- Skia charts
- Accurate model-price reference transport

## License

[MIT](LICENSE)
