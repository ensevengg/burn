/**
 * Human display for wire identifiers (user feedback: no underscores/dashes in
 * a consumer app). `chatgpt_plus` → "ChatGPT Plus", `session_5h` → "Session 5h",
 * `gpt-5.2-codex` → "GPT-5.2 Codex". Known names win; everything else gets
 * word-split + title-cased with tech-initialism fixes.
 */

const EXACT: Record<string, string> = {
  chatgpt_plus: "ChatGPT Plus",
  "chatgpt-plus": "ChatGPT Plus",
  chatgpt_pro: "ChatGPT Pro",
  glm_coding_plan: "GLM Coding Plan",
  session_5h: "Session 5h",
  weekly: "Weekly",
  tokens: "Tokens",
  web_searches: "Web Searches",
  no_account: "—",
  "no-account": "—",
  zai: "Z.ai",
  zcode: "ZCode",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  moonshot: "Moonshot",
  kimi: "Kimi",
  "glm-4.7": "GLM-4.7",
  "glm-4.7-air": "GLM-4.7 Air",
  "glm-4.6": "GLM-4.6",
  "kimi-k2.5": "Kimi K2.5",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.2-mini": "GPT-5.2 Mini",
  "gpt-5.2": "GPT-5.2",
  linux: "Linux",
  windows: "Windows",
  wsl: "WSL",
  macos: "macOS",
  estimated: "estimated",
  provider_reported: "provider-reported",
  providerReported: "provider-reported",
};

const WORDS: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  ai: "AI",
  api: "API",
  cli: "CLI",
  llm: "LLM",
  sdk: "SDK",
  ide: "IDE",
  llms: "LLMs",
  pc: "PC",
  usd: "USD",
};

/** Fallback word-case for unknown identifiers: "my_thing-v2" → "My Thing V2". */
function wordCase(word: string): string {
  const lower = word.toLowerCase();
  if (WORDS[lower] !== undefined) return WORDS[lower]!;
  if (/^\d/.test(lower)) return lower.toUpperCase(); // version segments: "5.2"
  if (lower === lower.toUpperCase() && lower.length <= 4) return lower; // preserve short all-caps
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function humanize(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const exact = EXACT[trimmed] ?? EXACT[trimmed.toLowerCase()];
  if (exact !== undefined) return exact;
  return trimmed
    .split(/[_\-\s]+/)
    .filter((part) => part !== "")
    .map(wordCase)
    .join(" ");
}
