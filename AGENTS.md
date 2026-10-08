# AGENTS.md — burn

Rules and directions for AI agents (and humans) working on **burn**. Read this before writing any code. If a decision here conflicts with your instinct, the decision wins — the rationale is in [`GLM-questionnaire.html`](./GLM-questionnaire.html), which records the full planning interview, and [`sol-thoughts.html`](./sol-thoughts.html), the second-agent architecture review whose corrections were accepted and folded in (user delegated the final calls to the planning agent). The owner's 2026-10-02 decision in [ADR 0003](docs/adr/0003-tailscale-only-backend.md) supersedes the original cloud architecture. Do not relitigate settled decisions; propose an ADR only if you have *new* information.

## What burn is

An open-source Android app that tracks AI coding-agent token usage (tokens, cache hit rate, dollar cost, vendor quota/limits) across a user's machines — Windows, WSL, Linux (CachyOS) — by wrapping [tokscale](https://github.com/junhoyeo/tokscale). Machines are the backend: the phone reads their endpoints over the user's Tailscale network and keeps an offline SQLite mirror. Single-user, self-hosted, no hosted database or accounts.

## Components and data flow

```
[machine: Windows / WSL / Linux]
  pinned tokscale + burn-events → burn-report daemon (read-only HTTP)
                                              |
                                           Tailscale
                                              |
[Android phone] Expo app ← paged incremental pull → local SQLite mirror
```

- **`apps/reporter`** — `burn-report` CLI. `init` saves machine identity; `doctor` checks config, pins and Tailscale; `usage` prints local vendor quota diagnostics; `daemon` / `serve` expose validated events, quotas and physical health from shared cached snapshots.
- **`crates/burn-events`** — pinned Rust exporter of tokscale's already-normalized, priced `UnifiedMessage` records as versioned JSONL.
- **`apps/mobile`** — Expo Android app, local-first rendering, manually registered machine URLs and resumable direct sync.
- **`packages/sync-api`** — machine transport, runtime validation, shared types and idempotent mirror keys. All machine HTTP access goes through `LiveApi`.
- **`docs/`** — ADRs, transfer behavior and historical audits.

## Non-negotiable decisions

| # | Decision | Rule |
|---|----------|------|
| D1 | Data flow | Machines expose a read-only HTTP backend via `burn-report daemon` (or `serve`). The phone pulls over Tailscale on foreground and refresh gestures; bounded history backfills continue while foregrounded. Cached history renders while machines are offline. No scheduled cloud uploads or rendezvous polling. |
| D2 | Parsing | **Never reimplement provider parsing.** Raw per-message rows come from the small pinned Rust exporter (`burn-events`) calling tokscale-core's public unified-message pipeline and emitting versioned JSONL. An upstream `tokscale events --jsonl` PR is intended to replace it. Validate every exporter and HTTP payload before serving or merging; schema mismatch fails loudly. Bump pins via Renovate, weekly cadence. |
| D3 | Backend | Tailscale-connected machines are the sole backend ([ADR 0003](docs/adr/0003-tailscale-only-backend.md)). Shared transport and validation live in `packages/sync-api`; the app consumes `LiveApi`. There is no cloud database, alternate cloud mode or upload API. |
| D4 | Hosting | Self-hosted on the user's machines. No hosted instance, accounts or login screen. First-run setup offers Tailscale or bundled demo data. Machines "+" accepts the reporter's URL after a validated `/ping`. |
| D5 | Granularity | Keep **raw per-message usage rows** (`usage_events`) with stable idempotent keys. Per-machine V3 cursors checkpoint the completed machine scan start, with a one-hour overlap. Commit each page with its continuation atomically. Initial backfill, explicit full-history refresh and reconciliation after 24 hours catch late events and parser/pricing corrections; unchanged transfers use content hashes/ETags. |
| D6 | Quotas | Vendor quota (Claude 5h/weekly, Codex, Z.ai…) is **account-level**. Every machine may report it; the app shows the freshest successful snapshot per (provider, account, metric) with a "last checked X ago" staleness indicator, and keeps failed-snapshot diagnostics separately. Session rows are per-machine — no cross-machine dedup. |
| D7 | Keys | Tailnet membership authorizes machine access. Bind to the Tailscale interface by default, with loopback fallback for diagnostics. Manage access through Tailscale policies. No backend API keys, scoped tokens or phone credentials. Reporter config stores machine identity and parser settings. |
| D8 | Timezone | Store **UTC + the machine's local offset (+ IANA zone, + source-local date)** on every row. Use a **persisted `reporting_timezone`** (setup default `Asia/Kolkata`, stable until changed) for render-time day/month/year bucketing. Device-timezone rebucketing is explicit opt-in. Never store pre-bucketed day keys. Money is decimal strings on the wire and SQLite text in the mirror. |
| D9 | Stack | Expo SDK 57 / RN 0.86 / React 19, `@react-navigation` (bottom-tabs + native-stack), TanStack Query, expo-sqlite (WAL) mirror. Android 8.0+ min. No native modules unless there is no library-level alternative. Charts use lightweight `react-native-svg`; victory-native (Skia) remains the planned post-demo swap behind the `Chart` boundary. |
| D10 | Scope | v1 includes all screens: dashboard + remaining limits, daily/monthly/yearly toggle charts (stackable by model/agent), input/output/cache breakdown + cache hit rate, dollar cost view, per-machine comparison, per-workspace drill-down, sessions list, settings. Build order is sequenced in the spec; "day one" means v1 scope, not commit #1. |
| D11 | Distribution | GitHub Releases (EAS-built APKs) + local `expo run:android` for contributors. **No Play Store — decided firmly.** |
| D12 | Privacy | No telemetry, analytics or crash reporting. The phone communicates only with registered machine endpoints over the user's tailnet. Reporter quota checks use tokscale's provider APIs and local credentials; parser/pricing acquisition follows pinned tokscale. Document bundled/fetched LiteLLM pricing data. |

