import { describe, expect, it } from "vitest";
import {
  mergeCarriedOverTokenUsage,
  parseCarriedOverTokenUsage,
  pickCarriedOverTokenUsageState,
  trimTokenUsageSamplesForCarryover,
} from "./workspace-token-usage-carryover.js";
import type { SessionTokenUsageSample } from "./session-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("token usage carry-over", () => {
  it("keeps recent samples plus the last earlier one per model as the daily baseline", () => {
    // A daily bucket counts growth since the previous sample, so dropping the
    // baseline would lose the first recent day's usage; anything older can
    // never reach the 30-day histogram again.
    const cutoff = 100 * DAY_MS;
    const sample = (day: number, model: string, totalTokens: number): SessionTokenUsageSample => ({
      timestamp: day * DAY_MS,
      backend: "codex",
      model,
      totalTokens,
    });
    const samples = [
      sample(10, "a", 1),
      sample(50, "a", 2),
      sample(60, "b", 3),
      sample(101, "a", 4),
      sample(102, "a", 5),
    ];

    expect(trimTokenUsageSamplesForCarryover(samples, cutoff)).toEqual([
      sample(50, "a", 2),
      sample(60, "b", 3),
      sample(101, "a", 4),
      sample(102, "a", 5),
    ]);
  });

  it("picks only token fields and skips sessions without usage", () => {
    const now = 200 * DAY_MS;
    expect(
      pickCarriedOverTokenUsageState(
        {
          backend_type: "claude-sdk",
          model: "claude-opus",
          cwd: "/repo",
          claude_token_details: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, modelContextWindow: 9 },
        },
        now,
      ),
    ).toEqual({
      backend_type: "claude-sdk",
      model: "claude-opus",
      claude_token_details: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, modelContextWindow: 9 },
    });
    expect(pickCarriedOverTokenUsageState({ backend_type: "codex", model: "gpt-5.5" }, now)).toBeNull();
    expect(pickCarriedOverTokenUsageState(undefined, now)).toBeNull();
  });

  it("merges a new handoff's sessions into earlier carry-overs and ignores malformed files", () => {
    const earlier = parseCarriedOverTokenUsage({
      version: 1,
      sessions: [{ sessionId: "a", state: { model: "old" } }, { sessionId: 3 }, "junk"],
    });
    expect(earlier).toEqual([{ sessionId: "a", state: { model: "old" } }]);
    expect(parseCarriedOverTokenUsage({ version: 2, sessions: [] })).toEqual([]);

    expect(
      mergeCarriedOverTokenUsage(earlier, [
        { sessionId: "a", state: { model: "new" } as never },
        { sessionId: "b", state: { model: "b" } as never },
      ]),
    ).toEqual({
      version: 1,
      sessions: [
        { sessionId: "a", state: { model: "new" } },
        { sessionId: "b", state: { model: "b" } },
      ],
    });
  });
});
