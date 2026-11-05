import { describe, expect, it } from "vitest";
import {
  deriveLegacyTokenUsageLedger,
  ensureTokenUsageLedger,
  recordCodexTokenUsage,
  tokenUsageDaysFor,
} from "./workspace-token-usage-ledger.js";
import { buildWorkspaceTokenUsageByModel } from "./workspace-token-usage.js";
import type { BrowserIncomingMessage, SessionState } from "./session-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function localDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

type CodexState = Pick<
  SessionState,
  "backend_type" | "model" | "codex_token_details" | "token_usage_samples" | "token_usage_ledger"
>;

function codexDetails(totalTokens: number): NonNullable<SessionState["codex_token_details"]> {
  return {
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    modelContextWindow: 200_000,
  };
}

/** One Codex token update: the thread's new cumulative total, as the bridge records it. */
function codexUpdate(state: CodexState, totalTokens: number, timestamp: number, model = state.model): void {
  state.model = model;
  state.codex_token_details = codexDetails(totalTokens);
  recordCodexTokenUsage(state, state.codex_token_details, timestamp);
}

function weekBuckets(sessions: Parameters<typeof buildWorkspaceTokenUsageByModel>[0], now: number) {
  const week = buildWorkspaceTokenUsageByModel(sessions, now).history.ranges.find((range) => range.id === "week")!;
  return Object.fromEntries(week.buckets.map((bucket) => [bucket.date, bucket.totalTokens]));
}

