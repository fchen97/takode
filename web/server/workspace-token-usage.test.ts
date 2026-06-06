import { describe, expect, it } from "vitest";
import { buildWorkspaceTokenUsageByModel } from "./workspace-token-usage.js";
import type { BrowserIncomingMessage } from "./session-types.js";

function resultWithModelUsage(modelUsage: Record<string, unknown>): BrowserIncomingMessage {
  return {
    type: "result",
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

  it("attributes Codex cumulative session totals to the best recorded session model", () => {
    // Codex currently provides cumulative session token categories without a
    // per-model breakdown, so the aggregate uses the recorded session model and
    // marks the row as attribution-limited for reviewers.
    const summary = buildWorkspaceTokenUsageByModel([
      {
        sessionId: "codex-1",
        source: {
          state: {
            backend_type: "codex",
            model: "gpt-5.3-codex",
            codex_token_details: {
              inputTokens: 120,
              outputTokens: 30,
              cachedInputTokens: 50,
              reasoningOutputTokens: 10,
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

    expect(summary.models).toEqual([
      {
        model: "gpt-5.3-codex",
        totalTokens: 220,
        inputTokens: 125,
        outputTokens: 35,
        cachedInputTokens: 50,
        reasoningOutputTokens: 10,
        sessionCount: 2,
        codexModelAttributionLimited: true,
      },
    ]);
  });
});
