import { describe, expect, it, vi } from "vitest";
import {
  handleCodexAdapterBrowserMessage,
  type CodexAdapterBrowserMessageDeps,
} from "./codex-adapter-browser-message-controller.js";
import type { BrowserIncomingMessage } from "../session-types.js";

function makeSession() {
  return {
    id: "codex-leader",
    state: { isOrchestrator: true, backend_type: "codex" },
    messageHistory: [] as BrowserIncomingMessage[],
    toolStartTimes: new Map<string, number>(),
    toolProgressOutput: new Map<string, string>(),
    isGenerating: false,
    activeTurnRoute: null,
    notifications: [],
    notificationCounter: 0,
    attentionReason: null,
  } as any;
}

function makeDeps(broadcasts: BrowserIncomingMessage[]): CodexAdapterBrowserMessageDeps {
  return {
    getLauncherSessionInfo: () => null,
    touchActivity: vi.fn(),
    clearOptimisticRunningTimer: vi.fn(),
    setCodexImageSendStage: vi.fn(),
    sanitizeCodexSessionPatch: (patch) => patch,
    cacheSlashCommandState: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    persistSession: vi.fn(),
    emitTakodeEvent: vi.fn(),
    freezeHistoryThroughCurrentTail: vi.fn(),
    injectCompactionRecovery: vi.fn(),
    trackCodexQuestCommands: vi.fn(),
    reconcileCodexQuestToolResult: vi.fn(async () => {}),
    collectCompletedToolStartTimes: () => [],
    buildToolResultPreviews: () => [],
    broadcastToBrowsers: (_session, message) => broadcasts.push(message),
    finalizeSupersededCodexTerminalTools: vi.fn(),
    isDuplicateCodexAssistantReplay: () => false,
    completeCodexTurnsForResult: vi.fn(() => true),
    clearCodexFreshTurnRequirement: vi.fn(),
    handleResultMessage: vi.fn(),
    queueCodexPendingStartBatch: vi.fn(),
    dispatchQueuedCodexTurns: vi.fn(),
    maybeFlushQueuedCodexMessages: vi.fn(),
    handleCodexPermissionRequest: vi.fn(),
    requestCodexLeaderRecycle: vi.fn(async () => ({ ok: true })),
    handleCodexResultErrorAutoPause: vi.fn(),
  };
}