describe("token usage ledger", () => {
  it("keeps a past day's usage while the session keeps working", () => {
    // The bug this ledger fixes: the chart used to be built from each session's
    // last 1,500 cumulative samples, and a busy Codex session writes one per
    // model call, so yesterday's usage disappeared as the session kept working.
    const yesterday = new Date(2026, 10, 4, 12).getTime();
    const today = yesterday + DAY_MS;
    const state: CodexState = { backend_type: "codex", model: "gpt-6" };
    let total = 0;
    for (let call = 0; call < 2_000; call += 1) codexUpdate(state, (total += 100), yesterday + call * 1_000);
    const session = { sessionId: "busy", source: { state } };
    expect(weekBuckets([session], today)[localDateString(yesterday)]).toBe(200_000);

    for (let call = 0; call < 3_000; call += 1) codexUpdate(state, (total += 100), today + call * 1_000);

    const buckets = weekBuckets([session], today + 3_000_000);
    expect(buckets[localDateString(yesterday)]).toBe(200_000);
    expect(buckets[localDateString(today)]).toBe(300_000);
  });

  it("keeps earlier usage in all-time totals when Codex starts a fresh thread", () => {
    // A fresh thread (leader recycle, failed resume) restarts Codex's
    // cumulative total near zero; the drop is new usage, not lost usage.
    const now = new Date(2026, 10, 5, 12).getTime();
    const state: CodexState = { backend_type: "codex", model: "gpt-6" };
    codexUpdate(state, 1_000, now - 3 * HOUR_MS);
    codexUpdate(state, 9_000, now - 2 * HOUR_MS);
    codexUpdate(state, 80, now - HOUR_MS);
    codexUpdate(state, 500, now);

    const summary = buildWorkspaceTokenUsageByModel([{ sessionId: "recycled", source: { state } }], now);
    expect(summary.totalTokens).toBe(9_500);
    expect(weekBuckets([{ sessionId: "recycled", source: { state } }], now)[localDateString(now)]).toBe(9_500);
  });

  it("attributes Codex usage to the model of each update across model switches", () => {
    // Codex reports one total for the whole thread; attributing each update's
    // growth to the model in use neither drops nor double counts a switch.
    const now = new Date(2026, 10, 5, 12).getTime();
    const state: CodexState = { backend_type: "codex", model: "model-a" };
    codexUpdate(state, 100, now - 3 * HOUR_MS);
    codexUpdate(state, 300, now - 2 * HOUR_MS, "model-b");
    codexUpdate(state, 600, now - HOUR_MS, "model-a");

    const summary = buildWorkspaceTokenUsageByModel([{ sessionId: "switching", source: { state } }], now);
    expect(summary.models.map((row) => [row.model, row.totalTokens])).toEqual([
      ["model-a", 400],
      ["model-b", 200],
    ]);
    expect(summary.history.ranges[0].totalTokens).toBe(600);
  });

  it("converts a session's samples and history once, keeping its chart and dropping the samples", () => {
    // Restart Server converts every loaded session. What the chart showed from
    // the samples and history must still show, and the samples are retired.
    const now = new Date(2026, 10, 5, 12).getTime();
    const state: CodexState = {
      backend_type: "codex",
      model: "gpt-6",
      codex_token_details: codexDetails(700),
      token_usage_samples: [
        { timestamp: now - 2 * DAY_MS, backend: "codex", model: "gpt-6", totalTokens: 100 },
        { timestamp: now - DAY_MS, backend: "codex", model: "gpt-6", totalTokens: 400 },
        { timestamp: now - HOUR_MS, backend: "codex", model: "gpt-6", totalTokens: 700 },
      ],
    };
    const before = buildWorkspaceTokenUsageByModel([{ sessionId: "s", source: { state: { ...state } } }], now);

    expect(ensureTokenUsageLedger(state, [], now)).toBe(true);
    expect(ensureTokenUsageLedger(state, [], now + 1)).toBe(false);
    expect(state.token_usage_samples).toBeUndefined();
    expect(state.token_usage_ledger?.trackingSince).toBe(now);
    const after = buildWorkspaceTokenUsageByModel([{ sessionId: "s", source: { state } }], now);
    expect(after.models).toEqual(before.models);
    expect(after.history.ranges).toEqual(before.history.ranges);

    // Later updates add only their growth since the converted total.
    codexUpdate(state, 1_000, now + HOUR_MS);
    expect(buildWorkspaceTokenUsageByModel([{ sessionId: "s", source: { state } }], now).totalTokens).toBe(1_000);
  });

  it("keeps usage from before a counter restart that the old samples recorded", () => {
    // Sessions converted from samples may already have lost a pre-restart total
    // from their cumulative details; the samples still show it.
    const now = new Date(2026, 10, 5, 12).getTime();
    const ledger = deriveLegacyTokenUsageLedger({
      backend_type: "codex",
      model: "gpt-6",
      codex_token_details: codexDetails(200),
      token_usage_samples: [
        { timestamp: now - 2 * HOUR_MS, backend: "codex", model: "gpt-6", totalTokens: 5_000 },
        { timestamp: now - HOUR_MS, backend: "codex", model: "gpt-6", totalTokens: 80 },
        { timestamp: now, backend: "codex", model: "gpt-6", totalTokens: 200 },
      ],
    });
    expect(ledger.totals["gpt-6"].totalTokens).toBe(5_200);
    expect(ledger.convertedDays).toEqual({ [localDateString(now)]: { "gpt-6": 200 } });
  });

  it("converts Claude days from loaded history results", () => {
    const now = new Date(2026, 10, 5, 12).getTime();
    const result = (inputTokens: number, timestamp: number) =>
      ({
        type: "result",
        timestamp,
        data: {
          modelUsage: {
            "claude-opus": { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        },
      }) as unknown as BrowserIncomingMessage;
    const state: Pick<SessionState, "backend_type" | "model" | "token_usage_ledger"> = {
      backend_type: "claude-sdk",
      model: "claude-opus",
    };
    ensureTokenUsageLedger(state, [result(10, now - DAY_MS), result(60, now)], now);

    expect(state.token_usage_ledger?.totals["claude-opus"].totalTokens).toBe(60);
    expect(state.token_usage_ledger?.convertedDays).toEqual({ [localDateString(now)]: { "claude-opus": 50 } });
  });
});

describe("token usage backfill", () => {
  const now = new Date(2026, 10, 5, 12).getTime();
  const yesterday = localDateString(now - DAY_MS);
  const today = localDateString(now);

  it("replaces a converted day with the rebuilt one when it shows more", () => {
    const ledger = {
      version: 1 as const,
      trackingSince: now,
      counters: {},
      totals: {},
      days: { [today]: { "gpt-6": 5 } },
      convertedDays: { [yesterday]: { "gpt-6": 40 }, [today]: { "gpt-6": 30 } },
    };
    const days = tokenUsageDaysFor(ledger, {
      cutoff: now,
      days: { [yesterday]: { "gpt-6": 900, "gpt-5": 100 }, [today]: { "gpt-6": 20 } },
    });

    // Yesterday rebuilt; today keeps the larger converted part plus live usage.
    expect(days).toEqual({ [yesterday]: { "gpt-6": 900, "gpt-5": 100 }, [today]: { "gpt-6": 35 } });
  });

  it("ignores a backfill whose cutoff is after live recording began, which would double count", () => {
    const ledger = {
      version: 1 as const,
      trackingSince: now,
      counters: {},
      totals: {},
      days: { [today]: { "gpt-6": 5 } },
    };
    expect(tokenUsageDaysFor(ledger, { cutoff: now + 1, days: { [today]: { "gpt-6": 900 } } })).toEqual({
      [today]: { "gpt-6": 5 },
    });
  });

  it("applies to sessions shown from their old samples, which have no live recording", () => {
    const summary = buildWorkspaceTokenUsageByModel(
      [
        {
          sessionId: "archived",
          source: { state: { backend_type: "codex", model: "gpt-6", codex_token_details: codexDetails(1_000) } },
          backfill: { sessionId: "archived", cutoff: now, days: { [yesterday]: { "gpt-6": 1_000 } } },
        },
      ],
      now,
    );
    expect(summary.history.ranges[0].totalTokens).toBe(1_000);
    expect(summary.history.limited).toBe(false);
  });
});
