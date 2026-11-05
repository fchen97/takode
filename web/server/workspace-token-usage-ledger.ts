import type {
  BrowserIncomingMessage,
  ClaudeModelTokenUsage,
  CLIResultMessage,
  SessionState,
  SessionTokenUsageSample,
} from "./session-types.js";
import type {
  SessionTokenUsageLedger,
  TokenUsageAmounts,
  TokenUsageBackfillSession,
  TokenUsageDays,
} from "./workspace-token-usage-types.js";

/**
 * Per-session token usage ledger: all-time and per-day totals kept up to date
 * on every usage update (see `SessionTokenUsageLedger`).
 *
 * It replaces the bounded list of cumulative samples the daily chart used to
 * be built from. That list dropped its oldest samples, so a busy session's
 * earlier days lost their usage while it kept working.
 */

/** Days kept per session: the longest chart range (30 days) plus margin. */
export const TOKEN_USAGE_DAYS_RETAINED = 35;

/** Codex reports one cumulative total for the whole thread, whichever models it used. */
export const CODEX_TOKEN_USAGE_COUNTER = "codex";

export function claudeTokenUsageCounter(model: string): string {
  return `claude:${model}`;
}

export type TokenUsageLedgerState = Partial<
  Pick<
    SessionState,
    | "backend_type"
    | "model"
    | "codex_token_details"
    | "claude_token_details"
    | "claude_model_usage"
    | "token_usage_samples"
    | "token_usage_ledger"
  >
>;

type PartialAmounts = Partial<Record<keyof TokenUsageAmounts, number>>;

export function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeModelLabel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === "unknown" || normalized === "default") return null;
  return trimmed;
}

/**
 * Normalize reported usage. Some providers report detail fields that overlap
 * with the raw total (Codex cached input is part of input), so an explicit
 * total wins and the parts are only a breakdown.
 */
export function toTokenUsageAmounts(usage: PartialAmounts | null | undefined): TokenUsageAmounts {
  const inputTokens = positiveNumber(usage?.inputTokens);
  const outputTokens = positiveNumber(usage?.outputTokens);
  const cachedInputTokens = positiveNumber(usage?.cachedInputTokens);
  const reasoningOutputTokens = positiveNumber(usage?.reasoningOutputTokens);
  return {
    totalTokens:
      positiveNumber(usage?.totalTokens) || inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
  };
}

export function addTokenUsageAmounts(left: TokenUsageAmounts | undefined, right: TokenUsageAmounts): TokenUsageAmounts {
  return {
    totalTokens: (left?.totalTokens ?? 0) + right.totalTokens,
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    cachedInputTokens: (left?.cachedInputTokens ?? 0) + right.cachedInputTokens,
    reasoningOutputTokens: (left?.reasoningOutputTokens ?? 0) + right.reasoningOutputTokens,
  };
}

/**
 * Usage between two cumulative readings of one counter. A lower total means
 * the counter restarted (a fresh Codex thread or backend process), so all of
 * the new reading is new usage.
 */
export function tokenUsageGrowth(previous: TokenUsageAmounts | undefined, next: TokenUsageAmounts): TokenUsageAmounts {
  if (!previous || next.totalTokens < previous.totalTokens) return next;
  return {
    totalTokens: next.totalTokens - previous.totalTokens,
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    cachedInputTokens: Math.max(0, next.cachedInputTokens - previous.cachedInputTokens),
    reasoningOutputTokens: Math.max(0, next.reasoningOutputTokens - previous.reasoningOutputTokens),
  };
}

export function formatLocalDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The first day key kept when `days` days end on the day of `now`. */
export function firstLocalDay(days: number, now: number): string {
  const date = new Date(now);
  const cursor = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  cursor.setDate(cursor.getDate() - (days - 1));
  return formatLocalDay(cursor.getTime());
}

