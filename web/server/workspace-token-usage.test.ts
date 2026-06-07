import { describe, expect, it } from "vitest";
import { buildWorkspaceTokenUsageByModel } from "./workspace-token-usage.js";
import type { BrowserIncomingMessage } from "./session-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function localDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function resultWithModelUsage(modelUsage: Record<string, unknown>, timestamp?: number): BrowserIncomingMessage {
  return {
    type: "result",
    ...(typeof timestamp === "number" ? { timestamp } : {}),
    data: {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: modelUsage as never,
      uuid: "result-uuid",
      session_id: "cli-session",
    },
  } as BrowserIncomingMessage;
}

describe("buildWorkspaceTokenUsageByModel", () => {
  it("uses the latest cumulative Claude modelUsage per model without summing every result", () => {
    // Claude modelUsage is cumulative within a session, so aggregating every
    // result would double count older turns. The latest value seen for each
    // model is the per-session contribution.
    const summary = buildWorkspaceTokenUsageByModel(
      [
        {
          sessionId: "s1",
          source: {
            state: { backend_type: "claude", model: "claude-sonnet" },
            messageHistory: [
              resultWithModelUsage({
                "claude-sonnet": {
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheReadInputTokens: 25,
                  cacheCreationInputTokens: 10,
                },
              }),
              resultWithModelUsage({
                "claude-sonnet": {
                  inputTokens: 180,
                  outputTokens: 70,
                  cacheReadInputTokens: 30,
                  cacheCreationInputTokens: 20,
                },
                "claude-opus": {
                  inputTokens: 20,
                  outputTokens: 5,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              }),
            ],
          },
        },
      ],
      123,
    );

    expect(summary.generatedAt).toBe(123);
    expect(summary.totalTokens).toBe(325);
    expect(summary.models).toEqual([
      {
        model: "claude-sonnet",
        totalTokens: 300,
        inputTokens: 180,
        outputTokens: 70,
        cachedInputTokens: 50,
        reasoningOutputTokens: 0,
        sessionCount: 1,
      },
      {
        model: "claude-opus",
        totalTokens: 25,
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        sessionCount: 1,
      },
    ]);
  });

  it("omits empty, unknown, default, and zero-only usage rows", () => {
    // The visible UI should not imply usage exists for placeholder labels or
    // sessions that only have zero-valued token metrics.
    const summary = buildWorkspaceTokenUsageByModel([
      {
        sessionId: "s1",
        source: {
          state: { backend_type: "claude", model: "" },
          messageHistory: [
            resultWithModelUsage({
              "": { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              unknown: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              default: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              "claude-haiku": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            }),
          ],
        },
      },
      {
        sessionId: "s2",
        source: {
          state: {
            backend_type: "codex",
            model: "default",
            codex_token_details: {
              inputTokens: 10,
              outputTokens: 0,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 200_000,
            },
          },
        },
      },
    ]);

    expect(summary.models).toEqual([]);
    expect(summary.totalTokens).toBe(0);
  });

  it("uses Codex raw cumulative totals while preserving the category breakdown", () => {
    // Codex currently provides cumulative session token categories without a
    // per-model breakdown, so the aggregate uses the recorded session model and
    // marks the row as attribution-limited for reviewers. Codex totalTokens is
    // authoritative because cached/reasoning detail fields can overlap with the
    // raw total and would overcount if summed into the row total.
    const summary = buildWorkspaceTokenUsageByModel([
      {
        sessionId: "codex-1",
        source: {
          state: {
            backend_type: "codex",
            model: "gpt-5.3-codex",
            codex_token_details: {
              totalTokens: 1_200_000,
              inputTokens: 1_150_000,
              outputTokens: 50_000,
              cachedInputTokens: 930_000,
              reasoningOutputTokens: 2_000,
              modelContextWindow: 200_000,
            },
          },
        },
      },
      {
        sessionId: "codex-2",
        source: {
          state: {
            backend_type: "codex",
            model: "gpt-5.3-codex",
            codex_token_details: {
              totalTokens: 10,
              inputTokens: 5,
              outputTokens: 5,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 200_000,
            },
          },
        },
      },
    ]);

    expect(summary.totalTokens).toBe(1_200_010);
    expect(summary.models).toEqual([
      {
        model: "gpt-5.3-codex",
        totalTokens: 1_200_010,
        inputTokens: 1_150_005,
        outputTokens: 50_005,
        cachedInputTokens: 930_000,
        reasoningOutputTokens: 2_000,
        sessionCount: 2,
        codexModelAttributionLimited: true,
      },
    ]);
  });

  it("builds daily histogram buckets from timestamped cumulative usage deltas", () => {
    // Daily buckets use deltas between timestamped cumulative snapshots. The
    // first sample for a session/model is a baseline, not usage for that day.
    const now = new Date(2026, 0, 8, 12).getTime();
    const day3 = now - 3 * DAY_MS;
    const day2 = now - 2 * DAY_MS;
    const day1 = now - DAY_MS;
    const summary = buildWorkspaceTokenUsageByModel(
      [
        {
          sessionId: "s1",
          source: {
            state: {
              backend_type: "codex",
              model: "gpt-5.5",
              codex_token_details: {
                totalTokens: 220,
                inputTokens: 180,
                outputTokens: 40,
                cachedInputTokens: 120,
                reasoningOutputTokens: 0,
                modelContextWindow: 200_000,
              },
              token_usage_samples: [
                { timestamp: day3, backend: "codex", model: "gpt-5.5", totalTokens: 100 },
                { timestamp: day2, backend: "codex", model: "gpt-5.5", totalTokens: 150 },
                { timestamp: day1, backend: "codex", model: "gpt-5.5", totalTokens: 220 },
                { timestamp: day2, backend: "claude", model: "opus 4.7", inputTokens: 20, outputTokens: 0 },
                { timestamp: day1, backend: "claude", model: "opus 4.7", inputTokens: 45, outputTokens: 0 },
              ],
            },
          },
        },
      ],
      now,
    );

    const week = summary.history.ranges.find((range) => range.id === "week")!;
    expect(week.totalTokens).toBe(145);
    expect(week.buckets.find((bucket) => bucket.date === localDateString(day2))).toMatchObject({
      totalTokens: 50,
      models: [{ model: "gpt-5.5", totalTokens: 50 }],
    });
    expect(week.buckets.find((bucket) => bucket.date === localDateString(day1))).toMatchObject({
      totalTokens: 95,
      models: [
        { model: "gpt-5.5", totalTokens: 70 },
        { model: "opus 4.7", totalTokens: 25 },
      ],
    });
  });

  it("limits daily history to timestamped samples without inventing unsupported buckets", () => {
    const now = new Date(2026, 0, 8, 12).getTime();
    const summary = buildWorkspaceTokenUsageByModel(
      [
        {
          sessionId: "s1",
          source: {
            state: { backend_type: "claude", model: "opus 4.7" },
            messageHistory: [
              resultWithModelUsage({
                "opus 4.7": {
                  inputTokens: 100,
                  outputTokens: 20,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                },
              }),
            ],
          },
        },
      ],
      now,
    );

    const week = summary.history.ranges.find((range) => range.id === "week")!;
    expect(summary.totalTokens).toBe(120);
    expect(week.totalTokens).toBe(0);
    expect(summary.history.limited).toBe(true);
    expect(summary.history.limitedReasons).toContain(
      "Some cumulative result totals have no timestamp, so they are excluded from daily buckets.",
    );
  });
});
