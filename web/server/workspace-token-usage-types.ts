import type { BackendType } from "./session-types.js";

export interface SessionTokenUsageSample {
  /** Epoch ms when this cumulative usage snapshot was observed by the server. */
  timestamp: number;
  backend: BackendType;
  model: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  codexModelAttributionLimited?: boolean;
}

/** Latest cumulative Claude usage for one model, as reported by result.modelUsage. */
export interface ClaudeModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Token counts in one usage figure: a cumulative total, a growth, or an all-time sum. */
export interface TokenUsageAmounts {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

/** Day key (YYYY-MM-DD in the server's time zone) -> model -> tokens used that day. */
export type TokenUsageDays = Record<string, Record<string, number>>;

/**
 * A session's token usage, kept up to date on every usage update.
 *
 * Backends report cumulative totals. Each update adds the growth since the
 * previous total of the same counter to `totals` and to that day in `days`, so
 * usage is never recomputed from a bounded list of snapshots. A total lower
 * than the previous one (a fresh Codex thread) is growth from zero, so earlier
 * usage stays counted.
 */
export interface SessionTokenUsageLedger {
  version: 1;
  /** When live recording began: the conversion from samples or the first update. Absent on a ledger derived only for display. */
  trackingSince?: number;
  /** Last cumulative usage per counter: `codex` (one per thread, all models) or `claude:<model>`. */
  counters: Record<string, TokenUsageAmounts>;
  /** All-time usage per model. */
  totals: Record<string, TokenUsageAmounts>;
  /** Usage recorded live, per day and model. */
  days: TokenUsageDays;
  /** Usage recovered at conversion from the bounded samples the session had kept; before `trackingSince`. */
  convertedDays?: TokenUsageDays;
}

/** One session's days rebuilt from the backend's own logs by the one-time backfill (`token-usage/backfill.json`). */
export interface TokenUsageBackfillSession {
  sessionId: string;
  sessionNum?: number;
  /** Only usage before this time is included: the session's `trackingSince`, or when the backfill was computed. */
  cutoff: number;
  days: TokenUsageDays;
}
