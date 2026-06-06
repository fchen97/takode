import type { SessionState } from "./session-types.js";
import { computeContextTokensUsed, type TokenUsage } from "./bridge/context-usage.js";
import {
  codexEffectiveReasoningEffortPatch,
  readCodexReasoningEffortReport,
} from "../shared/codex-reasoning-effort.js";

export type CodexRateLimitSet = {
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
};

function normalizeLimit(value: unknown): CodexRateLimitSet["primary"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usedRaw = Number(raw.usedPercent ?? 0);
  const normalizedPercent = Number.isFinite(usedRaw) ? (usedRaw > 0 && usedRaw < 1 ? usedRaw * 100 : usedRaw) : 0;
  const usedPercent = Math.max(0, Math.min(100, normalizedPercent));
  const windowDurationMins = Number(raw.windowDurationMins ?? 0);
  let resetsAt = 0;
  const rawResetsAt = raw.resetsAt;
  if (typeof rawResetsAt === "number" && Number.isFinite(rawResetsAt)) {
    resetsAt = rawResetsAt;
  } else if (typeof rawResetsAt === "string") {
    const asNumber = Number(rawResetsAt);
    if (Number.isFinite(asNumber)) {
      resetsAt = asNumber;
    } else {
      const asDateMs = Date.parse(rawResetsAt);
      if (Number.isFinite(asDateMs)) resetsAt = asDateMs;
    }
  }
  return {
    usedPercent,
    windowDurationMins: Number.isFinite(windowDurationMins) ? windowDurationMins : 0,
    resetsAt,
  };
}

function normalizeRateLimitSet(value: unknown): CodexRateLimitSet | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    primary: normalizeLimit(raw.primary),
    secondary: normalizeLimit(raw.secondary),
  };
}

export function updateCodexRateLimits(
  data: Record<string, unknown>,
  rateLimitsByLimitId: Map<string, CodexRateLimitSet>,
): CodexRateLimitSet | null {
  const direct = data?.rateLimits as Record<string, unknown> | undefined;
  const directNormalized = normalizeRateLimitSet(direct);
  const directLimitId = typeof direct?.limitId === "string" ? direct.limitId : null;
  if (directLimitId && directNormalized) {
    rateLimitsByLimitId.set(directLimitId, directNormalized);
  }

  const byId = data?.rateLimitsByLimitId as Record<string, unknown> | undefined;
  if (byId && typeof byId === "object") {
    for (const [limitId, limitData] of Object.entries(byId)) {
      const parsed = normalizeRateLimitSet(limitData);
      if (parsed) rateLimitsByLimitId.set(limitId, parsed);
    }
  }

  return (
    rateLimitsByLimitId.get("codex") ??
    (directLimitId ? (rateLimitsByLimitId.get(directLimitId) ?? null) : null) ??
    directNormalized ??
    null
  );
}

export function buildCodexTokenUsagePatch(params: Record<string, unknown>): Partial<SessionState> {
  const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
  if (!tokenUsage) return {};

  const total = tokenUsage.total as Record<string, number> | undefined;
  const last = tokenUsage.last as Record<string, number> | undefined;
  const contextWindow = tokenUsage.modelContextWindow as number | undefined;
  const providerReportedTotalTokens =
    typeof last?.totalTokens === "number" && Number.isFinite(last.totalTokens) ? last.totalTokens : undefined;
  const updates: Partial<SessionState> = {};

  if (last && contextWindow && contextWindow > 0) {
    const usage: TokenUsage = {
      input_tokens: last.inputTokens || 0,
      cache_read_input_tokens: last.cachedInputTokens || 0,
    };
    const contextTokensUsed =
      computeContextTokensUsed(usage) ??
      (typeof last.inputTokens === "number" && last.inputTokens === 0 && (last.cachedInputTokens || 0) === 0
        ? 0
        : undefined);
    const displayContextTokens = providerReportedTotalTokens ?? contextTokensUsed;
    if (typeof contextTokensUsed === "number" || typeof providerReportedTotalTokens === "number") {
      updates.codex_token_details = {
        ...(updates.codex_token_details ?? {
          totalTokens: total?.totalTokens || 0,
          inputTokens: total?.inputTokens || 0,
          outputTokens: total?.outputTokens || 0,
          cachedInputTokens: total?.cachedInputTokens || 0,
          reasoningOutputTokens: total?.reasoningOutputTokens || 0,
          modelContextWindow: contextWindow || 0,
        }),
        ...(typeof contextTokensUsed === "number" ? { contextTokensUsed } : {}),
        ...(typeof displayContextTokens === "number" ? { displayContextTokensUsed: displayContextTokens } : {}),
        ...(providerReportedTotalTokens !== undefined ? { providerReportedTotalTokens } : {}),
      };
    }
    if (typeof displayContextTokens === "number") {
      updates.context_used_percent = Math.max(
        0,
        Math.min(100, Math.round((Math.min(displayContextTokens, contextWindow) / contextWindow) * 100)),
      );
    }
  }

  if (total) {
    updates.codex_token_details = {
      contextTokensUsed: updates.codex_token_details?.contextTokensUsed,
      displayContextTokensUsed: updates.codex_token_details?.displayContextTokensUsed,
      ...(providerReportedTotalTokens !== undefined ? { providerReportedTotalTokens } : {}),
      totalTokens: total.totalTokens || 0,
      inputTokens: total.inputTokens || 0,
      outputTokens: total.outputTokens || 0,
      cachedInputTokens: total.cachedInputTokens || 0,
      reasoningOutputTokens: total.reasoningOutputTokens || 0,
      modelContextWindow: contextWindow || 0,
    };
  }

  return updates;
}
export function buildCodexEffectiveReasoningEffortPatch(params: Record<string, unknown>): Partial<SessionState> {
  return codexEffectiveReasoningEffortPatch(readCodexReasoningEffortReport(params.threadSettings));
}
