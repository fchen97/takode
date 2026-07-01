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

export type WorkspaceTokenUsageRangeId = "week" | "month";

export interface WorkspaceTokenUsageHistogramModel {
  model: string;
  totalTokens: number;
}

export interface WorkspaceTokenUsageHistogramBucket {
  date: string;
  totalTokens: number;
  models: WorkspaceTokenUsageHistogramModel[];
}

export interface WorkspaceTokenUsageHistogramRange {
  id: WorkspaceTokenUsageRangeId;
  label: string;
  days: number;
  granularity: "day";
  totalTokens: number;
  buckets: WorkspaceTokenUsageHistogramBucket[];
}

export interface WorkspaceTokenUsageHistorySummary {
  ranges: WorkspaceTokenUsageHistogramRange[];
  limited: boolean;
  limitedReasons: string[];
}

export interface WorkspaceTokenUsageByModelSummary {
  models: WorkspaceTokenUsageByModelRow[];
  totalTokens: number;
  history: WorkspaceTokenUsageHistorySummary;
  generatedAt: number;
}
