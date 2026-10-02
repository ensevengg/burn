# burn

> Token burn rate for AI devs — see every token you burn across every machine, from your phone.

**burn** tracks AI coding-agent usage, cache hit rates, cost and vendor limits and physical-machine RAM/GPU health across Windows, WSL, Linux and macOS. It wraps [tokscale](https://github.com/junhoyeo/tokscale) for parsing and pricing, and reads your machines directly over **Tailscale**. The Android app renders from a local SQLite mirror, including when machines are offline. No hosted database, accounts or telemetry.

```
machine: tokscale + burn-events → burn-report daemon ← Tailscale → phone: Expo + SQLite
```

## Quickstart

The reporter currently requires Bun for its TypeScript CLI. Install [Tailscale](https://tailscale.com/) on each machine and the phone, and connect them to the same tailnet. From this checkout:

```bash
bun install
cargo install --path crates/burn-events  # once per machine, or use a release binary
bun run reporter -- init --slug my-machine --name "My Machine"
bun run reporter -- doctor
bun run reporter -- daemon             # keep running; prints the endpoint URL
```

Start the app with `bun run mobile`, open it in Expo Go on Android, choose **Use machines directly**, then paste the reporter URL under **Machines → +**. Each Windows, WSL or dual-boot installation gets its own slug; use a shared `--host-group` for installations on one physical machine. Add as many machines as needed.

`burn-report serve` is an alias for the resident backend. Both commands accept `--port 8787` and `--bind <address>`. The default bind is the machine's Tailscale IPv4; without Tailscale it falls back to loopback and prints a warning. A loopback endpoint is useful for local diagnostics and cannot be reached by the phone. `burn-report usage` prints vendor quota JSON locally.

For the published CLI, the equivalent setup is `npx burn-report init --slug my-machine --name "My Machine"`, then `npx burn-report daemon`.

To explore without machines, start the app and choose **Explore with demo data**. It loads a bundled 120-day dataset locally.

## Sync behavior

Opening the app or pulling to refresh probes registered machines. Validated usage pages, vendor quotas and system-health samples merge independently, preserving successful quotas when a vendor check fails. Interrupted history backfills resume while the app is foregrounded. Content hashes, compressed pages and no-op writes reduce repeated transfers.

Per-machine cursors checkpoint completed scan starts with a conservative overlap. Full-history reconciliation on a foreground/refresh pull after 24 hours catches late records and parser/pricing corrections. **Machines → Reconcile full history** runs it immediately. Offline machines retain cached history and show contact/error diagnostics.

The **Systems** tab shows RAM/GPU usage and available temperatures with trailing 24-hour sparklines. Resident reporters sample physical hardware every 30 seconds and on request; unsupported sensors stay unavailable. WSL uses its Windows host’s hardware and does not create a second physical system. Reporters keep a process-local 24-hour health history; the phone persists received samples and shows stale/unavailable readings when a machine cannot answer.

History lives in the source files on your machines and the phone mirror. A fresh phone needs each source machine to come online to rebuild its history. Removing a machine or disconnecting clears local cached data only, after confirmation.

## Upgrading

Restart reporters after updating this branch. Existing configs retain identity and parser pins; loading them removes obsolete upload settings and credentials. The phone preserves cached history, preferences and registered URLs. Saved legacy endpoint URLs become Tailscale registrations automatically; add a reporter URL manually if none was saved. The upgrade performs one corrective history reconciliation. Old scheduled `push` jobs should be replaced by a resident `daemon`; the `push` command has been removed.

See [transfer behavior and upgrade details](docs/connection-transfer-fixes.md) and [the backend decision](docs/adr/0003-tailscale-only-backend.md).

## Repository layout

| Path | Purpose |
|---|---|
| `apps/mobile` | Expo Android app, dashboards, limits, Systems, machines, sessions/workspaces and settings. |
| `apps/reporter` | Read-only machine backend and setup/diagnostic CLI. |
| `crates/burn-events` | Pinned Rust exporter of priced tokscale UnifiedMessage records as JSONL. |
| `packages/sync-api` | Machine transport, shared types, wire validation and idempotent mirror keys. |
| `docs` | Decisions, current transfer behavior and historical audits. |

## Development

```bash
bun run typecheck
bun run test
bun run --cwd apps/mobile android  # local Android build; requires JDK + Android SDK
```

[AGENTS.md](AGENTS.md) records engineering rules and current decisions. The original planning interview and architecture review remain historical records; [ADR 0003](docs/adr/0003-tailscale-only-backend.md) supersedes their cloud architecture.

Planned follow-ups: upstream `tokscale events --jsonl`, the Skia chart pass, EAS/GitHub Releases APK packaging, reporter service installation, QR onboarding and accurate model-price reference transport.

## License

[MIT](LICENSE)