## Facts you don't need to rediscover

Verified during planning against the sources — trust these, and re-verify against `reference/tokscale` only if tokscale's pin gets bumped:

- Tokscale (Rust core, MIT) reads ~50 clients' local files, e.g. Claude Code `~/.claude/projects/*.jsonl`, OpenCode `~/.local/share/opencode/opencode.db`, Codex `~/.codex/sessions/`, ZCode `~/.zcode/cli/db/db.sqlite`. Pricing comes from LiteLLM data, with tiered pricing and cache discounts.
- The CLI's JSON surface is **aggregate-only** (`models`, `monthly`, `hourly`, `graph`, `time-metrics` group rows; `report` is task-attributed). The per-message record we want is `UnifiedMessage` (`crates/tokscale-core/src/sessions/mod.rs:69`, `serde::Serialize`, public) — client, provider/model ids, session id/title, workspace key/label, UTC timestamp + derived date, five token buckets, cost + `cost_source`, duration, message count, agent, `dedup_key`, turn marker, attribution-conflict marker. Hence the `burn-events` export seam (D2), which calls the **public** `parse_local_unified_messages_with_pricing(options, Some(&PricingService))` (the same entry the tokscale TUI uses; `ParsedMessage`-returning APIs strip cost/dedup_key/title — do not use them). An upstream `tokscale events --jsonl` PR would replace the binary; the reporter's schema already parses that future output.
- `tokscale usage --json` emits an array of `{provider, account{id,label,is_active}, credential_source, plan, email, metrics: [{label, used_percent, remaining_percent, remaining_label, resets_at}], reset_credits, credit_status, spend_control}` (`crates/tokscale-cli/src/commands/usage/mod.rs`). `usage` reads provider credentials locally (e.g. Codex OAuth from `~/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage`) and returns **account-level** quotas — identical from any machine sharing the subscription. This is why D6's freshness dedup is correct.
- WSL and Windows are one physical machine with two reporters — give each a distinct `machine_id` (`windows`, `wsl`), and the per-machine screen should be built so "same host" grouping is possible later.
- The user's actual matrix (updated 2026-09-05): **machine count is dynamic — never hardcode it.** Currently up to four reporters: a standalone Windows PC, plus the main box which dual-boots CachyOS and Windows and runs WSL inside that Windows (reporters: `cachyos`, `windows` (dual-boot side), `wsl`). The dual-boot sides and WSL share one `host_group`. Machines are registered on the phone by URL; Machines "+" shows the exact `npx burn-report init --slug ... --name ...` command and accepts the URL printed by the daemon. Any other tokscale-supported client must still work for open-source users — never hard-code the user's matrix.

## `reference/` — read-only research material

`reference/tokscale` and `reference/t3code` are cloned repos kept for research. Rules:

