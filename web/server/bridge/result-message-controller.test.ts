import { describe, expect, it, vi } from "vitest";
import { handleResultMessage, type ResultMessageSessionLike } from "./claude-message-controller.js";
import type { BrowserIncomingMessage, CLIResultMessage, PermissionRequest, SessionState } from "../session-types.js";
import { THREAD_ROUTING_REMINDER_SOURCE_ID } from "../../shared/thread-routing-reminder.js";
import {
  QUEST_THREAD_REMINDER_SOURCE_ID,
  QUEST_THREAD_REMINDER_SOURCE_LABEL,
} from "../../shared/quest-thread-reminder.js";

function makeState(): ResultMessageSessionLike["state"] {
  return {
    model: "claude-sonnet-4-5-20250929",
    total_cost_usd: 0,
    user_turn_count: 0,
    agent_turn_count: 0,
    num_turns: 0,
    context_used_percent: 0,
    claude_token_details: undefined,
    leaderThreadStatuses: undefined,
  };
}

function makeSession(): ResultMessageSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    cliResuming: false,
    messageHistory: [],
    notifications: [],
    leaderThreadOutcomeValidatedHistoryLength: 0,
    state: makeState(),
    diffStatsDirty: false,
    generationStartedAt: undefined,
    interruptedDuringTurn: false,
    queuedTurnStarts: 0,
    queuedTurnInterruptSources: [],
    userMessageIdsThisTurn: [],
    isGenerating: false,
    lastOutboundUserNdjson: null,
    pendingPermissions: new Map<string, PermissionRequest>(),
    toolStartTimes: new Map(),
  };
}

function makeResult(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 1,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    uuid: "result-1",
    session_id: "s1",
    ...overrides,
  };
}

function makeAssistant(id: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: Date.now(),
  };
}

function makeDeps() {
  return {
    hasResultReplay: vi.fn(() => false),
    reconcileReplayState: vi.fn(() => ({ clearedResidualState: false })),
    drainInlineQueuedClaudeTurns: vi.fn(() => false),
    markTurnInterrupted: vi.fn(),
    getCurrentTurnTriggerSource: vi.fn((): "user" | "leader" | "system" | "unknown" => "user"),
    reconcileTerminalResultState: vi.fn(),
    finalizeOrphanedTerminalToolsOnResult: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    freezeHistoryThroughCurrentTail: vi.fn(),
    cancelPermissionNotification: vi.fn(),
    onSessionActivityStateChanged: vi.fn(),
    onResultAttentionAndNotifications: vi.fn(),
    validateLeaderThreadOutcomes: vi.fn(),
    onTurnCompleted: vi.fn(),
    injectUserMessage: vi.fn(),
  };
}

