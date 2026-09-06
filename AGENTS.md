# AGENTS.md — burn

Rules and directions for AI agents (and humans) working on **burn**. Read this before writing any code. If a decision here conflicts with your instinct, the decision wins — the rationale is in [`GLM-questionnaire.html`](./GLM-questionnaire.html), which records the full planning interview, and [`sol-thoughts.html`](./sol-thoughts.html), the second-agent architecture review whose corrections were accepted and folded in (user delegated the final calls to the planning agent). Do not relitigate settled decisions; propose an ADR only if you have *new* information.

## What burn is

An open-source Android app that tracks AI coding-agent token usage (tokens, cache hit rate, dollar cost, vendor quota/limits) across a user's machines — Windows, WSL, Linux (CachyOS) — by wrapping [tokscale](https://github.com/junhoyeo/tokscale) as the data-fetching layer and syncing through the user's **own** Supabase project. Single-user, self-hosted, BYO-backend. The user's phone reads; the machines push.

## The three components

```
[machine: Windows / WSL / Linux]
  tokscale CLI (pinned version)  →  burn-report (TS CLI, npx)  --upsert-->  [user's Supabase: Postgres]
                                                                                |  read-only, RLS
[Android phone]  Expo app  <--watermark-incremental fetch--  SyncApi  ----------+
```

1. **`apps/reporter`** — `burn-report`, a TypeScript CLI published to npm, run via `npx burn-report`. Invokes tokscale, validates its JSON, upserts new rows. Subcommands: `push` (usage rows since cursor), `usage` (vendor quota JSON), `doctor` (verify tokscale version, config, DB connectivity).
2. **`supabase/`** — schema migrations, RLS policies. Machines write with the **secret key**; the phone reads with the **publishable key** through read-only policies.
3. **`apps/mobile`** — Expo SDK 57 / React Native 0.86 / React 19 (New Architecture) Android app.

Shared contracts live in **`packages/sync-api`** — the `SyncApi` interface + row types, consumed by both the reporter and the app.

Planned repo layout:

```
apps/mobile        Expo app
apps/reporter      burn-report CLI
crates/burn-events D2 exporter: pinned Rust binary, tokscale UnifiedMessage → JSONL
packages/sync-api  SyncApi interface, shared types, upsert key definitions
supabase/          migrations, RLS, seed
docs/              ADRs, design notes
```

## Non-negotiable decisions

| # | Decision | Rule |
|---|----------|------|
| D1 | Data flow | Machines **push** on a schedule (default 10-min cron + run-on-wake catch-up) **and** optionally run `burn-report daemon` (resident, ~30s poll of `sync_requests`) so a phone refresh reaches online machines within seconds. The scheduled push is the reliability floor; the daemon is the eager path. The phone never talks to machines directly. Tailscale direct-pull is v2 — don't build it now. |
| D2 | Parsing | **Never reimplement provider parsing.** Tokscale's CLI exports aggregates only — raw per-message rows come from a narrow export seam: a small pinned Rust exporter (`burn-events`) that calls `tokscale-core` and emits versioned JSONL of the already-normalized `UnifiedMessage` records, with an upstream `tokscale events --jsonl` PR intended to replace it. Every payload is schema-validated before pushing; on mismatch, fail loudly. Bump pins via Renovate, weekly cadence. |
| D3 | Backend | Supabase (Postgres + RLS) is implementation #1. **All** Supabase access — reads and writes — goes through the `SyncApi` module. No `supabase-js` imports anywhere else. This is what keeps a self-hosted/PocketBase backend a swap, not a rewrite. |
| D4 | Hosting | BYO backend. No hosted instance, no user accounts, no login screen in v1. First-run setup screen collects Supabase URL + keys. |
| D5 | Granularity | Machines upload **raw per-message usage rows** (`usage_events`) with idempotent upsert keys. Incremental sync is **revision-based, not event-time-based**: each reporter batch bumps the environment's monotonic `latest_revision`; rows carry that revision; the phone fetches `revision > last_revision` so parser/pricing corrections to old events propagate. Never full-table refetch outside the initial backfill. |
| D6 | Quotas | Vendor quota (Claude 5h/weekly, Codex, Z.ai…) is **account-level**. Every machine may report it; the app shows the freshest successful snapshot per (provider, account, metric) with a "last checked X ago" staleness indicator, and keeps failed-snapshot diagnostics separately. Session rows are per-machine — no cross-machine dedup. |
| D7 | Keys | **Token-scoped access, no key sharing.** Base tables have RLS enabled with zero policies (deny all direct access). All reads/writes go through `burn_api.*` security-definer RPCs gated by scoped tokens: one read token for the phone (SecureStore), one ingest token per environment (reporter config). Tokens are stored as SHA-256 hashes; rotation revokes one phone/reporter without touching data. No Supabase Auth, no central accounts. The secret key never leaves the Supabase dashboard. |
| D8 | Timezone | Store **UTC + the machine's local offset (+ IANA zone, + source-local date)** on every row. The app uses a **persisted `reporting_timezone`** (set at setup, default `Asia/Kolkata`, stable until changed) for day/month/year bucketing at render time. Re-bucketing history in the device's current timezone is an explicit opt-in mode — never the silent default. Never store pre-bucketed day keys. Money is Postgres `numeric` / decimal strings — never floats. |
| D9 | Stack | Expo SDK 57 / RN 0.86 / React 19, `@react-navigation` (bottom-tabs + native-stack), TanStack Query, expo-sqlite (WAL) local mirror, expo-secure-store for tokens. Android 8.0+ min. No native modules unless there is no library-level alternative. Charts: demo phase uses lightweight `react-native-svg` chart components (lean APK, instant iteration); victory-native (Skia) is the planned swap for the post-demo chart pass — keep the `Chart` component boundary so the swap is contained. |
| D10 | Scope | v1 includes all screens: dashboard + remaining limits, daily/monthly/yearly toggle charts (stackable by model/agent), input/output/cache breakdown + cache hit rate, dollar cost view, per-machine comparison, per-workspace drill-down, sessions list, settings. Build order is sequenced in the spec; "day one" means v1 scope, not commit #1. |
| D11 | Distribution | GitHub Releases (EAS-built APKs) + local `expo run:android` for contributors. **No Play Store — decided firmly.** |
| D12 | Privacy | No telemetry, no analytics, no crash reporting, no network calls to anything except the user's own Supabase project. Pricing data (LiteLLM) may be bundled or fetched from its repo — document whichever we do. |