export function dayTotal(models: Record<string, number> | undefined): number {
  let total = 0;
  for (const tokens of Object.values(models ?? {})) total += positiveNumber(tokens);
  return total;
}

function addToDays(days: TokenUsageDays, day: string, model: string, tokens: number): void {
  if (tokens <= 0) return;
  const models = { ...days[day] };
  models[model] = (models[model] ?? 0) + tokens;
  days[day] = models;
}

function pruneDays(days: TokenUsageDays | undefined, now: number): TokenUsageDays {
  const first = firstLocalDay(TOKEN_USAGE_DAYS_RETAINED, now);
  const kept: TokenUsageDays = {};
  for (const [day, models] of Object.entries(days ?? {})) if (day >= first) kept[day] = models;
  return kept;
}

export function emptyTokenUsageLedger(): SessionTokenUsageLedger {
  return { version: 1, counters: {}, totals: {}, days: {} };
}

export interface TokenUsageUpdate {
  counter: string;
  /** Model the growth is attributed to; growth is not recorded without one. */
  model: string | null;
  /** The counter's new cumulative usage. */
  usage: PartialAmounts;
  timestamp: number;
}

/** Add one cumulative reading to a ledger. Returns a new ledger; the input is not changed. */
export function recordTokenUsage(ledger: SessionTokenUsageLedger, update: TokenUsageUpdate): SessionTokenUsageLedger {
  const next = toTokenUsageAmounts(update.usage);
  if (next.totalTokens <= 0) return ledger;
  const previous = ledger.counters[update.counter];
  const growth = tokenUsageGrowth(previous, next);
  const result: SessionTokenUsageLedger = { ...ledger, counters: { ...ledger.counters, [update.counter]: next } };
  if (growth.totalTokens > 0 && update.model) {
    result.totals = { ...ledger.totals, [update.model]: addTokenUsageAmounts(ledger.totals[update.model], growth) };
    const days = { ...ledger.days };
    addToDays(days, formatLocalDay(update.timestamp), update.model, growth.totalTokens);
    result.days = pruneDays(days, update.timestamp);
  }
  return result;
}

function isResultMessage(
  message: BrowserIncomingMessage,
): message is Extract<BrowserIncomingMessage, { type: "result" }> {
  return message.type === "result";
}

function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function claudeModelUsageEntries(
  modelUsage: CLIResultMessage["modelUsage"] | undefined,
): Array<[string, ClaudeModelTokenUsage]> {
  const entries: Array<[string, ClaudeModelTokenUsage]> = [];
  for (const [rawModel, usage] of Object.entries(modelUsage ?? {})) {
    const model = normalizeModelLabel(rawModel);
    if (!model || !usage) continue;
    const nextUsage = {
      inputTokens: positiveNumber(usage.inputTokens),
      outputTokens: positiveNumber(usage.outputTokens),
      cachedInputTokens: positiveNumber(usage.cacheReadInputTokens) + positiveNumber(usage.cacheCreationInputTokens),
    };
    if (nextUsage.inputTokens + nextUsage.outputTokens + nextUsage.cachedInputTokens > 0) {
      entries.push([model, nextUsage]);
    }
  }
  return entries;
}

interface LegacyReading {
  counter: string;
  model: string;
  timestamp: number | null;
  usage: TokenUsageAmounts;
  fromHistory?: true;
}