describe("result-message-controller", () => {
  // Replayed terminal results after reconnect should only reconcile lifecycle drift;
  // they must not append duplicate result history or retrigger normal completion flow.
  it("reconciles replayed results without appending duplicate history", () => {
    const session = makeSession();
    const deps = makeDeps();
    deps.hasResultReplay.mockReturnValue(true);
    deps.reconcileReplayState.mockReturnValue({ clearedResidualState: true });

    handleResultMessage(session, makeResult(), deps);

    expect(session.messageHistory).toHaveLength(0);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "status_change", status: "idle" }),
    );
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.onTurnCompleted).not.toHaveBeenCalled();
  });

  // Covers the normal result path where stale pending permissions are cancelled,
  // the result is persisted, and downstream notification hooks still fire once.
  it("appends the result, clears stale permissions, and notifies downstream handlers", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1,
    } as BrowserIncomingMessage);
    session.pendingPermissions.set("perm-1", {
      request_id: "perm-1",
      tool_name: "Bash",
      input: { command: "pwd" },
      tool_use_id: "tool-1",
      timestamp: 1,
    });
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ total_cost_usd: 2 }), deps);

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ total_cost_usd: 2 }),
      }),
    );
    expect(deps.cancelPermissionNotification).toHaveBeenCalledWith("s1", "perm-1");
    expect(deps.onSessionActivityStateChanged).toHaveBeenCalledWith("s1", "result_cleared_permissions");
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
  });

  it("keeps transient provider retries out of durable history and terminal hooks", () => {
    // Long-lived network recovery can produce many attempts. The exact retry
    // owner lives in session state, so raw terminal rows must not accumulate.
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: "stream disconnected before completion",
        codex_provider_retry: {
          family: "model_backend_stream_error",
          ownerId: "input-1",
          attempt: 7,
          maxAttempts: null,
          startedAt: 100,
        },
      }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(0);
    // Transient broadcasts may carry transport metadata such as a timestamp;
    // keep the retry payload and no-buffer contract authoritative.
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          result: "Transient provider request failed; Takode is retrying.",
          errors: undefined,
          codex_provider_retry: expect.objectContaining({ ownerId: "input-1", attempt: 7 }),
        }),
      }),
      { skipBuffer: true },
    );
    expect(JSON.stringify(deps.broadcastToBrowsers.mock.calls)).not.toContain("stream disconnected before completion");
    expect(deps.freezeHistoryThroughCurrentTail).not.toHaveBeenCalled();
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.reconcileTerminalResultState).toHaveBeenCalledWith(session);
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).not.toHaveBeenCalled();
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("normalizes result turn counts from backend history instead of CLI num_turns", () => {
    // Protects both Codex per-result counts and Claude compaction-reset counts:
    // browser-visible result/session_update turn metrics come from history.
    const session = makeSession();
    session.backendType = "codex";
    session.messageHistory.push(
      { type: "user_message", id: "u1", content: "first", timestamp: 1 } as BrowserIncomingMessage,
      {
        type: "user_message",
        id: "event-1",
        content: "timer",
        timestamp: 2,
        agentSource: { sessionId: "timer", sessionLabel: "Timer" },
      } as BrowserIncomingMessage,
      makeAssistant("a1"),
      { type: "result", data: makeResult({ num_turns: 1 }) } as BrowserIncomingMessage,
      { type: "user_message", id: "u2", content: "second", timestamp: 3 } as BrowserIncomingMessage,
      makeAssistant("a2"),
    );
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ num_turns: 1, uuid: "current-result" }), deps);

    expect(session.state).toMatchObject({
      user_turn_count: 2,
      agent_turn_count: 2,
      num_turns: 2,
    });
    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ num_turns: 2, uuid: "current-result" }),
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({
          user_turn_count: 2,
          agent_turn_count: 2,
          num_turns: 2,
        }),
      }),
    );
  });

  it("marks Claude user-control diagnostics as interrupted so they do not trigger error handling", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        stop_reason: "tool_use",
      }),
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        interrupted: true,
        data: expect.objectContaining({
          is_error: true,
          stop_reason: "tool_use",
        }),
      }),
    );
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("marks Claude user-control diagnostics from errors[] as interrupted", () => {
    // Claude WebSocket interruption diagnostics are observed in errors[] when
    // the result field is absent; this producer shape previously leaked into chat.
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        stop_reason: "tool_use",
      }),
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "result", interrupted: true }));
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
  });

  it("skips leader-thread outcome validation for interrupted generation results", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ stop_reason: "interrupted" }), deps);

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "result", interrupted: true }));
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
  });

  it("keeps normal completed leader turns on the outcome validation path", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-status",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "[thread:main] {[(Thread Ready: main | done)]}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1,
      threadKey: "main",
    } as BrowserIncomingMessage);
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("leader");

    handleResultMessage(session, makeResult({ uuid: "normal-completed-leader-result" }), deps);

    const result = session.messageHistory.at(-1) as Extract<BrowserIncomingMessage, { type: "result" }>;
    expect(result.type).toBe("result");
    expect(result.interrupted).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "leader");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ uuid: "normal-completed-leader-result" }),
      "leader",
    );
  });

  it("injects a synthetic thread-routing reminder after unrouted leader output", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q970",
        content: "continue in quest thread",
        timestamp: 1,
        threadKey: "q-970",
        questId: "q-970",
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Unrouted leader response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Unrouted leader response",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("leader");

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("[Thread routing reminder]"),
      { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      undefined,
      {
        threadKey: "q-970",
        questId: "q-970",
        threadRefs: [{ threadKey: "q-970", questId: "q-970", source: "explicit" }],
      },
    );
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("Missing thread marker"),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).toContain("on visible leader text");
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).not.toContain("previous leader response");
  });

  it("does not inject thread-routing reminders for system-triggered leader startup output", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "leader-kickoff",
        content: "Leader kickoff",
        timestamp: 1,
        threadKey: "main",
        agentSource: { sessionId: "system:leader-kickoff", sessionLabel: "Leader Kickoff" },
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread-after-system-kickoff",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Ready to coordinate." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Ready to coordinate.",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("system");

    handleResultMessage(session, makeResult({ uuid: "system-kickoff-result" }), deps);

    expect(deps.injectUserMessage).not.toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("[Thread routing reminder]"),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "system");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ uuid: "system-kickoff-result" }),
      "system",
    );
  });

  it("injects shell-command-specific thread-routing reminders after unrouted leader commands", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q970",
        content: "continue in quest thread",
        timestamp: 1,
        threadKey: "q-970",
        questId: "q-970",
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-command-thread",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "shell_command",
          rawContent: "pwd",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("Missing thread marker on leader shell command"),
      { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      undefined,
      expect.objectContaining({ threadKey: "q-970", questId: "q-970" }),
    );
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).toContain("previous leader shell command");
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).not.toContain("previous leader response");
  });

  it("injects queued quest thread reminders as synthetic user messages after the turn result", () => {
    const session = makeSession();
    session.questThreadRemindersThisTurn = [
      {
        content:
          "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
        route: {
          threadKey: "q-1025",
          questId: "q-1025",
          threadRefs: [{ threadKey: "q-1025", questId: "q-1025", source: "explicit" }],
        },
        agentSource: {
          sessionId: QUEST_THREAD_REMINDER_SOURCE_ID,
          sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL,
        },
      },
    ];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
      { sessionId: QUEST_THREAD_REMINDER_SOURCE_ID, sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL },
      undefined,
      {
        threadKey: "q-1025",
        questId: "q-1025",
        threadRefs: [{ threadKey: "q-1025", questId: "q-1025", source: "explicit" }],
      },
    );
    expect(session.questThreadRemindersThisTurn).toEqual([]);
  });

  it("does not recursively inject thread-routing reminders for reminder-triggered turns", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "thread-routing-reminder-1",
        content: "[Thread routing reminder]\nMissing thread marker.",
        timestamp: 1,
        threadKey: "main",
        agentSource: { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread-after-reminder",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Still unrouted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Still unrouted",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });
});
