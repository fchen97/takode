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