- **Never commit them** (gitignored) and never import or vendor code from them into `burn` without an explicit license check (tokscale is MIT; verify t3code's before touching its code — treat both as inspiration and API documentation, not donor code).
- Use them to answer factual questions (grep the source) instead of guessing or asking the user.

## Engineering conventions

- **Commits: small, scoped, revertable.** One concern per commit — if a change can't be described in one `type(scope): summary` line, it's multiple commits. Format: `fix(ui): adjusted button click radius`, `feat(reporter): retry push with backoff`, `refactor(sync-api): split wire parsers`. Types: feat/fix/refactor/perf/docs/chore/test. No bodies unless a non-obvious "why" genuinely needs one.
- TypeScript strict everywhere; no `any` without a comment justifying it.
- User-facing identifiers (models, providers, plans, metrics, os kinds) never render raw — route them through `src/lib/labels.ts` `humanize()` (`chatgpt_plus` → "ChatGPT Plus").
- Every row write must be an idempotent upsert with a documented key in `packages/sync-api`. If you invent a new row type, its dedup key definition lives there, not at the call site.
- The phone must feel instant: render from local expo-sqlite first, revalidate against registered machines in the background (stale-while-revalidate). Any feature that blocks first paint on the network is a bug.
- Tests follow the code: reporter snapshot/paging logic, phone cursor handling and schema validation and any pure aggregation are unit-tested; tokscale output fixtures are checked in under `apps/reporter/fixtures/`.
- Dark-mode-first UI with a system-follow toggle. USD only in v1.
- Destructive mobile actions keep their buttons and require a Yes/Cancel confirmation before machine removal, disconnect, or clearing cache/demo data. Cancel and native dismissal leave data untouched.
- Keep the app lean: this project's stated priorities are lowest storage and fastest, most responsive UX.

## Current status

- **Tailscale-only backend (2026-10-02)**: owner explicitly removed the former database backend ([ADR 0003](docs/adr/0003-tailscale-only-backend.md)). Machine HTTP is the sole real sync path; demo mode remains. Database adapter, migrations/seed, upload commands/indexes, rendezvous, cloud UI and dependencies are removed.
- **Upgrade**: old reporter configs retain identity/pin but are rewritten without destination credentials or upload settings. Phone upgrades preserve cached real history/preferences and existing registrations; saved legacy machine endpoint URLs become direct registrations. Missing URLs must be added manually. One corrective reconciliation runs after upgrading. No remote infrastructure is changed.
- **Connection reliability retained**: full normalized snapshots share one in-flight scan, 30-second event TTL, source-fingerprint reuse and five-minute pin/capability checks. Quotas cache for 45 seconds and publish independently. Pages have at most 1,000 rows and roughly 4MB decoded event content, with gzip/ETags and resumable continuations. The phone requests pages newest-first (cursors carry the order; requests without it stay oldest-first). V3 cursors checkpoint machine scan starts; foreground backfills continue automatically, resuming only pending machines' events. Compatible pulls coalesce; different machine/full-history requests queue. Read [docs/connection-transfer-fixes.md](docs/connection-transfer-fixes.md) before changing transfers, cursors or cancellation.
- **Mirror writers** serialize behind `withWriteLock`: machine sync, demo seed, resets and removal. Generation/abort checks protect transactions and queued registrations. Event writes use 32-row bound batches; cache eviction occurs post-commit inside the writer. expo-sqlite transactions are not reentrant.
- **Events pipeline**: pinned `burn-events` emits priced UnifiedMessage JSONL, timezone evidence, stable fallback dedup keys and workspace labels. Strict validation gates exporter and machine responses. The exporter pin remains 4.15.1; release binaries for Windows/Linux/macOS come from the `burn-events-v*` workflow.
- **Mobile performance**: cached timezone formatters, cooperative/cancellable aggregation, shared bounded reads, focused query gating, virtualized Explore lists and SQL-limited machine/client sessions. Event queries do not heartbeat; quotas/machines do. Query transitions keep previous data. Only pages with changed rows invalidate event queries; health pulls request samples after the newest stored one. Backfill notices and quota errors coexist; pull status has its own context.
- **Main reconciliation (2026-10-02)**: current main is merged before the Tailscale-only PR. Retained unbounded All-history views, combined model totals, remaining quota display, labels, initial-sync diagnostics, exporter fingerprints/capability checks and Rust/diagnostic fixes. Fingerprint reuse preserves pageable snapshot metadata; full reconciliation/source changes/clock rollback rescan.
- **Systems (2026-10-02)**: owner requested the `feat/systems-direct-sync` feature alongside this reliability branch. Physical RAM/GPU health is ported onto the machine-only transport with independent validated pulls, idempotent samples, shared cancellation/write lock and local 24-hour history. Reporter samples every 30 seconds/on request; unsupported sensors are null, WSL is excluded. Historical usage remains on Dashboard/Explore.
- **UI**: all v1 screens, bundled 120-day demo, dashboard Cost/Tokens and range chips, gradient area chart and model breakdown. Dark-mode-first with system toggle. Destructive actions retain Yes/Cancel confirmation. OnePlus 10R / Android 15 upgrade and tab/refresh/cancel checks passed; all three saved connections and 42,141 cached usage rows survived. CachyOS/HP refreshed; Lenovo Windows was offline. Broader Android timing remains pending.
- **Known deferrals**: upstream `tokscale events --jsonl` PR, victory-native/Skia chart pass, EAS/GitHub Releases packaging, reporter `install-service`, QR onboarding and model-price reference transport. Accurate real cache savings needs tokscale's provider/alias/tier pricing semantics; no approximations. Demo prices are local only.
- **Verification**: strict typecheck and all 117 tests pass, including 27,001 synthetic rows through real HTTP into actual SQLite, resumable passes, no-op refresh, periodic full reconciliation, reset races, quota freshness and legacy upgrade rollback. Host tests do not establish Android/tailnet latency.
- Dev commands: `bun install`, `bun run typecheck`, `bun run test`. Reporter: `bun run reporter -- <cmd>`. Mobile: `bun run mobile`. Exporter: `cargo install --path crates/burn-events`.
- Update this section as work lands.
