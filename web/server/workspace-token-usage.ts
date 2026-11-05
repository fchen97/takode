import type { BrowserIncomingMessage } from "./session-types.js";
import {
  dayTotal,
  firstLocalDay,
  formatLocalDay,
  positiveNumber,
  tokenUsageDaysFor,
  tokenUsageLedgerFor,
  type TokenUsageLedgerState,
} from "./workspace-token-usage-ledger.js";
import type { TokenUsageBackfillSession } from "./workspace-token-usage-types.js";

export {
  ensureTokenUsageLedger,
  recordClaudeResultTokenUsage,
  recordCodexTokenUsage,
} from "./workspace-token-usage-ledger.js";

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
  state?: TokenUsageLedgerState;
  /** Loaded history; read only to convert sessions recorded before the per-session ledger. */
  messageHistory?: BrowserIncomingMessage[];
}

export interface WorkspaceTokenUsageSession {
  sessionId: string;
  source?: WorkspaceTokenUsageSessionSource | null;
  /** This session's days rebuilt from backend logs, when a backfill holds any. */
  backfill?: TokenUsageBackfillSession | null;
}

type TokenBucket = Omit<WorkspaceTokenUsageByModelRow, "model"> & { sessionIds: Set<string> };

const HISTOGRAM_RANGES: Array<{ id: WorkspaceTokenUsageRangeId; label: string; days: number }> = [
  { id: "week", label: "Past week", days: 7 },
  { id: "month", label: "Past month", days: 30 },
];

const EARLIER_USAGE_REASON =
  "Usage from before a session's daily tracking began, or older than its kept days, counts in all-time totals but not in daily buckets.";

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
  const totalTokens = positiveNumber(usage.totalTokens);
  if (totalTokens <= 0) return;
  const bucket = getBucket(buckets, model);
  bucket.totalTokens += totalTokens;
  bucket.inputTokens += positiveNumber(usage.inputTokens);
  bucket.outputTokens += positiveNumber(usage.outputTokens);
  bucket.cachedInputTokens += positiveNumber(usage.cachedInputTokens);
  bucket.reasoningOutputTokens += positiveNumber(usage.reasoningOutputTokens);
  bucket.sessionIds.add(sessionId);
  bucket.sessionCount = bucket.sessionIds.size;
  if (options.codexModelAttributionLimited) bucket.codexModelAttributionLimited = true;
}

function buildModelRows(buckets: Map<string, TokenBucket>): WorkspaceTokenUsageByModelRow[] {
  return [...buckets.entries()]
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
}