/** Cumulative readings a session recorded before the ledger: retained samples and Claude results in history. */
function legacyReadings(state: TokenUsageLedgerState, messageHistory: BrowserIncomingMessage[] | undefined) {
  const readings: LegacyReading[] = [];
  for (const sample of state.token_usage_samples ?? []) {
    const model = normalizeModelLabel(sample?.model);
    const timestamp = validTimestamp(sample?.timestamp);
    const usage = toTokenUsageAmounts(sample as SessionTokenUsageSample);
    if (!model || !timestamp || usage.totalTokens <= 0) continue;
    const counter = sample.backend === "codex" ? CODEX_TOKEN_USAGE_COUNTER : claudeTokenUsageCounter(model);
    readings.push({ counter, model, timestamp, usage });
  }
  for (const message of messageHistory ?? []) {
    if (!isResultMessage(message)) continue;
    const timestamp = validTimestamp(message.timestamp);
    for (const [model, usage] of claudeModelUsageEntries((message.data as CLIResultMessage | undefined)?.modelUsage)) {
      const counter = claudeTokenUsageCounter(model);
      readings.push({ counter, model, timestamp, usage: toTokenUsageAmounts(usage), fromHistory: true });
    }
  }
  return readings;
}

/**
 * The ledger of a session recorded before ledgers existed, from what it kept:
 * the latest cumulative usage gives the all-time totals, and the growth
 * between its timestamped readings gives the days those readings cover. The
 * first reading of each counter has no earlier one, so the usage before it is
 * counted in totals but in no day. A drop to a lower total (a fresh Codex
 * thread) keeps the usage before the drop in totals.
 */
export function deriveLegacyTokenUsageLedger(
  state: TokenUsageLedgerState | undefined,
  messageHistory?: BrowserIncomingMessage[],
): SessionTokenUsageLedger {
  const ledger = emptyTokenUsageLedger();
  if (!state) return ledger;
  const readings = legacyReadings(state, messageHistory);

  if (state.backend_type !== "codex") {
    // Latest Claude usage per model: the last result in history, then the state map (updated with every result).
    const claudeUsage = new Map<string, TokenUsageAmounts>();
    for (const reading of readings) if (reading.fromHistory) claudeUsage.set(reading.model, reading.usage);
    for (const [rawModel, usage] of Object.entries(state.claude_model_usage ?? {})) {
      const model = normalizeModelLabel(rawModel);
      const amounts = toTokenUsageAmounts(usage);
      if (model && amounts.totalTokens > 0) claudeUsage.set(model, amounts);
    }
    if (claudeUsage.size === 0) {
      // Sessions from before the per-model map: the summed details, attributed to the session's model.
      const model = normalizeModelLabel(state.model);
      const amounts = toTokenUsageAmounts(state.claude_token_details);
      if (model && amounts.totalTokens > 0) claudeUsage.set(model, amounts);
    }
    for (const [model, usage] of claudeUsage) {
      ledger.counters[claudeTokenUsageCounter(model)] = usage;
      ledger.totals[model] = usage;
    }
  }

  if (state.backend_type === "codex") {
    const model = normalizeModelLabel(state.model);
    const usage = toTokenUsageAmounts(state.codex_token_details);
    if (usage.totalTokens > 0) {
      ledger.counters[CODEX_TOKEN_USAGE_COUNTER] = usage;
      if (model) ledger.totals[model] = usage;
    }
  }

  // Days from the growth between timestamped readings, and usage from before counter restarts.
  const convertedDays: TokenUsageDays = {};
  const byCounter = new Map<string, LegacyReading[]>();
  for (const reading of readings) {
    if (reading.timestamp === null) continue;
    // A session records one backend's usage; ignore readings of the other kind.
    if ((reading.counter === CODEX_TOKEN_USAGE_COUNTER) !== (state.backend_type === "codex")) continue;
    const group = byCounter.get(reading.counter) ?? [];
    group.push(reading);
    byCounter.set(reading.counter, group);
  }
  for (const group of byCounter.values()) {
    group.sort(byTimestamp);
    let previous: LegacyReading | null = null;
    for (const reading of group) {
      if (previous) {
        if (reading.usage.totalTokens < previous.usage.totalTokens) {
          ledger.totals[previous.model] = addTokenUsageAmounts(ledger.totals[previous.model], previous.usage);
        }
        const growth = tokenUsageGrowth(previous.usage, reading.usage);
        addToDays(convertedDays, formatLocalDay(reading.timestamp!), reading.model, growth.totalTokens);
      }
      previous = reading;
    }
  }
  if (Object.keys(convertedDays).length > 0) ledger.convertedDays = convertedDays;
  return ledger;
}

