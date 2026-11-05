import { describe, expect, it, vi } from "vitest";
import { restorePersistedSessions } from "./session-registry-controller.js";

// Restart Server converts token usage once: each loaded session's retained
// samples (and history) become its ledger, saved with the session. Archived
// sessions load without history and are never rewritten here; their ledger
// is derived for display instead.
describe("token usage conversion on restore", () => {
  const usageState = () => ({
    backend_type: "codex",
    model: "gpt-6",
    cwd: "/repo",
    codex_token_details: {
      totalTokens: 900,
      inputTokens: 900,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      modelContextWindow: 1,
    },
    token_usage_samples: [
      { timestamp: Date.now() - 2_000, backend: "codex", model: "gpt-6", totalTokens: 100 },
      { timestamp: Date.now() - 1_000, backend: "codex", model: "gpt-6", totalTokens: 900 },
    ],
  });

  it("converts and saves loaded sessions, and leaves archived ones untouched", async () => {
    const sessions = new Map<string, any>();
    const persistConvertedTokenUsage = vi.fn();
    await restorePersistedSessions(
      sessions as never,
      [
        { id: "live", state: usageState(), messageHistory: [] },
        { id: "archived", state: usageState(), _searchDataOnly: true },
      ],
      {
        recoverToolStartTimesFromHistory: vi.fn(),
        finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
        scheduleCodexToolResultWatchdogs: vi.fn(),
        reconcileRestoredBoardState: vi.fn(async () => {}),
        persistConvertedTokenUsage,
      },
    );

    const live = sessions.get("live");
    expect(live.state.token_usage_samples).toBeUndefined();
    expect(live.state.token_usage_ledger.totals["gpt-6"].totalTokens).toBe(900);
    expect(Object.values(live.state.token_usage_ledger.convertedDays)).toEqual([{ "gpt-6": 800 }]);
    expect(persistConvertedTokenUsage).toHaveBeenCalledExactlyOnceWith(live);

    const archived = sessions.get("archived");
    expect(archived.state.token_usage_ledger).toBeUndefined();
    expect(archived.state.token_usage_samples).toHaveLength(2);
  });
});
