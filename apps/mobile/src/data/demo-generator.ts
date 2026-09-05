/**
 * Deterministic demo dataset (seed 42): three environments, 30 days of
 * Codex/Z.ai/OpenCode usage with realistic token/cache/cost shapes. Pure TS —
 * consumed by the app's demo mode (in-memory, dates relative to now) and by
 * scripts/generate-demo-seed.ts (writes supabase/seed/demo.sql).
 */

export interface DemoEvent {
  eventId: string;
  environmentSlug: string;
  client: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  sessionTitle: string | null;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  agent: string | null;
  occurredAtMs: number;
  sourceOffsetMinutes: number;
  sourceTimezone: string;
  sourceLocalDate: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  isTurnStart: boolean;
  durationMs: number;
  cost: string;
  costSource: "provider_reported" | "estimated";
  costIsComplete: boolean;
  modelAttributionConflicted: boolean;
  parserVersion: string;
  dedupKey: string;
  revision: number;
}

export interface DemoEnvironment {
  slug: string;
  displayName: string;
  hostGroup: string | null;
  osKind: "windows" | "wsl" | "linux";
  reportingTimezone: string;
}

export interface DemoQuota {
  environmentSlug: string;
  provider: string;
  accountKey: string;
  accountLabel: string | null;
  plan: string | null;
  metric: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  status: "ok";
  error: null;
  /** Minutes before `now` the snapshot was fetched (staggered per machine). */
  ageMinutes: number;
}

export interface DemoDataset {
  now: number;
  environments: DemoEnvironment[];
  events: DemoEvent[];
  quotas: DemoQuota[];
}

const DAY = 86_400_000;

/** IST minutes offset (reporting timezone evidence for the demo machines). */
const IST_OFFSET_MIN = 330;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelSpec {
  client: string;
  providerId: string;
  modelId: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  providerReportedChance: number;
}

const MODELS: ModelSpec[] = [
  { client: "codex", providerId: "openai", modelId: "gpt-5.2-codex", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, providerReportedChance: 0.7 },
  { client: "codex", providerId: "openai", modelId: "gpt-5.2-mini", input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0, providerReportedChance: 0.4 },
  { client: "zcode", providerId: "zai", modelId: "glm-4.7", input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.11, providerReportedChance: 0.5 },
  { client: "zcode", providerId: "zai", modelId: "glm-4.7-air", input: 0.15, output: 0.6, cacheRead: 0.03, cacheWrite: 0.03, providerReportedChance: 0.2 },
  { client: "opencode", providerId: "zai", modelId: "glm-4.7", input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.11, providerReportedChance: 0 },
  { client: "opencode", providerId: "openai", modelId: "gpt-5.2-mini", input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0, providerReportedChance: 0 },
];

const ENVIRONMENTS: DemoEnvironment[] = [
  { slug: "cachyos", displayName: "CachyOS · laptop", hostGroup: null, osKind: "linux", reportingTimezone: "Asia/Kolkata" },
  { slug: "windows", displayName: "Windows · desktop", hostGroup: "nerve", osKind: "windows", reportingTimezone: "Asia/Kolkata" },
  { slug: "wsl", displayName: "WSL · desktop", hostGroup: "nerve", osKind: "wsl", reportingTimezone: "Asia/Kolkata" },
];

/** Per-environment workload character: heavier on the desktop. */
const ENV_WEIGHTS: Record<string, number> = { cachyos: 1, windows: 1.4, wsl: 0.7 };

const SESSION_TITLES = [
  "refactor reporter cursor handling",
  "fix RLS policy drift",
  "expo charts spike",
  "zai quota endpoint debug",
  "migrate settings screen",
  "tokscale fixtures update",
  "sqlite watermark audit",
  "demo dataset tuning",
  "RN new-arch perf pass",
  "dashboard polish",
  "hook up daemon poller",
  "seed data realism pass",
];

const WORKSPACES = [
  { key: "w-burn", label: "burn" },
  { key: "w-tokscale", label: "tokscale-research" },
  { key: "w-dotfiles", label: "dotfiles" },
  { key: "w-client-api", label: "client-api" },
];

const AGENTS = [null, null, null, "planner", "reviewer"];

