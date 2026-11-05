import { describe, expect, it } from "vitest";
import { findClaudeResults, parseRolloutLine, rebuildDays, type CodexTokenEvent } from "./token-usage-backfill.js";

// The backfill rebuilds Codex sessions' daily usage from Codex's rollout logs.
// It must count each token update once, and never count a whole cumulative
// total as one day's usage when the logs start mid-thread or a thread restarts.
describe("token usage backfill from Codex rollouts", () => {
  const day = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
  const event = (
    timestamp: number,
    totalTokens: number,
    lastTokens: number,
    model = "gpt-6",
    thread = "main",
  ): CodexTokenEvent => ({
    sessionId: "s",
    thread,
    timestamp,
    totalTokens,
    lastTokens,
    model,
  });
  const at = (iso: string) => Date.parse(iso);

  it("reads token updates and model changes from rollout lines", () => {
    expect(
      parseRolloutLine(
        JSON.stringify({ timestamp: "2026-11-05T01:00:00Z", type: "turn_context", payload: { model: "gpt-6" } }),
      ),
    ).toEqual({ kind: "model", model: "gpt-6" });
    expect(
      parseRolloutLine(
        JSON.stringify({
          timestamp: "2026-11-05T01:00:00Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { total_tokens: 500 }, last_token_usage: { total_tokens: 40 } },
          },
        }),
      ),
    ).toEqual({ kind: "tokens", event: { timestamp: at("2026-11-05T01:00:00Z"), totalTokens: 500, lastTokens: 40 } });
    expect(
      parseRolloutLine(
        JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: {} } } } }),
      ),
    ).toEqual({ kind: "subagent" });
    expect(parseRolloutLine(JSON.stringify({ type: "session_meta", payload: { source: "vscode" } }))).toBeNull();
    expect(parseRolloutLine('{"type":"response_item","payload":{}}')).toBeNull();
  });

  it("counts growth per day, once per update, only before the cutoff", () => {
    const days = rebuildDays(
      [
        event(at("2026-11-03T10:00:00Z"), 1_000, 50), // logs start mid-thread: only this call counts
        event(at("2026-11-03T11:00:00Z"), 1_300, 300),
        event(at("2026-11-03T11:00:00Z"), 1_300, 300), // duplicate from a copied rollout
        event(at("2026-11-03T11:30:00Z"), 1_300, 300), // repeated report of the same total
        event(at("2026-11-04T10:00:00Z"), 1_800, 500, "gpt-5"),
        event(at("2026-11-04T12:00:00Z"), 90, 90), // the total dropped: counter restart
        event(at("2026-11-04T13:00:00Z"), 200, 110),
        // A second thread interleaved with the first is counted on its own.
        event(at("2026-11-04T12:30:00Z"), 40, 40, "gpt-6", "other"),
        event(at("2026-11-04T12:40:00Z"), 70, 30, "gpt-6", "other"),
        event(at("2026-11-05T10:00:00Z"), 900, 700), // after the cutoff
      ],
      { cutoff: at("2026-11-05T00:00:00Z"), firstDay: "2026-10-01", fallbackModel: null, formatDay: day },
    );

    expect(days).toEqual({
      "2026-11-03": { "gpt-6": 350 },
      "2026-11-04": { "gpt-5": 500, "gpt-6": 270 },
    });
  });

  it("drops days before the kept window", () => {
    expect(
      rebuildDays([event(at("2026-09-01T10:00:00Z"), 100, 100)], {
        cutoff: Infinity,
        firstDay: "2026-10-01",
        fallbackModel: null,
        formatDay: day,
      }),
    ).toEqual({});
  });

  it("finds Claude results in any history envelope", () => {
    // History files nest messages differently (frozen log lines, journal
    // records, the hot file's array); only results with usage and a time count.
    const result = (timestamp: number) => ({
      type: "result",
      timestamp,
      data: { uuid: `r${timestamp}`, modelUsage: { opus: { inputTokens: timestamp } } },
    });
    expect(
      findClaudeResults([
        "history",
        2,
        "session",
        { messages: [result(1), { type: "assistant" }, { type: "result" }] },
      ]),
    ).toEqual([{ timestamp: 1, uuid: "r1", modelUsage: { opus: { inputTokens: 1 } } }]);
    expect(findClaudeResults([result(2), result(3)]).map((found) => found.timestamp)).toEqual([2, 3]);
  });
});
