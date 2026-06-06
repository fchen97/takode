import type { BrowserIncomingMessage, CLIResultMessage, SessionState } from "./session-types.js";

export interface WorkspaceTokenUsageByModelRow {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  sessionCount: number;
  codexModelAttributionLimited?: boolean;
}

export interface WorkspaceTokenUsageByModelSummary {
  models: WorkspaceTokenUsageByModelRow[];
  totalTokens: number;
  generatedAt: number;
}

export interface WorkspaceTokenUsageSessionSource {
  state?: Pick<SessionState, "backend_type" | "model" | "codex_token_details">;
  messageHistory?: BrowserIncomingMessage[];
}

type TokenBucket = Omit<WorkspaceTokenUsageByModelRow, "model"> & { sessionIds: Set<string> };

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function totalFromParts(parts: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}): number {
  return (
    positiveNumber(parts.inputTokens) +
    positiveNumber(parts.outputTokens) +
    positiveNumber(parts.cachedInputTokens) +
    positiveNumber(parts.reasoningOutputTokens)
  );
}

function normalizeModelLabel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === "unknown" || normalized === "default") return null;
  return trimmed;
}

function getBucket(buckets: Map<string, TokenBucket>, model: string): TokenBucket {
  const existing = buckets.get(model);
  if (existing) return existing;
  const bucket: TokenBucket = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    sessionCount: 0,
    sessionIds: new Set(),
  };
  buckets.set(model, bucket);
  return bucket;
}

function addUsageToBucket(
  buckets: Map<string, TokenBucket>,
  sessionId: string,
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  },
  options: { codexModelAttributionLimited?: boolean } = {},
): void {
  const inputTokens = positiveNumber(usage.inputTokens);
  const outputTokens = positiveNumber(usage.outputTokens);
  const cachedInputTokens = positiveNumber(usage.cachedInputTokens);
  const reasoningOutputTokens = positiveNumber(usage.reasoningOutputTokens);
  const totalTokens = totalFromParts({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens });
  if (totalTokens <= 0) return;

  const bucket = getBucket(buckets, model);
  bucket.totalTokens += totalTokens;
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.cachedInputTokens += cachedInputTokens;
  bucket.reasoningOutputTokens += reasoningOutputTokens;
  bucket.sessionIds.add(sessionId);
  bucket.sessionCount = bucket.sessionIds.size;
  if (options.codexModelAttributionLimited) bucket.codexModelAttributionLimited = true;
}

function isResultMessage(
  message: BrowserIncomingMessage,
): message is Extract<BrowserIncomingMessage, { type: "result" }> {
  return message.type === "result";
}

function buildClaudeUsageFromHistory(messageHistory: BrowserIncomingMessage[] | undefined): Map<
  string,
  {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }
> {
  const usageByModel = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
  if (!messageHistory) return usageByModel;

  for (const message of messageHistory) {
    if (!isResultMessage(message)) continue;
    const modelUsage = (message.data as CLIResultMessage | undefined)?.modelUsage;
    if (!modelUsage) continue;

    for (const [rawModel, usage] of Object.entries(modelUsage)) {
      const model = normalizeModelLabel(rawModel);
      if (!model || !usage) continue;
      const nextUsage = {
        inputTokens: positiveNumber(usage.inputTokens),
        outputTokens: positiveNumber(usage.outputTokens),
        cachedInputTokens: positiveNumber(usage.cacheReadInputTokens) + positiveNumber(usage.cacheCreationInputTokens),
      };
      if (totalFromParts(nextUsage) <= 0) continue;
      usageByModel.set(model, nextUsage);
    }
  }

  return usageByModel;
}

export function buildWorkspaceTokenUsageByModel(
  sessions: Array<{ sessionId: string; source?: WorkspaceTokenUsageSessionSource | null }>,
  now = Date.now(),
): WorkspaceTokenUsageByModelSummary {
  const buckets = new Map<string, TokenBucket>();

  for (const session of sessions) {
    const state = session.source?.state;
    const claudeUsageByModel = buildClaudeUsageFromHistory(session.source?.messageHistory);
    for (const [model, usage] of claudeUsageByModel) {
      addUsageToBucket(buckets, session.sessionId, model, usage);
    }

    if (state?.backend_type !== "codex" || claudeUsageByModel.size > 0) continue;
    const model = normalizeModelLabel(state.model);
    const codexDetails = state.codex_token_details;
    if (!model || !codexDetails) continue;
    addUsageToBucket(
      buckets,
      session.sessionId,
      model,
      {
        inputTokens: codexDetails.inputTokens,
        outputTokens: codexDetails.outputTokens,
        cachedInputTokens: codexDetails.cachedInputTokens,
        reasoningOutputTokens: codexDetails.reasoningOutputTokens,
      },
      { codexModelAttributionLimited: true },
    );
  }

  const models = [...buckets.entries()]
    .map(([model, bucket]) => ({
      model,
      totalTokens: bucket.totalTokens,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cachedInputTokens: bucket.cachedInputTokens,
      reasoningOutputTokens: bucket.reasoningOutputTokens,
      sessionCount: bucket.sessionCount,
      ...(bucket.codexModelAttributionLimited ? { codexModelAttributionLimited: true } : {}),
    }))
    .filter((row) => row.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  return {
    models,
    totalTokens: models.reduce((total, row) => total + row.totalTokens, 0),
    generatedAt: now,
  };
}