function istDateKey(ms: number): string {
  const shifted = new Date(ms + IST_OFFSET_MIN * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function generateDemoDataset(now = Date.now()): DemoDataset {
  const rand = mulberry32(42);
  const events: DemoEvent[] = [];
  const todayUtcMidnight = Math.floor(now / DAY) * DAY;
  const revisions: Record<string, number> = { cachyos: 1, windows: 1, wsl: 1 };
  // 120 days with a growth curve: older days are sparser so the 30d/90d/1y
  // windows are visibly different in the app.
  const HISTORY_DAYS = 120;

  for (let dayOffset = HISTORY_DAYS - 1; dayOffset >= 0; dayOffset--) {
    const dayStartUtc = todayUtcMidnight - dayOffset * DAY;
    const weekday = new Date(dayStartUtc).getUTCDay();
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const growth = 0.3 + 0.7 * (1 - dayOffset / (HISTORY_DAYS - 1));

    for (const env of ENVIRONMENTS) {
      const sessionCount = Math.max(
        0,
        Math.round((1 + rand() * 4) * weekendFactor * growth * ENV_WEIGHTS[env.slug]!),
      );
      if (sessionCount === 0) continue;
      for (let s = 0; s < sessionCount; s++) {
        const model = MODELS[Math.floor(rand() * MODELS.length)]!;
        const sessionId = `demo-${env.slug}-${dayOffset}-${s}`;
        const workspace = WORKSPACES[Math.floor(rand() * WORKSPACES.length)]!;
        const title = rand() < 0.7 ? SESSION_TITLES[Math.floor(rand() * SESSION_TITLES.length)]! : null;
        const agent = AGENTS[Math.floor(rand() * AGENTS.length)]!;
        const messageTotal = 4 + Math.floor(rand() * 16);
        // Work hours, IST: 10:00–23:30 local → 4:30–18:00 UTC.
        let cursorMs = dayStartUtc + Math.floor((4.5 + rand() * 13.5) * 3600_000);

        for (let m = 0; m < messageTotal; m++) {
          cursorMs += Math.floor((6 + rand() * 240) * 1000);
          const input = 300 + Math.floor(rand() * 3700);
          const cacheRead = Math.floor(input * (2 + rand() * 8));
          const cacheWrite = Math.floor(input * (0.3 + rand() * 0.6));
          const reasoning = rand() < 0.35 ? Math.floor(rand() * 900) : 0;
          const output = 120 + Math.floor(rand() * 1400);
          const million = 1e6;
          const cost =
            (input * model.input +
              output * model.output +
              cacheRead * model.cacheRead +
              cacheWrite * model.cacheWrite) /
            million;
          const isTurnStart = m > 0 && m % 6 === 0;
          const revision = revisions[env.slug]!;

          events.push({
            eventId: `${env.slug}|${model.client}|v1:${model.client}:${sessionId}:${cursorMs}:${m}`,
            environmentSlug: env.slug,
            client: model.client,
            providerId: model.providerId,
            modelId: model.modelId,
            sessionId,
            sessionTitle: title,
            workspaceKey: workspace.key,
            workspaceLabel: workspace.label,
            agent,
            occurredAtMs: cursorMs,
            sourceOffsetMinutes: IST_OFFSET_MIN,
            sourceTimezone: "Asia/Kolkata",
            sourceLocalDate: istDateKey(cursorMs),
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            messageCount: 1,
            isTurnStart,
            durationMs: 2_000 + Math.floor(rand() * 88_000),
            cost: cost.toFixed(6),
            costSource:
              rand() < model.providerReportedChance ? "provider_reported" : "estimated",
            costIsComplete: true,
            modelAttributionConflicted: false,
            parserVersion: "tokscale-4.15.1",
            dedupKey: `v1:${model.client}:${sessionId}:${cursorMs}:${m}`,
            revision,
          });
        }
      }
    }
  }

  const quotas: DemoQuota[] = [
    { environmentSlug: "cachyos", provider: "Codex", accountKey: "acct_9f2c1e", accountLabel: "Personal (Plus)", plan: "chatgpt_plus", metric: "session_5h", usedPercent: 47.2, remainingPercent: 52.8, remainingLabel: "resets in 1h 52m", resetsAt: null, status: "ok", error: null, ageMinutes: 14 },
    { environmentSlug: "cachyos", provider: "Codex", accountKey: "acct_9f2c1e", accountLabel: "Personal (Plus)", plan: "chatgpt_plus", metric: "weekly", usedPercent: 21.4, remainingPercent: 78.6, remainingLabel: "resets Sep 9", resetsAt: null, status: "ok", error: null, ageMinutes: 14 },
    { environmentSlug: "cachyos", provider: "Z.ai", accountKey: "no-account", accountLabel: null, plan: "glm_coding_plan", metric: "tokens", usedPercent: 63.0, remainingPercent: 37.0, remainingLabel: "1.11M of 3M left", resetsAt: null, status: "ok", error: null, ageMinutes: 9 },
    { environmentSlug: "cachyos", provider: "Z.ai", accountKey: "no-account", accountLabel: null, plan: "glm_coding_plan", metric: "web_searches", usedPercent: 10.0, remainingPercent: 90.0, remainingLabel: "90 of 100 left", resetsAt: null, status: "ok", error: null, ageMinutes: 9 },
    { environmentSlug: "windows", provider: "Codex", accountKey: "acct_9f2c1e", accountLabel: "Personal (Plus)", plan: "chatgpt_plus", metric: "session_5h", usedPercent: 41.0, remainingPercent: 59.0, remainingLabel: "resets in 2h 30m", resetsAt: null, status: "ok", error: null, ageMinutes: 37 },
    { environmentSlug: "wsl", provider: "Codex", accountKey: "acct_9f2c1e", accountLabel: "Personal (Plus)", plan: "chatgpt_plus", metric: "session_5h", usedPercent: 52.8, remainingPercent: 47.2, remainingLabel: "resets in 3h 05m", resetsAt: null, status: "ok", error: null, ageMinutes: 61 },
  ];

  return { now, environments: ENVIRONMENTS, events, quotas };
}