describe("Codex adapter context thresholds", () => {
  it("does not let an older higher-budget threshold suppress a lower-budget model-switch recycle", async () => {
    // A prior 545K recycle watermark must not suppress a resumed 415K context
    // after the selected model lowers the active leader budget to 328.4K.
    const session = makeSession();
    const broadcasts: BrowserIncomingMessage[] = [];
    const deps = {
      ...makeDeps(broadcasts),
      getLauncherSessionInfo: vi.fn(() => ({
        isOrchestrator: true,
        codexLeaderCompactionMode: "recycle",
        codexLeaderRecycleThresholdTokens: 328_400,
        codexLeaderRecycleLineage: {
          recycleEvents: [
            {
              trigger: "threshold" as const,
              tokenUsage: { contextTokensUsed: 554_916, modelContextWindow: 545_000 },
            },
          ],
        },
      })),
    };

    await handleCodexAdapterBrowserMessage(
      session,
      {
        type: "session_update",
        session: {
          codex_token_details: {
            contextTokensUsed: 415_409,
            inputTokens: 68_455_353,
            outputTokens: 91_418,
            cachedInputTokens: 63_792_128,
            reasoningOutputTokens: 19_634,
            modelContextWindow: 2_876_389,
          },
        },
      },
      deps,
    );

    expect(deps.requestCodexLeaderRecycle).toHaveBeenCalledWith(session, "threshold");
    expect(session.state.context_used_percent).toBe(100);
    expect(session.state.codex_token_details).toMatchObject({
      contextTokensUsed: 415_409,
      modelContextWindow: 328_400,
    });
  });

  it("keeps suppressing repeated threshold recycles for the same leader budget", async () => {
    const session = makeSession();
    const broadcasts: BrowserIncomingMessage[] = [];
    const deps = {
      ...makeDeps(broadcasts),
      getLauncherSessionInfo: vi.fn(() => ({
        isOrchestrator: true,
        codexLeaderCompactionMode: "recycle",
        codexLeaderRecycleThresholdTokens: 545_000,
        codexLeaderRecycleLineage: {
          recycleEvents: [
            {
              trigger: "threshold" as const,
              tokenUsage: { contextTokensUsed: 554_916, modelContextWindow: 545_000 },
            },
          ],
        },
      })),
    };

    await handleCodexAdapterBrowserMessage(
      session,
      {
        type: "session_update",
        session: {
          codex_token_details: {
            contextTokensUsed: 550_000,
            inputTokens: 68_455_353,
            outputTokens: 91_418,
            cachedInputTokens: 63_792_128,
            reasoningOutputTokens: 19_634,
            modelContextWindow: 2_876_389,
          },
        },
      },
      deps,
    );

    expect(deps.requestCodexLeaderRecycle).not.toHaveBeenCalled();
  });

  it("does not threshold-recycle Codex leaders in compaction mode", async () => {
    const session = makeSession();
    const broadcasts: BrowserIncomingMessage[] = [];
    const deps = {
      ...makeDeps(broadcasts),
      getLauncherSessionInfo: vi.fn(() => ({
        isOrchestrator: true,
        codexLeaderCompactionMode: "compact" as const,
        codexLeaderRecycleThresholdTokens: 545_000,
      })),
    };

    await handleCodexAdapterBrowserMessage(
      session,
      {
        type: "session_update",
        session: {
          codex_token_details: {
            contextTokensUsed: 600_000,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            modelContextWindow: 3_027_778,
          },
        },
      },
      deps,
    );

    expect(deps.requestCodexLeaderRecycle).not.toHaveBeenCalled();
  });

  it("does not rewrite non-leader Codex context stats", async () => {
    const session = makeSession();
    session.state.isOrchestrator = false;
    const broadcasts: BrowserIncomingMessage[] = [];
    const deps = {
      ...makeDeps(broadcasts),
      getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: false })),
    };

    await handleCodexAdapterBrowserMessage(
      session,
      {
        type: "session_update",
        session: {
          context_used_percent: 18,
          codex_token_details: {
            contextTokensUsed: 518_366,
            inputTokens: 10,
            outputTokens: 20,
            cachedInputTokens: 30,
            reasoningOutputTokens: 40,
            modelContextWindow: 3_027_778,
          },
        },
      },
      deps,
    );

    expect(session.state.context_used_percent).toBe(18);
    expect(session.state.codex_token_details.modelContextWindow).toBe(3_027_778);
  });

  it("records Codex token usage growth in the session's ledger", async () => {
    // Each update adds the growth since the thread's previous cumulative total,
    // attributed to the model in use, to all-time and per-day totals.
    const session = makeSession();
    session.state.model = "gpt-5.5";
    const broadcasts: BrowserIncomingMessage[] = [];
    const update = (totalTokens: number) =>
      handleCodexAdapterBrowserMessage(
        session,
        {
          type: "session_update",
          session: {
            backend_type: "codex",
            codex_token_details: {
              totalTokens,
              inputTokens: totalTokens,
              outputTokens: 0,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 258_400,
            },
          },
        } as BrowserIncomingMessage,
        makeDeps(broadcasts),
      );

    await update(1_200_000);
    await update(1_500_000);

    const ledger = session.state.token_usage_ledger;
    expect(ledger?.counters.codex.totalTokens).toBe(1_500_000);
    expect(ledger?.totals["gpt-5.5"].totalTokens).toBe(1_500_000);
    expect(Object.values(ledger?.days ?? {})).toEqual([{ "gpt-5.5": 1_500_000 }]);
    expect(session.state.token_usage_samples).toBeUndefined();
  });
});
