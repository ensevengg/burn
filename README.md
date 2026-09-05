# burn

> Token burn rate for AI devs — see every token you burn across every machine, from your phone.

**burn** tracks AI coding-agent token usage — input, output, cache, cache hit rate, and dollar cost — across Windows, WSL, and Linux, with daily/monthly/yearly views, per-model and per-workspace drill-downs, and live subscription limits (Codex, Z.ai, …). It wraps [tokscale](https://github.com/junhoyeo/tokscale) for parsing (50+ clients), syncs through **your own** Supabase project, and ships as an Android app (Expo). No accounts, no hosted service, no telemetry.

```
machines (cron/daemon: tokscale → burn-report) ──push──▶ your Supabase ◀──read── phone (Expo)
```

## Status

**Demo phase — everything below is built and verified.**

| Piece | State |
|---|---|
| `supabase/` | Schema + scoped-token RPCs (`burn_*`), demo seed. SQL contract verified end-to-end (RLS lockdown, idempotent ingest, revision propagation, quota dedup, rendezvous). |
| `packages/sync-api` | Shared contract: types, `SyncApi` interfaces, upsert-key definitions, Supabase impl (the only supabase-js import in the repo). |
| `apps/reporter` | `burn-report` CLI: `init` / `doctor` / `usage` / `daemon` work against real tokscale; `push` awaits the `burn-events` exporter seam (D2, first post-demo iteration). |
| `apps/mobile` | All v1 screens: dashboard + limits, daily/monthly/yearly charts with model/agent stacking, cache breakdown + hit rate, cost view, machines, sessions/workspaces/models, settings. Runs on bundled demo data instantly; connects to a real backend via read token. |

## Demo quickstart

**Phone (2 minutes, no backend):**
```bash
bun install
bun run mobile        # then scan the QR with Expo Go on your Android phone
# Setup screen → "Explore with demo data"
```

**Full loop (with your Supabase project):** follow [supabase/README.md](./supabase/README.md) — three SQL pastes, `npx burn-report init`, then connect the phone with the printed read token. `bun run reporter -- usage` pushes real Codex/Z.ai quotas; the Machines tab can request eager syncs from machines running `burn-report daemon`.

**Reporter (on each machine):**
```bash
bun run reporter -- doctor    # verify tokscale pin, config, backend, clock
bun run reporter -- usage     # push vendor quota snapshots
bun run reporter -- daemon    # resident: answers phone refresh requests (~30s) + scheduled push
```

**Verify everything yourself:**
```bash
bun run typecheck && bun run test
```

## Repository layout

```
apps/mobile        Expo app (SDK 57 / RN 0.86 / React 19)
apps/reporter      burn-report CLI (npm: npx burn-report)
packages/sync-api  SyncApi contract — supabase-js touches nothing else
supabase/          migrations, RLS, scoped-token RPCs, demo seed
docs → AGENTS.md   the rulebook: decisions D1–D12, conventions, status
```

## Documentation

- [AGENTS.md](./AGENTS.md) — decisions and engineering rules. Read first.
- [GLM-questionnaire.html](./GLM-questionnaire.html) — planning interview record.
- [sol-thoughts.html](./sol-thoughts.html) — second-agent architecture review (corrections folded in).

## Known deferrals (post-demo iterations)

1. `burn-events` Rust exporter + upstream `tokscale events --jsonl` PR — unblocks real `push`.
2. victory-native (Skia) chart pass behind the existing `Chart` boundary (D9).
3. EAS build profiles + GitHub Releases packaging.
4. `burn-report install-service` (systemd user units / Task Scheduler XML).

## License

[MIT](./LICENSE)