function buildDayKeys(days: number, now: number): string[] {
  const cursor = new Date(`${firstLocalDay(days, now)}T00:00:00`);
  return Array.from({ length: days }, () => {
    const day = formatLocalDay(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
    return day;
  });
}

function buildRanges(
  dayModelTotals: Map<string, Map<string, number>>,
  now: number,
): WorkspaceTokenUsageHistogramRange[] {
  return HISTOGRAM_RANGES.map((range) => {
    const buckets = buildDayKeys(range.days, now).map((date) => {
      const models = [...(dayModelTotals.get(date) ?? new Map<string, number>()).entries()]
        .map(([model, totalTokens]) => ({ model, totalTokens }))
        .filter((entry) => entry.totalTokens > 0)
        .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
      return { date, totalTokens: models.reduce((total, entry) => total + entry.totalTokens, 0), models };
    });
    return {
      id: range.id,
      label: range.label,
      days: range.days,
      granularity: "day" as const,
      totalTokens: buckets.reduce((total, bucket) => total + bucket.totalTokens, 0),
      buckets,
    };
  });
}

function addDayModelTotal(
  dayModelTotals: Map<string, Map<string, number>>,
  day: string,
  model: string,
  tokens: number,
) {
  if (tokens <= 0) return;
  const models = dayModelTotals.get(day) ?? new Map<string, number>();
  models.set(model, (models.get(model) ?? 0) + tokens);
  dayModelTotals.set(day, models);
}

export function buildWorkspaceTokenUsageByModel(
  sessions: WorkspaceTokenUsageSession[],
  now = Date.now(),
): WorkspaceTokenUsageByModelSummary {
  const buckets = new Map<string, TokenBucket>();
  const dayModelTotals = new Map<string, Map<string, number>>();
  const limitedReasons = new Set<string>();

  for (const session of sessions) {
    const state = session.source?.state;
    const ledger = tokenUsageLedgerFor(state, session.source?.messageHistory);
    // Codex reports one total per thread; usage from before per-update attribution follows the session's model.
    const codexModelAttributionLimited = state?.backend_type === "codex";
    let allTime = 0;
    for (const [model, usage] of Object.entries(ledger.totals)) {
      addUsageToBucket(buckets, session.sessionId, model, usage, { codexModelAttributionLimited });
      allTime += positiveNumber(usage.totalTokens);
    }
    let daily = 0;
    for (const [day, models] of Object.entries(tokenUsageDaysFor(ledger, session.backfill))) {
      daily += dayTotal(models);
      for (const [model, tokens] of Object.entries(models)) addDayModelTotal(dayModelTotals, day, model, tokens);
    }
    if (daily < allTime) limitedReasons.add(EARLIER_USAGE_REASON);
  }

  const models = buildModelRows(buckets);
  return {
    models,
    totalTokens: models.reduce((total, row) => total + row.totalTokens, 0),
    history: {
      ranges: buildRanges(dayModelTotals, now),
      limited: limitedReasons.size > 0,
      limitedReasons: [...limitedReasons],
    },
    generatedAt: now,
  };
}

/**
 * What a session's summary depends on. A session with a ledger depends only on
 * it (it is replaced, not changed, on every update); one still recorded the old
 * way depends on the fields its ledger is derived from.
 */
type WorkspaceTokenUsageFingerprint = readonly unknown[];

function buildSessionFingerprint(session: WorkspaceTokenUsageSession): WorkspaceTokenUsageFingerprint {
  const source = session.source;
  const state = source?.state;
  const shared = [source, state, state?.backend_type, state?.model, session.backfill];
  if (state?.token_usage_ledger) return [...shared, state.token_usage_ledger];
  const messageHistory = source?.messageHistory;
  const samples = state?.token_usage_samples;
  const codexDetails = state?.codex_token_details;
  return [
    ...shared,
    messageHistory,
    messageHistory?.length ?? 0,
    messageHistory?.[messageHistory.length - 1],
    samples,
    samples?.length ?? 0,
    samples?.[samples.length - 1],
    state?.claude_model_usage,
    state?.claude_token_details,
    codexDetails?.totalTokens,
    codexDetails?.inputTokens,
    codexDetails?.outputTokens,
    codexDetails?.cachedInputTokens,
    codexDetails?.reasoningOutputTokens,
  ];
}

function fingerprintsMatch(left: WorkspaceTokenUsageFingerprint, right: WorkspaceTokenUsageFingerprint): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class WorkspaceTokenUsageSummaryCache {
  private cachedDay: string | undefined;
  private cachedSummary: WorkspaceTokenUsageByModelSummary | undefined;
  private sessionEntries = new Map<
    string,
    { fingerprint: WorkspaceTokenUsageFingerprint; summary: WorkspaceTokenUsageByModelSummary }
  >();

  getSummary(sessions: WorkspaceTokenUsageSession[], now = Date.now()): WorkspaceTokenUsageByModelSummary {
    const currentDay = formatLocalDay(now);
    const dayChanged = this.cachedDay !== currentDay;
    const nextEntries = new Map<
      string,
      { fingerprint: WorkspaceTokenUsageFingerprint; summary: WorkspaceTokenUsageByModelSummary }
    >();
    let changed = !this.cachedSummary || dayChanged || this.sessionEntries.size !== sessions.length;

    for (const session of sessions) {
      const fingerprint = buildSessionFingerprint(session);
      const previous = this.sessionEntries.get(session.sessionId);
      if (!dayChanged && previous && fingerprintsMatch(previous.fingerprint, fingerprint)) {
        nextEntries.set(session.sessionId, previous);
        continue;
      }
      changed = true;
      nextEntries.set(session.sessionId, {
        fingerprint,
        summary: buildWorkspaceTokenUsageByModel([session], now),
      });
    }

    this.sessionEntries = nextEntries;
    this.cachedDay = currentDay;
    if (!changed && this.cachedSummary) {
      return { ...this.cachedSummary, generatedAt: now };
    }

    this.cachedSummary = mergeSessionSummaries(this.sessionEntries, now);
    return this.cachedSummary;
  }
}

function mergeSessionSummaries(
  entries: Map<string, { summary: WorkspaceTokenUsageByModelSummary }>,
  now: number,
): WorkspaceTokenUsageByModelSummary {
  const modelBuckets = new Map<string, TokenBucket>();
  const limitedReasons = new Set<string>();
  const dayModelTotals = new Map<string, Map<string, number>>();
  const longestRange = HISTOGRAM_RANGES.reduce((longest, range) => (range.days > longest.days ? range : longest));

  for (const [sessionId, { summary }] of entries) {
    for (const row of summary.models) {
      addUsageToBucket(modelBuckets, sessionId, row.model, row, {
        codexModelAttributionLimited: row.codexModelAttributionLimited,
      });
    }
    for (const reason of summary.history.limitedReasons) limitedReasons.add(reason);
    // Every shorter range is a suffix of the longest one.
    for (const bucket of summary.history.ranges.find((range) => range.id === longestRange.id)?.buckets ?? []) {
      for (const model of bucket.models) addDayModelTotal(dayModelTotals, bucket.date, model.model, model.totalTokens);
    }
  }

  const models = buildModelRows(modelBuckets);
  return {
    models,
    totalTokens: models.reduce((total, row) => total + row.totalTokens, 0),
    history: {
      ranges: buildRanges(dayModelTotals, now),
      limited: limitedReasons.size > 0,
      limitedReasons: [...limitedReasons],
    },
    generatedAt: now,
  };
}