## Facts you don't need to rediscover

Verified during planning against the sources — trust these, and re-verify against `reference/tokscale` only if tokscale's pin gets bumped:

- Tokscale (Rust core, MIT) reads ~50 clients' local files, e.g. Claude Code `~/.claude/projects/*.jsonl`, OpenCode `~/.local/share/opencode/opencode.db`, Codex `~/.codex/sessions/`, ZCode `~/.zcode/cli/db/db.sqlite`. Pricing comes from LiteLLM data, with tiered pricing and cache discounts.
- The CLI's JSON surface is **aggregate-only** (`models`, `monthly`, `hourly`, `graph`, `time-metrics` group rows; `report` is task-attributed). The per-message record we want is `UnifiedMessage` (`crates/tokscale-core/src/sessions/mod.rs:69`, `serde::Serialize`, public) — client, provider/model ids, session id/title, workspace key/label, UTC timestamp + derived date, five token buckets, cost + `cost_source`, duration, message count, agent, `dedup_key`, turn marker, attribution-conflict marker. Hence the `burn-events` export seam (D2), which calls the **public** `parse_local_unified_messages_with_pricing(options, Some(&PricingService))` (the same entry the tokscale TUI uses; `ParsedMessage`-returning APIs strip cost/dedup_key/title — do not use them). An upstream `tokscale events --jsonl` PR would replace the binary; the reporter's schema already parses that future output.
- `tokscale usage --json` emits an array of `{provider, account{id,label,is_active}, credential_source, plan, email, metrics: [{label, used_percent, remaining_percent, remaining_label, resets_at}], reset_credits, credit_status, spend_control}` (`crates/tokscale-cli/src/commands/usage/mod.rs`). `usage` reads provider credentials locally (e.g. Codex OAuth from `~/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage`) and returns **account-level** quotas — identical from any machine sharing the subscription. This is why D6's freshness dedup is correct.
- WSL and Windows are one physical machine with two reporters — give each a distinct `machine_id` (`windows`, `wsl`), and the per-machine screen should be built so "same host" grouping is possible later.
- The user's actual matrix (updated 2026-09-05): **machine count is dynamic — never hardcode it.** Currently up to four reporters: a standalone Windows PC, plus the main box which dual-boots CachyOS and Windows and runs WSL inside that Windows (reporters: `cachyos`, `windows` (dual-boot side), `wsl`). The dual-boot sides and WSL share one `host_group`. Machines appear in the app automatically via their first push; the app's Machines "+" button opens an add-machine sheet with the exact `npx burn-report init` command (ingest tokens are minted machine-side, never phone-side). Any other tokscale-supported client must still work for open-source users — never hard-code the user's matrix.

## `reference/` — read-only research material

`reference/tokscale` and `reference/t3code` are cloned repos kept for research. Rules:

