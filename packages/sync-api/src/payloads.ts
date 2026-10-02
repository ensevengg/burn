/** One normalized machine event; the phone derives its stable event identity. */
export interface MachineEventInput {
  client: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  sessionTitle: string | null;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  agent: string | null;
  occurredAtMs: number;
  sourceOffsetMinutes: number | null;
  sourceTimezone: string | null;
  sourceLocalDate: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  messageCount: number;
  isTurnStart: boolean;
  durationMs: number | null;
  /** Decimal string — never a float on the wire. */
  cost: string;
  costSource: "unknown" | "provider_reported" | "estimated";
  costIsComplete: boolean;
  modelAttributionConflicted: boolean;
  parserVersion: string;
  dedupKey: string;
}

export interface MachineQuotaInput {
  provider: string;
  accountKey: string;
  accountLabel: string | null;
  plan: string | null;
  metric: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  remainingLabel: string | null;
  resetsAt: string | null;
  creditStatus: Record<string, unknown> | null;
  spendControl: Record<string, unknown> | null;
  status: "ok" | "error";
  error: string | null;
  sourceOffsetMinutes: number | null;
}


/** One physical-machine sample. Unsupported sensors are explicitly null. */
export interface MachineMetricInput {
  capturedAtMs: number;
  cpuLoadPct: number;
  cpuTempC: number | null;
  ramUsedPct: number;
  ramTempC: number | null;
  gpuUtilPct: number | null;
  gpuTempC: number | null;
}