function byTimestamp(left: LegacyReading, right: LegacyReading): number {
  return (left.timestamp ?? 0) - (right.timestamp ?? 0);
}

/** The session's ledger, or one derived from what it recorded before ledgers, without changing the state. */
export function tokenUsageLedgerFor(
  state: TokenUsageLedgerState | undefined,
  messageHistory?: BrowserIncomingMessage[],
): SessionTokenUsageLedger {
  return state?.token_usage_ledger ?? deriveLegacyTokenUsageLedger(state, messageHistory);
}

/**
 * Give a session its ledger, converting what it recorded before ledgers, and
 * retire the samples. Call with the session's full message history, before the
 * state takes in the update being recorded. Returns whether the state changed.
 */
export function ensureTokenUsageLedger(
  state: TokenUsageLedgerState,
  messageHistory: BrowserIncomingMessage[] | undefined,
  now: number,
): boolean {
  if (state.token_usage_ledger) return false;
  const derived = deriveLegacyTokenUsageLedger(state, messageHistory);
  const ledger: SessionTokenUsageLedger = { ...derived, trackingSince: now };
  if (derived.convertedDays) ledger.convertedDays = pruneDays(derived.convertedDays, now);
  state.token_usage_ledger = ledger;
  delete state.token_usage_samples;
  return true;
}

/** Record a Codex token usage update. `details` is the thread's new cumulative usage. */
export function recordCodexTokenUsage(
  state: TokenUsageLedgerState,
  details: SessionState["codex_token_details"] | undefined,
  timestamp: number,
): void {
  if (!details) return;
  state.token_usage_ledger = recordTokenUsage(state.token_usage_ledger ?? emptyTokenUsageLedger(), {
    counter: CODEX_TOKEN_USAGE_COUNTER,
    model: normalizeModelLabel(state.model),
    usage: details,
    timestamp,
  });
}

/**
 * Record a Claude result's cumulative per-model usage. The per-model map also
 * stays in state for display.
 */
export function recordClaudeResultTokenUsage(
  state: TokenUsageLedgerState,
  modelUsage: CLIResultMessage["modelUsage"] | undefined,
  timestamp: number,
): void {
  const entries = claudeModelUsageEntries(modelUsage);
  if (entries.length === 0) return;
  state.claude_model_usage = { ...state.claude_model_usage, ...Object.fromEntries(entries) };
  let ledger = state.token_usage_ledger ?? emptyTokenUsageLedger();
  for (const [model, usage] of entries) {
    ledger = recordTokenUsage(ledger, { counter: claudeTokenUsageCounter(model), model, usage, timestamp });
  }
  state.token_usage_ledger = ledger;
}

/**
 * A session's usage per day: live days plus the days from before live
 * recording. For those earlier days a backfill rebuilt from backend logs
 * replaces the converted day when it shows more, which it does when the
 * session had already dropped samples. A backfill whose cutoff is after live
 * recording began would overlap the live days, so it is ignored.
 */
export function tokenUsageDaysFor(
  ledger: SessionTokenUsageLedger,
  backfill?: Pick<TokenUsageBackfillSession, "cutoff" | "days"> | null,
): TokenUsageDays {
  const days: TokenUsageDays = { ...ledger.convertedDays };
  if (backfill && (ledger.trackingSince === undefined || backfill.cutoff <= ledger.trackingSince)) {
    for (const [day, models] of Object.entries(backfill.days)) {
      if (dayTotal(models) > dayTotal(days[day])) days[day] = models;
    }
  }
  for (const [day, models] of Object.entries(ledger.days)) {
    for (const [model, tokens] of Object.entries(models)) addToDays(days, day, model, positiveNumber(tokens));
  }
  return days;
}