- **Never commit them** (gitignored) and never import or vendor code from them into `burn` without an explicit license check (tokscale is MIT; verify t3code's before touching its code — treat both as inspiration and API documentation, not donor code).
- Use them to answer factual questions (grep the source) instead of guessing or asking the user.

## Engineering conventions

- **Commits: small, scoped, revertable.** One concern per commit — if a change can't be described in one `type(scope): summary` line, it's multiple commits. Format: `fix(ui): adjusted button click radius`, `feat(reporter): retry push with backoff`, `refactor(sync-api): split wire parsers`. Types: feat/fix/refactor/perf/docs/chore/test. No bodies unless a non-obvious "why" genuinely needs one.
- TypeScript strict everywhere; no `any` without a comment justifying it.
- User-facing identifiers (models, providers, plans, metrics, os kinds) never render raw — route them through `src/lib/labels.ts` `humanize()` (`chatgpt_plus` → "ChatGPT Plus").
- Every row write must be an idempotent upsert with a documented key in `packages/sync-api`. If you invent a new row type, its dedup key definition lives there, not at the call site.
- The phone must feel instant: render from local expo-sqlite first, revalidate against Supabase in the background (stale-while-revalidate). Any feature that blocks first paint on the network is a bug.
- Tests follow the code: reporter logic (cursor handling, schema validation) and any pure aggregation are unit-tested; tokscale output fixtures are checked in under `apps/reporter/fixtures/`.
- Dark-mode-first UI with a system-follow toggle. USD only in v1.
- Keep the app lean: this project's stated priorities are lowest storage and fastest, most responsive UX.

## Current status

- Planning complete; Sol review (`sol-thoughts.html`) reconciled — its corrections (daemon rendezvous, exporter seam, fixed reporting timezone, scoped token API) are folded into the decision table above; the four delegated calls were made 2026-09-05 and are not open questions.
- **Demo phase built**: monorepo scaffold, `supabase/migrations` (schema + `burn_api` scoped-token RPCs), `packages/sync-api`, `apps/reporter` (`init`/`doctor`/`usage`/`daemon` real; `push` awaits the `burn-events` exporter), `apps/mobile` (all v1 screens, bundled demo dataset, real Supabase connect via read token).
- **Events pipeline is live (2026-09-06)**: `crates/burn-events` (pinned Rust binary calling tokscale-core's public unified-message pipeline; emits priced `UnifiedMessage` JSONL + timezone evidence, applies the D2 dedup fallback and workspace labels) and the real reporter `push` (cursor-time window with 1h overlap, `--full` correction pass, 500-row batches, strict zod gate). `doctor` checks the exporter version against the pin (a test keeps the crate version and git tag in lockstep with `TOKSCALE_PIN`); the daemon cycle pushes events then quotas, each failing independently. Release binaries for windows/linux/macos come from the `burn-events-v*` tag workflow. Smoke-tested against real data: 27k records scanned in ~12s, validated + mapped in ~180ms.
- **Mirror write lock (2026-09-06)**: the phone's mirror writers — cloud sync, demo seed, resets, machine removal — serialize behind `withWriteLock` (`apps/mobile/src/lib/writelock.ts`). expo-sqlite's `withTransactionAsync` is not reentrant; overlapping syncs (mount pull, manual refresh, the requestSync timer) interleaved BEGIN/COMMIT/ROLLBACK and crashed with "cannot rollback - no transaction is active".
- Known deferrals (post-demo iteration): upstream `tokscale events --jsonl` PR (would replace the exporter binary), victory-native/Skia chart pass, EAS build profiles, reporter service-install helpers (`install-service`), `model_prices` payload from the reporter (below).
- On-device test (OnePlus 10R, Android 15, Expo Go + `adb reverse`): full click-through passed, zero crashes. Agreed next UI direction: a "clean/slick" pass modeled on tokscale's dashboard — headline metric + Cost/Tokens and range chips up top, smooth gradient area chart instead of discrete bars, dense totals strip (incl. cache savings), table-style model breakdown with Model/Day toggle. Fold Dashboard+History into that single surface; keep Explore/Machines/Settings as tabs.
- **first-check review (2026-09-06) addressed**: quota freshness filters errors (0004), preferences survive cache resets, day-bucketing consolidated into `bucketEvents` with pure compute fns + repository tests, export_schema persisted in the mirror, quota row keys unified env-scoped, dead exports and the redundant supabase-js deps removed. Known deferrals unchanged.
- **Next milestone — dashboard restructure** (user-approved direction, spec'd 2026-09-05): single surface = (1) chip row `Cost|Tokens` × `Past 24h|7d|30d|90d`; (2) headline number + "N sessions" subtitle + provider row; (3) the existing gradient area chart (reuse ScrollableAreaChart, fixed Y per granularity); (4) totals strip: processed tokens / cached input / uncached input / output / **cache savings**; (5) breakdown table by model with Cost/Share/Tokens + `Model|Day` toggle. Machines/Subscriptions live on their own tabs. New data dependency: **model pricing reference** — cache savings needs per-model input vs cache-read prices. Researched: tokscale keeps a LiteLLM snapshot at `~/.config/tokscale/pricing-litellm.json` (`pricing/cache.rs:176`); reporter should surface per-model prices from that file (or its own bundled snapshot) as a versioned `model_prices` payload; app caches it alongside events and computes savings as `cache_read × (input − cache_read) $/M`. Refresh via Renovate with the tokscale pin.
- Perf finding: demo seed (~2.5k rows) takes ~20s via per-row `runAsync` — switch to a single batched `execAsync` insert next iteration.
- Dev commands: `bun install`, `bun run typecheck`, `bun run test` (root). Reporter: `bun run --cwd apps/reporter dev -- <cmd>`. Mobile: `bun run --cwd apps/mobile start` (Expo Go for the demo). Exporter: `cargo install --path crates/burn-events` (puts the binary on PATH; `cargo build --release` there for a local-only build).
- Update this section as scaffolding lands.
