import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  SessionState,
  SessionTokenUsageSample,
} from "./session-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_USAGE_SAMPLES = 1_500;

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

export interface WorkspaceTokenUsageSessionSource {
  state?: Pick<SessionState, "backend_type" | "model" | "codex_token_details" | "token_usage_samples">;
  messageHistory?: BrowserIncomingMessage[];
}

type TokenBucket = Omit<WorkspaceTokenUsageByModelRow, "model"> & { sessionIds: Set<string> };
type CumulativeSample = SessionTokenUsageSample & { sessionId: string; model: string; observedTotalTokens: number };

const HISTOGRAM_RANGES: Array<{ id: WorkspaceTokenUsageRangeId; label: string; days: number }> = [
  { id: "week", label: "Past week", days: 7 },
  { id: "month", label: "Past month", days: 30 },
];

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

function cumulativeSampleTotal(sample: {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}): number {
  return (
    positiveNumber(sample.totalTokens) ||
    totalFromParts({
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cachedInputTokens: sample.cachedInputTokens,
      reasoningOutputTokens: sample.reasoningOutputTokens,
    })
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
    totalTokens?: number;
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
  // Some providers report detail fields that overlap with the raw cumulative
  // total. Prefer an explicit total when present, and keep detail fields as a
  // breakdown rather than deriving the row total from them.
  const totalTokens =
    positiveNumber(usage.totalTokens) ||
    totalFromParts({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens });
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

function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function formatLocalDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function buildDayKeys(days: number, now: number): string[] {
  const todayStart = startOfLocalDay(now);
  return Array.from({ length: days }, (_, index) => formatLocalDay(todayStart - (days - index - 1) * DAY_MS));
}

function toCumulativeSample(sessionId: string, sample: SessionTokenUsageSample): CumulativeSample | null {
  const timestamp = validTimestamp(sample.timestamp);
  const model = normalizeModelLabel(sample.model);
  if (!timestamp || !model) return null;
  const observedTotalTokens = cumulativeSampleTotal(sample);
  if (observedTotalTokens <= 0) return null;
  return { ...sample, sessionId, timestamp, model, observedTotalTokens };
}

function buildClaudeSamplesFromHistory(
  sessionId: string,
  messageHistory: BrowserIncomingMessage[] | undefined,
  limitedReasons: Set<string>,
): CumulativeSample[] {
  const samples: CumulativeSample[] = [];
  if (!messageHistory) return samples;

  for (const message of messageHistory) {
    if (!isResultMessage(message)) continue;
    const modelUsage = (message.data as CLIResultMessage | undefined)?.modelUsage;
    if (!modelUsage) continue;
    const timestamp = validTimestamp(message.timestamp);
    if (!timestamp) {
      limitedReasons.add("Some cumulative result totals have no timestamp, so they are excluded from daily buckets.");
      continue;
    }

    for (const [rawModel, usage] of Object.entries(modelUsage)) {
      const model = normalizeModelLabel(rawModel);
      if (!model || !usage) continue;
      const sample = toCumulativeSample(sessionId, {
        timestamp,
        backend: "claude",
        model,
        inputTokens: positiveNumber(usage.inputTokens),
        outputTokens: positiveNumber(usage.outputTokens),
        cachedInputTokens: positiveNumber(usage.cacheReadInputTokens) + positiveNumber(usage.cacheCreationInputTokens),
      });
      if (sample) samples.push(sample);
    }
  }

  return samples;
}

function buildHistorySamples(
  sessions: Array<{ sessionId: string; source?: WorkspaceTokenUsageSessionSource | null }>,
  limitedReasons: Set<string>,
): CumulativeSample[] {
  const samples: CumulativeSample[] = [];

  for (const session of sessions) {
    samples.push(...buildClaudeSamplesFromHistory(session.sessionId, session.source?.messageHistory, limitedReasons));
    for (const sample of session.source?.state?.token_usage_samples ?? []) {
      const normalized = toCumulativeSample(session.sessionId, sample);
      if (normalized) samples.push(normalized);
    }
  }

  return samples;
}

function buildHistogramRange(
  range: { id: WorkspaceTokenUsageRangeId; label: string; days: number },
  samples: CumulativeSample[],
  now: number,
  limitedReasons: Set<string>,
): WorkspaceTokenUsageHistogramRange {
  const dayKeys = buildDayKeys(range.days, now);
  const daySet = new Set(dayKeys);
  const dayModelTotals = new Map<string, Map<string, number>>();
  for (const day of dayKeys) dayModelTotals.set(day, new Map());

  const bySessionModel = new Map<string, CumulativeSample[]>();
  for (const sample of samples) {
    const key = `${sample.sessionId}\u0000${sample.model}`;
    const group = bySessionModel.get(key) ?? [];
    group.push(sample);
    bySessionModel.set(key, group);
  }

  for (const group of bySessionModel.values()) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    let previous: CumulativeSample | null = null;
    for (const sample of group) {
      if (!previous) {
        previous = sample;
        limitedReasons.add("Daily buckets start after the first timestamped cumulative sample for each session/model.");
        continue;
      }
      const delta = sample.observedTotalTokens - previous.observedTotalTokens;
      previous = sample;
      if (delta <= 0) continue;
      const day = formatLocalDay(sample.timestamp);
      if (!daySet.has(day)) continue;
      const modelTotals = dayModelTotals.get(day);
      if (!modelTotals) continue;
      modelTotals.set(sample.model, (modelTotals.get(sample.model) ?? 0) + delta);
    }
  }

  const buckets = dayKeys.map((date) => {
    const modelTotals = dayModelTotals.get(date) ?? new Map<string, number>();
    const models = [...modelTotals.entries()]
      .map(([model, totalTokens]) => ({ model, totalTokens }))
      .filter((entry) => entry.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
    return {
      date,
      totalTokens: models.reduce((total, entry) => total + entry.totalTokens, 0),
      models,
    };
  });

  return {
    id: range.id,
    label: range.label,
    days: range.days,
    granularity: "day",
    totalTokens: buckets.reduce((total, bucket) => total + bucket.totalTokens, 0),
    buckets,
  };
}

function buildHistorySummary(
  sessions: Array<{ sessionId: string; source?: WorkspaceTokenUsageSessionSource | null }>,
  now: number,
  allTimeTotalTokens: number,
): WorkspaceTokenUsageHistorySummary {
  const limitedReasons = new Set<string>();
  const samples = buildHistorySamples(sessions, limitedReasons);
  if (allTimeTotalTokens > 0 && samples.length === 0) {
    limitedReasons.add("No timestamped token usage samples are available yet for daily buckets.");
  }
  const ranges = HISTOGRAM_RANGES.map((range) => buildHistogramRange(range, samples, now, limitedReasons));
  return {
    ranges,
    limited: limitedReasons.size > 0,
    limitedReasons: [...limitedReasons],
  };
}

export function appendTokenUsageSample(
  state: Pick<SessionState, "token_usage_samples">,
  sample: SessionTokenUsageSample | null | undefined,
  maxSamples = MAX_TOKEN_USAGE_SAMPLES,
): void {
  if (!sample) return;
  const normalized = toCumulativeSample("session", sample);
  if (!normalized) return;
  const nextSample: SessionTokenUsageSample = {
    timestamp: normalized.timestamp,
    backend: normalized.backend,
    model: normalized.model,
    ...(positiveNumber(normalized.totalTokens) ? { totalTokens: positiveNumber(normalized.totalTokens) } : {}),
    ...(positiveNumber(normalized.inputTokens) ? { inputTokens: positiveNumber(normalized.inputTokens) } : {}),
    ...(positiveNumber(normalized.outputTokens) ? { outputTokens: positiveNumber(normalized.outputTokens) } : {}),
    ...(positiveNumber(normalized.cachedInputTokens)
      ? { cachedInputTokens: positiveNumber(normalized.cachedInputTokens) }
      : {}),
    ...(positiveNumber(normalized.reasoningOutputTokens)
      ? { reasoningOutputTokens: positiveNumber(normalized.reasoningOutputTokens) }
      : {}),
    ...(normalized.codexModelAttributionLimited ? { codexModelAttributionLimited: true } : {}),
  };
  const existing = state.token_usage_samples ?? [];
  const last = existing[existing.length - 1];
  if (
    last &&
    last.backend === nextSample.backend &&
    last.model === nextSample.model &&
    cumulativeSampleTotal(last) === cumulativeSampleTotal(nextSample)
  ) {
    return;
  }
  state.token_usage_samples = [...existing, nextSample].slice(-maxSamples);
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
        totalTokens: codexDetails.totalTokens,
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

  const totalTokens = models.reduce((total, row) => total + row.totalTokens, 0);

  return {
    models,
    totalTokens,
    history: buildHistorySummary(sessions, now, totalTokens),
    generatedAt: now,
  };
}
