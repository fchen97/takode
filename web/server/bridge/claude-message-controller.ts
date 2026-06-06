import type {
  BackendType,
  BrowserIncomingMessage,
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlCancelRequestMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemCompactBoundaryMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLISystemTaskNotificationMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIUserMessage,
  PermissionRequest,
  SessionNotification,
  SessionState,
  ContentBlock,
  ToolResultPreview,
  ActiveTurnRoute,
  ThreadRef,
  ThreadTransitionMarker,
} from "../session-types.js";
import {
  computeContextUsedPercent,
  computeResultContextUsedPercent,
  extractClaudeTokenDetails,
  recordContextUsageHistory,
  resolveLiveClaudeContextWindow,
  type TokenUsage,
} from "./context-usage.js";
import { computeSessionTurnMetrics } from "../user-message-classification.js";
import { isResultStopReasonInterrupted, isTerminalResultInterrupted } from "../result-interruption.js";
import { markRecentAskVisibleResponseFromStream } from "../recent-ask-bundles.js";
import {
  recordCompactionBoundary,
  recordCompactionFinished,
  recordCompactionStarted,
} from "./session-lifecycle-events.js";
import { sessionTag } from "../session-tag.js";
import {
  finalizeRoutedLeaderResponseMessage,
  isCurrentValidRoutedLeaderResponseMessage,
} from "../leader-thread-response.js";
import type { ImageRef } from "../image-store.js";
import {
  applyRecentThreadFallbackToLeaderAssistantRouting,
  buildThreadRoutingReminderForCompletedTurn,
  extractLeaderThreadStatusMarkersFromContent,
  hasRouteableNonBashToolActivity,
  hasLeaderRoutedActivityContent,
  leaderAssistantControlMetadata,
  normalizeLeaderAssistantRouting,
  splitLeaderAssistantContentAtThreadRouteBoundaries,
  updateLeaderThreadStatusesForAssistantOutput,
} from "./thread-routing-reminder.js";
import { recordThreadReadyUnreadNotifications } from "./session-notification-controller.js";
import { displayOnlyLeaderAnswerThreads } from "./leader-answer-ready-authority.js";
import {
  consumeQuestThreadRemindersForCompletedTurn,
  extractQuestThreadRemindersFromContent,
  queueQuestThreadRemindersForCompletedTurn,
} from "./quest-thread-reminder.js";
import {
  appendThreadTransitionMarkerForRouteSwitch,
  inferRecentKnownQuestThreadRoute,
  normalizeThreadRoute,
  routeFromHistoryEntry,
  threadRouteForTarget,
  type ThreadRouteMetadata,
} from "../thread-routing-metadata.js";

/** Keep only the tail of streamed tool output per tool call. */
const TOOL_PROGRESS_OUTPUT_LIMIT = 12_000;

type BroadcastOptions = {
  skipBuffer?: boolean;
};

export interface SystemMessageSessionLike {
  id: string;
  backendType: BackendType;
  cliResuming: boolean;
  forceCompactPending: boolean;
  compactedDuringTurn: boolean;
  awaitingCompactSummary?: boolean;
  messageHistory: BrowserIncomingMessage[];
  state: SessionState;
}

interface SystemMessageDeps {
  broadcastToBrowsers: (
    session: SystemMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: SystemMessageSessionLike) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  injectCompactionRecovery: (session: SystemMessageSessionLike) => void;
  hasCompactBoundaryReplay: (
    session: SystemMessageSessionLike,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ) => boolean;
  freezeHistoryThroughCurrentTail: (session: SystemMessageSessionLike) => void;
  hasTaskNotificationReplay: (session: SystemMessageSessionLike, taskId: string, toolUseId: string) => boolean;
}

export interface AssistantMessageSessionLike {
  id: string;
  backendType: BackendType;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  isGenerating: boolean;
  activeTurnRoute?: ActiveTurnRoute | null;
  messageHistory: BrowserIncomingMessage[];
  questThreadRemindersThisTurn?: import("./quest-thread-reminder.js").QuestThreadReminderInjection[];
  assistantAccumulator: Map<
    string,
    { contentBlockIds: Set<string>; currentHistoryMessageId?: string; rawContent?: ContentBlock[] }
  >;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  diffStatsDirty: boolean;
  lastActivityPreview?: string;
  state: {
    model: string;
    context_used_percent: number;
    claude_token_details?: SessionState["claude_token_details"];
    isOrchestrator?: boolean;
    leaderThreadStatuses?: SessionState["leaderThreadStatuses"];
    slackThreadChild?: SessionState["slackThreadChild"];
  };
  contextUsageHistory?: import("../session-types.js").ContextUsageHistoryEntry[];
}

interface HandleAssistantMessageDeps {
  hasAssistantReplay: (session: AssistantMessageSessionLike, messageId: string) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => { isOrchestrator?: boolean } | null | undefined;
  broadcastToBrowsers: (
    session: AssistantMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: AssistantMessageSessionLike) => void;
  invalidateLeaderThreadTabsForSession?: (sessionId: string) => void;
  promoteLeaderThreadTabForTransition?: (sessionId: string, marker: ThreadTransitionMarker) => boolean;
  onToolUseObserved?: (
    session: AssistantMessageSessionLike,
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
  ) => void;
}

function publishThreadTransitionMarker(
  session: AssistantMessageSessionLike,
  marker: ThreadTransitionMarker | null,
  deps: Pick<HandleAssistantMessageDeps, "broadcastToBrowsers" | "promoteLeaderThreadTabForTransition">,
): void {
  if (!marker) return;
  deps.promoteLeaderThreadTabForTransition?.(session.id, marker);
  deps.broadcastToBrowsers(session, marker);
}

interface HandleAssistantRuntimeDeps extends HandleAssistantMessageDeps {
  setGenerating: (session: AssistantMessageSessionLike, generating: boolean, reason: string) => void;
  broadcastStatusRunning: (session: AssistantMessageSessionLike) => void;
}

function isLeaderSessionForAssistantRouting(
  session: AssistantMessageSessionLike,
  deps: Pick<HandleAssistantMessageDeps, "getLauncherSessionInfo">,
): boolean {
  if (session.state.isOrchestrator === true) return true;
  if (deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator !== true) return false;
  session.state.isOrchestrator = true;
  return true;
}

function routeFromLeaderAssistantResult(routed: {
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}): ThreadRouteMetadata | undefined {
  if (!routed.threadKey) return undefined;
  return {
    threadKey: routed.threadKey,
    ...(routed.questId ? { questId: routed.questId } : {}),
    ...(routed.threadRefs?.length ? { threadRefs: routed.threadRefs } : {}),
  };
}

function activeTurnRouteFromThreadRoute(route: ThreadRouteMetadata): ActiveTurnRoute {
  return {
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
  };
}

function sameActiveTurnRoute(
  current: ActiveTurnRoute | null | undefined,
  next: ActiveTurnRoute | null | undefined,
): boolean {
  return (current?.threadKey ?? "main") === (next?.threadKey ?? "main") && current?.questId === next?.questId;
}

function updateActiveTurnRouteFromLeaderAssistant(
  session: AssistantMessageSessionLike,
  route: ThreadRouteMetadata | undefined,
  deps: Pick<HandleAssistantMessageDeps, "broadcastToBrowsers">,
): void {
  if (!route || !session.isGenerating) return;
  const nextRoute = activeTurnRouteFromThreadRoute(route);
  if (sameActiveTurnRoute(session.activeTurnRoute, nextRoute)) return;
  session.activeTurnRoute = nextRoute;
  deps.broadcastToBrowsers(session, {
    type: "status_change",
    status: "running",
    activeTurnRoute: nextRoute,
  });
}

function queueQuestThreadRemindersFromLeaderAssistant(
  session: AssistantMessageSessionLike,
  reminders: string[] | undefined,
  route: ThreadRouteMetadata | undefined,
): void {
  if (!reminders?.length) return;
  queueQuestThreadRemindersForCompletedTurn(session, reminders, route);
}

export interface ResultMessageSessionLike {
  id: string;
  backendType: BackendType;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  messageHistory: BrowserIncomingMessage[];
  questThreadRemindersThisTurn?: import("./quest-thread-reminder.js").QuestThreadReminderInjection[];
  state: Pick<
    SessionState,
    | "model"
    | "total_cost_usd"
    | "user_turn_count"
    | "agent_turn_count"
    | "num_turns"
    | "context_used_percent"
    | "claude_token_details"
    | "leaderThreadStatuses"
    | "slackThreadChild"
  >;
  contextUsageHistory?: import("../session-types.js").ContextUsageHistoryEntry[];
  notifications?: SessionNotification[];
  leaderThreadOutcomeValidatedHistoryLength?: number;
  diffStatsDirty: boolean;
  generationStartedAt?: number | null;
  messageCountAtTurnStart?: number;
  interruptedDuringTurn: boolean;
  queuedTurnStarts: number;
  queuedTurnInterruptSources: Array<"user" | "leader" | "system" | null>;
  activeTurnRoute?: ActiveTurnRoute | null;
  userMessageIdsThisTurn: number[];
  isGenerating: boolean;
  pendingPermissions: Map<string, PermissionRequest>;
  toolStartTimes: Map<string, number>;
}

export interface CliMessageRouteSessionLike {
  id: string;
  activeTurnRoute?: ActiveTurnRoute | null;
  recentAskVisibleResponseThreads?: Set<string>;
  pendingPermissions: Map<string, PermissionRequest>;
  toolProgressOutput: Map<string, string>;
  lastToolProgressAt: number;
}

export interface CliUserReplaySessionLike {
  id: string;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  resumedFromExternal?: boolean;
  awaitingCompactSummary?: boolean;
  messageHistory: BrowserIncomingMessage[];
  toolStartTimes: Map<string, number>;
}

interface PassthroughMessageDeps {
  abortAutoApproval: (session: CliMessageRouteSessionLike, requestId: string) => void;
  broadcastToBrowsers: (
    session: CliMessageRouteSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  clearActionAttentionIfNoPermissions: (session: CliMessageRouteSessionLike) => void;
  persistSession: (session: CliMessageRouteSessionLike) => void;
}

interface CliUserReplayDeps {
  hasUserPromptReplay: (session: CliUserReplaySessionLike, cliUuid: string) => boolean;
  hasToolResultPreviewReplay: (session: CliUserReplaySessionLike, toolUseId: string) => boolean;
  broadcastToBrowsers: (
    session: CliUserReplaySessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: CliUserReplaySessionLike) => void;
  nextUserMessageId: (timestamp: number) => string;
  storeImage?: (sessionId: string, data: string, mediaType: string) => Promise<ImageRef>;
  clearCodexToolResultWatchdog: (session: CliUserReplaySessionLike, toolUseId: string) => void;
  buildToolResultPreviews: (
    session: CliUserReplaySessionLike,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ) => ToolResultPreview[];
  collectCompletedToolStartTimes: (
    session: CliUserReplaySessionLike,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ) => number[];
  finalizeSupersededCodexTerminalTools: (session: CliUserReplaySessionLike, completedToolStartTimes: number[]) => void;
}

interface ClaudeCliUserMessageDeps extends CliUserReplayDeps {
  broadcastCompactSummary: (session: CliUserReplaySessionLike, summary: string) => void;
  updateLatestCompactMarkerSummary: (session: CliUserReplaySessionLike, summary: string) => void;
}

function shouldDropReplayHistoryAfterRevert(session: {
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
}): boolean {
  return session.cliResuming && session.dropReplayHistoryAfterRevert === true;
}

interface ResultMessageDeps {
  onMonitoredThreadResult?: (session: ResultMessageSessionLike, threadKey: string) => void;
  hasResultReplay: (session: ResultMessageSessionLike, resultUuid: string) => boolean;
  reconcileReplayState: (session: ResultMessageSessionLike) => { clearedResidualState: boolean };
  markTurnInterrupted: (session: ResultMessageSessionLike, source: "user" | "leader" | "system") => void;
  getCurrentTurnTriggerSource: (session: ResultMessageSessionLike) => "user" | "leader" | "system" | "unknown";
  reconcileTerminalResultState: (session: ResultMessageSessionLike) => void;
  getCodexAutoPauseRecoveryProgress?: (
    session: ResultMessageSessionLike,
  ) => import("../session-types.js").CodexAutoPauseRecoveryProgress | null;
  finalizeOrphanedTerminalToolsOnResult: (session: ResultMessageSessionLike, msg: CLIResultMessage) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: ResultMessageSessionLike,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean },
  ) => void;
  broadcastToBrowsers: (
    session: ResultMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: ResultMessageSessionLike) => void;
  freezeHistoryThroughCurrentTail: (session: ResultMessageSessionLike) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  onResultAttentionAndNotifications: (
    session: ResultMessageSessionLike,
    msg: CLIResultMessage,
    turnTriggerSource: "user" | "leader" | "system" | "unknown",
  ) => void;
  validateLeaderThreadOutcomes: (
    session: ResultMessageSessionLike,
    turnTriggerSource: "user" | "leader" | "system" | "unknown",
    rejectedReadyThreadKeys?: string[],
  ) => void;
  onTurnCompleted: (session: ResultMessageSessionLike) => void;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource: { sessionId: string; sessionLabel?: string },
    takodeHerdBatch: undefined,
    threadRoute: ThreadRouteMetadata,
  ) => void;
  refreshSessionConversation?: (sessionId: string) => void;
  invalidateLeaderThreadTabsForSession?: (sessionId: string) => void;
}

interface ClaudeSdkBrowserMessageSessionLike {
  id: string;
  backendType: BackendType;
  cliInitReceived: boolean;
  cliResuming: boolean;
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  forceCompactPending: boolean;
  compactedDuringTurn: boolean;
  awaitingCompactSummary?: boolean;
  isGenerating: boolean;
  generationStartedAt?: number | null;
  resumedFromExternal?: boolean;
  activeTurnRoute?: ActiveTurnRoute | null;
  recentAskVisibleResponseThreads?: Set<string>;
  lastToolProgressAt: number;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  assistantAccumulator: Map<
    string,
    { contentBlockIds: Set<string>; currentHistoryMessageId?: string; rawContent?: ContentBlock[] }
  >;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  diffStatsDirty: boolean;
  lastActivityPreview?: string;
  pendingPermissions: Map<string, PermissionRequest>;
  interruptedDuringTurn: boolean;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: Array<"user" | "leader" | "system" | null>;
  queuedTurnActiveRoutes?: Array<ActiveTurnRoute | null>;
  userMessageIdsThisTurn: number[];
  state: SessionState;
}

export function handleAssistantMessage(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  deps: HandleAssistantMessageDeps,
): void {
  const msgId = msg.message?.id;
  const isLeaderSession = isLeaderSessionForAssistantRouting(session, deps);
  const slackThreadId = session.state.slackThreadChild?.threadId;

  if (!msgId) {
    if (shouldDropReplayHistoryAfterRevert(session)) {
      console.log(
        `[revert] Replay assistant DROPPED (msgId=NONE, uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
      );
      return;
    }
    const timestamp = Date.now();
    const resolvedMessageId = msg.message.id ?? msg.uuid ?? `assistant-${timestamp}-${session.messageHistory.length}`;
    const contentSegments = splitLeaderAssistantContentAtThreadRouteBoundaries(
      isLeaderSession,
      msg.message.content,
      msg.parent_tool_use_id,
    );
    for (const [segmentIndex, contentSegment] of contentSegments.entries()) {
      const routed = applyRecentThreadFallbackToLeaderAssistantRouting(
        isLeaderSession,
        normalizeLeaderAssistantRouting(isLeaderSession, contentSegment, msg.parent_tool_use_id),
        session.messageHistory,
        msg.parent_tool_use_id,
      );
      const route = routeFromLeaderAssistantResult(routed);
      queueQuestThreadRemindersFromLeaderAssistant(session, routed.questThreadReminders, route);
      const segmentMessageId = segmentIndex === 0 ? resolvedMessageId : `${resolvedMessageId}:route-${segmentIndex}`;
      const browserMsg: BrowserIncomingMessage = {
        type: "assistant",
        message: { ...msg.message, id: segmentMessageId, content: routed.content },
        parent_tool_use_id: msg.parent_tool_use_id,
        timestamp,
        uuid: msg.uuid,
        ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
        ...(routed.questId ? { questId: routed.questId } : {}),
        ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
        ...(slackThreadId ? { slackThreadId } : {}),
        ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
        ...leaderAssistantControlMetadata(session, routed, Boolean(msg.message.id ?? msg.uuid)),
      };
      const transitionMarker = appendThreadTransitionMarkerForRouteSwitch(
        session.messageHistory,
        normalizeThreadRoute(routed.threadKey, routed.questId),
      );
      publishThreadTransitionMarker(session, transitionMarker, deps);
      session.messageHistory.push(browserMsg);
      const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
        session,
        undefined,
        { messageId: segmentMessageId, timestamp },
        hasLeaderRoutedActivityContent(routed.content) ? route : undefined,
      );
      if (statusUpdate.changed) deps.invalidateLeaderThreadTabsForSession?.(session.id);
      deps.broadcastToBrowsers(session, browserMsg);
      updateActiveTurnRouteFromLeaderAssistant(session, route, deps);
    }
    maybeUpdateContextUsedPercentFromAssistantUsage(
      session,
      msg.message.usage,
      msg.message.model,
      deps.broadcastToBrowsers,
    );
    deps.persistSession(session);
    return;
  }

  const acc = session.assistantAccumulator.get(msgId);
  const newlyObservedToolUses: Array<Extract<ContentBlock, { type: "tool_use" }>> = [];
  if (!acc) {
    const hasReplay = !!msgId && deps.hasAssistantReplay(session, msgId);
    if (hasReplay) return;
    if (shouldDropReplayHistoryAfterRevert(session)) {
      console.log(
        `[revert] Replay assistant DROPPED (msgId=${msgId ?? "NONE"}, uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
      );
      return;
    }

    const contentBlockIds = new Set<string>();
    const currentHistoryMessageId = emitRoutedAssistantSegments(session, msg, msg.message.content, deps, {
      isLeaderSession,
      contentBlockIds,
      newlyObservedToolUses,
    });
    session.assistantAccumulator.set(msgId, {
      contentBlockIds,
      currentHistoryMessageId,
      rawContent: [...msg.message.content],
    });
  } else if (isLeaderSession && isFirstRoutableChunkForUnroutedRow(session, msg)) {
    // The first same-id chunk carried no routable content (Claude streams a
    // thinking block as its own chunk), so route the merged message now as if
    // it had arrived whole, rewriting the unrouted row in place.
    acc.rawContent = mergeAssistantRawContent(acc.rawContent ?? [], msg.message.content);
    acc.currentHistoryMessageId = emitRoutedAssistantSegments(session, msg, acc.rawContent, deps, {
      isLeaderSession,
      contentBlockIds: acc.contentBlockIds,
      newlyObservedToolUses,
      replaceUnroutedRow: true,
    });
  } else {
    const historyMessageId = acc.currentHistoryMessageId ?? msgId;
    const historyEntry = session.messageHistory.findLast(
      (entry) =>
        entry.type === "assistant" && (entry as { message?: { id?: string } }).message?.id === historyMessageId,
    ) as Extract<BrowserIncomingMessage, { type: "assistant" }> | undefined;
    if (!historyEntry) return;

    const rawExistingContent = acc.rawContent ?? historyEntry.message.content;
    const appendedBlocks = getAssistantContentAppendBlocks(
      rawExistingContent,
      msg.message.content,
      acc.contentBlockIds,
    );
    acc.rawContent = mergeAssistantRawContent(rawExistingContent, msg.message.content);
    const extracted = extractQuestThreadRemindersFromContent(appendedBlocks);
    const statusExtracted = extractLeaderThreadStatusMarkersFromContent(extracted.content);
    const newBlocks = statusExtracted.content;
    let historyEntryRoute = routeFromHistoryEntry(historyEntry as BrowserIncomingMessage) ?? undefined;
    if (
      isLeaderSession &&
      !msg.parent_tool_use_id &&
      !historyEntryRoute &&
      historyEntry.threadRoutingError?.source === "visible_text" &&
      historyEntry.threadRoutingError.reason === "missing" &&
      hasRouteableNonBashToolActivity(newBlocks)
    ) {
      const fallbackRoute = inferRecentKnownQuestThreadRoute(session.messageHistory);
      if (fallbackRoute) {
        historyEntry.threadKey = fallbackRoute.threadKey;
        if (fallbackRoute.questId) {
          historyEntry.questId = fallbackRoute.questId;
        } else {
          delete historyEntry.questId;
        }
        if (fallbackRoute.threadRefs?.length) {
          historyEntry.threadRefs = fallbackRoute.threadRefs;
        } else {
          delete historyEntry.threadRefs;
        }
        delete historyEntry.threadRoutingError;
        historyEntryRoute = fallbackRoute;
      }
    }
    queueQuestThreadRemindersFromLeaderAssistant(session, extracted.reminders, historyEntryRoute);
    const timestamp = Date.now();
    if (statusExtracted.markers.length > 0) {
      historyEntry.deferredThreadStatusMarkers = [
        ...(historyEntry.deferredThreadStatusMarkers ?? []),
        ...statusExtracted.markers,
      ];
    }
    if (newBlocks.length > 0) {
      for (const block of newBlocks) {
        if (block.type === "tool_use" && block.id) {
          if (!session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, Date.now());
          }
          session.toolProgressOutput.delete(block.id);
          newlyObservedToolUses.push(block);
        }
      }
      historyEntry.message.content = [...historyEntry.message.content, ...newBlocks];
    }

    if (msg.message.stop_reason) {
      historyEntry.message.stop_reason = msg.message.stop_reason;
    }
    if (msg.message.usage) {
      historyEntry.message.usage = msg.message.usage;
    }

    const allToolStartTimes: Record<string, number> = {};
    for (const block of historyEntry.message.content) {
      if (block.type === "tool_use" && block.id && session.toolStartTimes.has(block.id)) {
        allToolStartTimes[block.id] = session.toolStartTimes.get(block.id)!;
      }
    }

    historyEntry.timestamp = timestamp;
    const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
      session,
      undefined,
      { messageId: msgId, timestamp },
      hasLeaderRoutedActivityContent(newBlocks) ? historyEntryRoute : undefined,
    );
    if (statusUpdate.changed) deps.invalidateLeaderThreadTabsForSession?.(session.id);
    deps.broadcastToBrowsers(
      session,
      {
        ...(historyEntry as BrowserIncomingMessage),
        ...(Object.keys(allToolStartTimes).length > 0 ? { tool_start_times: allToolStartTimes } : {}),
      },
      { skipBuffer: true },
    );
    updateActiveTurnRouteFromLeaderAssistant(session, historyEntryRoute, deps);
  }

  extractActivityPreview(session, msg.message.content);
  if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") continue;
      const name = (block as { name?: string }).name ?? "";
      if (!READ_ONLY_TOOLS.has(name)) {
        session.diffStatsDirty = true;
        break;
      }
    }
  }
  maybeUpdateContextUsedPercentFromAssistantUsage(
    session,
    msg.message.usage,
    msg.message.model,
    deps.broadcastToBrowsers,
  );
  for (const toolUse of newlyObservedToolUses) {
    deps.onToolUseObserved?.(session, toolUse);
  }
  deps.persistSession(session);
}

/**
 * Persist and broadcast one history row per leader thread-route segment of
 * `content`. With `replaceUnroutedRow`, segment 0 takes the history position
 * (and CLI uuid) of the existing row for this message id instead of being
 * appended. Returns the history message id of the last segment.
 */
function emitRoutedAssistantSegments(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  content: ContentBlock[],
  deps: HandleAssistantMessageDeps,
  options: {
    isLeaderSession: boolean;
    contentBlockIds: Set<string>;
    newlyObservedToolUses: Array<Extract<ContentBlock, { type: "tool_use" }>>;
    replaceUnroutedRow?: boolean;
  },
): string {
  const msgId = msg.message.id;
  const { isLeaderSession, contentBlockIds, newlyObservedToolUses } = options;
  const slackThreadId = session.state.slackThreadChild?.threadId;
  const timestamp = Date.now();
  const replaceIndex = options.replaceUnroutedRow ? findAssistantHistoryIndex(session, msgId) : -1;
  const contentSegments = splitLeaderAssistantContentAtThreadRouteBoundaries(
    isLeaderSession,
    content,
    msg.parent_tool_use_id,
  );
  let currentHistoryMessageId = msgId;
  for (const [segmentIndex, contentSegment] of contentSegments.entries()) {
    const routed = applyRecentThreadFallbackToLeaderAssistantRouting(
      isLeaderSession,
      normalizeLeaderAssistantRouting(isLeaderSession, contentSegment, msg.parent_tool_use_id),
      session.messageHistory,
      msg.parent_tool_use_id,
    );
    const route = routeFromLeaderAssistantResult(routed);
    queueQuestThreadRemindersFromLeaderAssistant(session, routed.questThreadReminders, route);
    const segmentMessageId = segmentIndex === 0 ? msgId : `${msgId}:route-${segmentIndex}`;
    const replacesRow = segmentIndex === 0 && replaceIndex >= 0;
    currentHistoryMessageId = segmentMessageId;
    const toolStartTimesMap: Record<string, number> = {};
    for (const block of routed.content) {
      if (block.type === "tool_use" && block.id) {
        contentBlockIds.add(block.id);
        if (!session.toolStartTimes.has(block.id)) {
          session.toolStartTimes.set(block.id, timestamp);
        }
        session.toolProgressOutput.delete(block.id);
        toolStartTimesMap[block.id] = session.toolStartTimes.get(block.id)!;
        newlyObservedToolUses.push(block);
      }
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: { ...msg.message, id: segmentMessageId, content: [...routed.content] },
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp,
      uuid: replacesRow ? (session.messageHistory[replaceIndex] as { uuid?: string }).uuid : msg.uuid,
      ...(Object.keys(toolStartTimesMap).length > 0 ? { tool_start_times: toolStartTimesMap } : {}),
      ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
      ...(routed.questId ? { questId: routed.questId } : {}),
      ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
      ...(slackThreadId ? { slackThreadId } : {}),
      ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
      ...leaderAssistantControlMetadata(session, routed, true),
    };
    // A replaced row is taken out before the transition check so it cannot act
    // as an implicit Main boundary; the routed row then takes its index.
    if (replacesRow) session.messageHistory.splice(replaceIndex, 1);
    const transitionMarker = appendThreadTransitionMarkerForRouteSwitch(
      session.messageHistory,
      normalizeThreadRoute(routed.threadKey, routed.questId),
    );
    publishThreadTransitionMarker(session, transitionMarker, deps);
    if (replacesRow) {
      session.messageHistory.splice(replaceIndex, 0, browserMsg);
    } else {
      session.messageHistory.push(browserMsg);
    }
    const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
      session,
      undefined,
      { messageId: segmentMessageId, timestamp },
      hasLeaderRoutedActivityContent(routed.content) ? route : undefined,
    );
    if (statusUpdate.changed) deps.invalidateLeaderThreadTabsForSession?.(session.id);
    deps.broadcastToBrowsers(session, browserMsg, replacesRow ? { skipBuffer: true } : undefined);
    updateActiveTurnRouteFromLeaderAssistant(session, route, deps);
  }
  return currentHistoryMessageId;
}

/**
 * True when a same-id chunk brings the first routable content (visible text or
 * tools) to a top-level leader row that has none yet, e.g. a thinking-only
 * first chunk. Routing is decided by the first routable content, so that row
 * must be routed now rather than having raw marker text appended to it.
 */
function isFirstRoutableChunkForUnroutedRow(session: AssistantMessageSessionLike, msg: CLIAssistantMessage): boolean {
  if (msg.parent_tool_use_id || !hasLeaderRoutedActivityContent(msg.message.content)) return false;
  const row = session.messageHistory[findAssistantHistoryIndex(session, msg.message.id)];
  return row?.type === "assistant" && !hasLeaderRoutedActivityContent(row.message.content);
}

function findAssistantHistoryIndex(session: AssistantMessageSessionLike, messageId: string): number {
  return session.messageHistory.findLastIndex((entry) => entry.type === "assistant" && entry.message.id === messageId);
}

export function handleAssistantMessageWithRuntime(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  deps: HandleAssistantRuntimeDeps,
): void {
  const msgId = msg.message?.id;
  if (
    !session.isGenerating &&
    !session.cliResuming &&
    !msg.parent_tool_use_id &&
    !(msgId && deps.hasAssistantReplay(session, msgId))
  ) {
    deps.setGenerating(session, true, "cli_initiated_turn");
    deps.broadcastStatusRunning(session);
  }
  handleAssistantMessage(session, msg, deps);
}

function currentTurnAssistantEntries(
  session: ResultMessageSessionLike,
): Array<Extract<BrowserIncomingMessage, { type: "assistant" }>> {
  const validUserIndexes = session.userMessageIdsThisTurn.filter(
    (index) => Number.isInteger(index) && index >= 0 && index < session.messageHistory.length,
  );
  const lastResultIndex = session.messageHistory.findLastIndex((entry) => entry.type === "result");
  const userStartIndex = validUserIndexes.length > 0 ? Math.min(...validUserIndexes) : lastResultIndex + 1;
  const startIndex = Math.max(lastResultIndex + 1, userStartIndex);
  return session.messageHistory
    .slice(Math.max(0, startIndex))
    .filter(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> =>
        entry.type === "assistant" && entry.parent_tool_use_id === null,
    );
}

function finalizeLeaderTurnResponseControls(
  session: ResultMessageSessionLike,
  deps: ResultMessageDeps,
  apply: boolean,
): { changed: boolean; rejectedReadyThreadKeys: string[] } {
  let changed = false;
  const rejectedReadyThreadKeys = new Set<string>();
  const entries = currentTurnAssistantEntries(session);
  const answerCanAnchorReady = new Map<Extract<BrowserIncomingMessage, { type: "assistant" }>, boolean>();

  // Finalize every answer before applying any Ready marker. A multi-section
  // leader output may put the status segment before the answer segment.
  if (apply) {
    for (const entry of entries) {
      if (entry.leaderThreadRole !== "answer") continue;
      const finalized = finalizeRoutedLeaderResponseMessage(session, entry);
      const authoritative =
        finalized.finalized ||
        isCurrentValidRoutedLeaderResponseMessage({ id: session.id, messageHistory: session.messageHistory }, entry);
      answerCanAnchorReady.set(entry, authoritative);
      if (finalized.finalized) {
        changed = true;
      }
    }
  }

  const displayOnlyReadyThreadKeys = displayOnlyLeaderAnswerThreads(
    { id: session.id, messageHistory: session.messageHistory },
    entries,
  );

  for (const entry of entries) {
    let entryChanged = false;
    const answerIsInvalid = entry.leaderThreadRole === "answer" && answerCanAnchorReady.get(entry) !== true;
    const deferredMarkers = entry.deferredThreadStatusMarkers;
    if (apply && deferredMarkers?.length) {
      const markersToApply = deferredMarkers.filter((marker) => {
        if (marker.kind !== "ready") return true;
        const threadKey = threadRouteForTarget(marker.target.threadKey).threadKey;
        if (!answerIsInvalid && !displayOnlyReadyThreadKeys.has(threadKey)) return true;
        rejectedReadyThreadKeys.add(threadKey);
        return false;
      });
      const route = routeFromHistoryEntry(entry) ?? undefined;
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
      const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
        session,
        markersToApply,
        { messageId: entry.message.id, timestamp },
        hasLeaderRoutedActivityContent(entry.message.content) ? route : undefined,
      );
      if (statusUpdate.records.length > 0) {
        entry.threadStatusMarkers = [...(entry.threadStatusMarkers ?? []), ...statusUpdate.records];
        recordThreadReadyUnreadNotifications(session, statusUpdate.records, deps);
      }
      for (const key of statusUpdate.monitoredThreadKeys ?? []) deps.onMonitoredThreadResult?.(session, key);
      for (const route of statusUpdate.rejectedReadyRoutes ?? []) {
        rejectedReadyThreadKeys.add(route.threadKey);
      }
      entryChanged ||= statusUpdate.changed;
    }
    if (entry.deferredThreadStatusMarkers) {
      delete entry.deferredThreadStatusMarkers;
      entryChanged = true;
    }
    if (entry.leaderAnswerObservedHistoryLength !== undefined) {
      delete entry.leaderAnswerObservedHistoryLength;
      entryChanged = true;
    }
    if (entry.leaderAnswerUserMessageIds !== undefined) {
      delete entry.leaderAnswerUserMessageIds;
      entryChanged = true;
    }
    if (entry.leaderResponseObservedHistoryLength !== undefined) {
      delete entry.leaderResponseObservedHistoryLength;
      entryChanged = true;
    }
    if (entryChanged || (apply && entry.leaderThreadRole === "answer" && answerCanAnchorReady.get(entry) === true)) {
      changed = true;
      deps.broadcastToBrowsers(session, entry, { skipBuffer: true });
    }
  }
  if (changed) {
    deps.invalidateLeaderThreadTabsForSession?.(session.id);
    deps.refreshSessionConversation?.(session.id);
  }
  return { changed, rejectedReadyThreadKeys: [...rejectedReadyThreadKeys] };
}

export function handleResultMessage(
  session: ResultMessageSessionLike,
  msg: CLIResultMessage,
  deps: ResultMessageDeps,
): void {
  const hasReplay = !!msg.uuid && deps.hasResultReplay(session, msg.uuid);
  if (hasReplay) {
    const reconciled = deps.reconcileReplayState(session);
    if (reconciled.clearedResidualState) {
      deps.broadcastToBrowsers(session, {
        type: "status_change",
        status: "idle",
        codexAutoPauseRecoveryProgress: deps.getCodexAutoPauseRecoveryProgress?.(session) ?? null,
      });
      deps.persistSession(session);
    }
    return;
  }
  if (shouldDropReplayHistoryAfterRevert(session)) {
    console.log(
      `[revert] Replay result DROPPED (uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
    );
    return;
  }

  const lastAssistant = session.messageHistory.findLast(
    (entry) =>
      entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
  ) as { message?: { usage?: TokenUsage } } | undefined;
  const nextContextPct = computeResultContextUsedPercent(session.state.model, msg, lastAssistant?.message?.usage);
  if (typeof nextContextPct === "number") {
    session.state.context_used_percent = nextContextPct;
  }
  const nextClaudeTokenDetails = extractClaudeTokenDetails(msg.modelUsage, session.state.model);
  if (nextClaudeTokenDetails) {
    session.state.claude_token_details = nextClaudeTokenDetails;
  }
  if (typeof nextContextPct === "number" || nextClaudeTokenDetails) {
    recordContextUsageHistory(session, "claude_result_usage");
  }

  const turnDurationMs =
    typeof session.generationStartedAt === "number" ? Math.max(0, Date.now() - session.generationStartedAt) : undefined;
  const resultInterrupted = isResultStopReasonInterrupted(msg);
  if (resultInterrupted && !session.interruptedDuringTurn && session.queuedTurnStarts > 0) {
    deps.markTurnInterrupted(session, session.queuedTurnInterruptSources[0] ?? "user");
  }
  const turnWasInterrupted = isTerminalResultInterrupted(msg, {
    sessionInterrupted: session.interruptedDuringTurn,
  });
  const isProviderRetryResult = !!msg.codex_provider_retry;
  const resultTurnRoute = session.activeTurnRoute ?? null;
  const turnTriggerSource = deps.getCurrentTurnTriggerSource(session);
  const leaderTurnControls = finalizeLeaderTurnResponseControls(
    session,
    deps,
    !turnWasInterrupted && !isProviderRetryResult,
  );
  const threadRoutingReminder =
    turnWasInterrupted || isProviderRetryResult || turnTriggerSource === "system"
      ? null
      : buildThreadRoutingReminderForCompletedTurn(session);
  const questThreadReminders = isProviderRetryResult ? [] : consumeQuestThreadRemindersForCompletedTurn(session);
  const deliverQuestThreadReminders = turnWasInterrupted ? [] : questThreadReminders;

  deps.reconcileTerminalResultState(session);
  deps.finalizeOrphanedTerminalToolsOnResult(session, msg);
  session.toolStartTimes.clear();
  if (!session.isGenerating) {
    deps.broadcastToBrowsers(session, {
      type: "status_change",
      status: "idle",
      codexAutoPauseRecoveryProgress: deps.getCodexAutoPauseRecoveryProgress?.(session) ?? null,
    });
  }

  if (typeof turnDurationMs === "number") {
    const latestAssistant = session.messageHistory.findLast(
      (entry) =>
        entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
    ) as (BrowserIncomingMessage & { type: "assistant"; turn_duration_ms?: number }) | undefined;
    if (latestAssistant) {
      latestAssistant.turn_duration_ms = turnDurationMs;
      deps.broadcastToBrowsers(session, latestAssistant, { skipBuffer: true });
    }
  }

  if (session.pendingPermissions.size > 0) {
    for (const [requestId] of session.pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: requestId });
      deps.cancelPermissionNotification(session.id, requestId);
    }
    session.pendingPermissions.clear();
    deps.onSessionActivityStateChanged(session.id, "result_cleared_permissions");
  }

  const resultTimestamp = Date.now();
  const provisionalResultBrowserMsg: BrowserIncomingMessage = {
    type: "result",
    data: msg,
    timestamp: resultTimestamp,
    ...(turnWasInterrupted ? { interrupted: true } : {}),
    ...(resultTurnRoute?.threadKey ? { threadKey: resultTurnRoute.threadKey } : {}),
    ...(resultTurnRoute?.questId ? { questId: resultTurnRoute.questId } : {}),
    ...(session.state.slackThreadChild?.threadId ? { slackThreadId: session.state.slackThreadChild.threadId } : {}),
  };
  const turnMetrics = computeSessionTurnMetrics([...session.messageHistory, provisionalResultBrowserMsg]);
  session.state.total_cost_usd = msg.total_cost_usd;
  session.state.user_turn_count = turnMetrics.userTurnCount;
  session.state.agent_turn_count = turnMetrics.agentTurnCount;
  session.state.num_turns = turnMetrics.userTurnCount;

  session.diffStatsDirty = true;
  deps.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: {
      total_cost_usd: session.state.total_cost_usd,
      user_turn_count: session.state.user_turn_count,
      agent_turn_count: session.state.agent_turn_count,
      num_turns: session.state.num_turns,
      context_used_percent: session.state.context_used_percent,
      ...(nextClaudeTokenDetails ? { claude_token_details: nextClaudeTokenDetails } : {}),
    },
  });

  const resultBrowserMsg: BrowserIncomingMessage = {
    ...provisionalResultBrowserMsg,
    data: { ...msg, num_turns: turnMetrics.userTurnCount },
  };
  if (isProviderRetryResult) {
    // Retry progress is authoritative session state. Persisting one hidden raw
    // result per attempt would grow append-only history without bound. A fixed
    // live-only result still clears browser streaming/tool state without
    // exposing or retaining raw provider failure details.
    deps.broadcastToBrowsers(
      session,
      {
        ...resultBrowserMsg,
        data: {
          ...resultBrowserMsg.data,
          result: "Transient provider request failed; Takode is retrying.",
          errors: undefined,
        },
      },
      { skipBuffer: true },
    );
    deps.persistSession(session);
    return;
  }
  session.messageHistory.push(resultBrowserMsg);
  deps.freezeHistoryThroughCurrentTail(session);
  deps.broadcastToBrowsers(session, resultBrowserMsg);
  deps.persistSession(session);

  if (!turnWasInterrupted) {
    if (leaderTurnControls.rejectedReadyThreadKeys.length > 0) {
      deps.validateLeaderThreadOutcomes(session, turnTriggerSource, leaderTurnControls.rejectedReadyThreadKeys);
    } else {
      deps.validateLeaderThreadOutcomes(session, turnTriggerSource);
    }
    deps.onResultAttentionAndNotifications(session, msg, turnTriggerSource);
  }
  deps.onTurnCompleted(session);
  for (const reminder of deliverQuestThreadReminders) {
    deps.injectUserMessage(session.id, reminder.content, reminder.agentSource, undefined, reminder.route);
  }
  if (threadRoutingReminder) {
    deps.injectUserMessage(
      session.id,
      threadRoutingReminder.content,
      threadRoutingReminder.agentSource,
      undefined,
      threadRoutingReminder.route,
    );
  }
}

export function extractUserPromptFromCLI(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: CliUserReplayDeps,
): void {
  if (msg.parent_tool_use_id !== null) return;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  const hasToolResult = content.some((block) => (block as Record<string, unknown>).type === "tool_result");
  if (hasToolResult) return;

  const textParts: string[] = [];
  const imageBlocks: { media_type: string; data: string }[] = [];
  for (const block of content) {
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      textParts.push(candidate.text);
    } else if (candidate.type === "image" && (candidate.source as Record<string, unknown>)?.type === "base64") {
      const source = candidate.source as Record<string, string>;
      imageBlocks.push({ media_type: source.media_type, data: source.data });
    }
  }

  if (textParts.length === 0 && imageBlocks.length === 0) return;

  const cliUuid = msg.uuid;
  const hasReplay = !!cliUuid && deps.hasUserPromptReplay(session, cliUuid);
  if (hasReplay) {
    if (session.cliResuming) {
      console.log(`[revert] Replay user msg DEDUPED (cliUuid=${cliUuid}, historyLen=${session.messageHistory.length})`);
    }
    return;
  }
  if (shouldDropReplayHistoryAfterRevert(session)) {
    console.log(
      `[revert] Replay user msg DROPPED (cliUuid=${cliUuid ?? "NONE"}, text=${textParts[0]?.slice(0, 60) ?? ""}, historyLen=${session.messageHistory.length})`,
    );
    return;
  }

  if (session.cliResuming) {
    console.log(
      `[revert] Replay user msg APPENDING (new, cliUuid=${cliUuid ?? "NONE"}, text=${textParts[0]?.slice(0, 60) ?? ""}, historyLen=${session.messageHistory.length})`,
    );
  }

  const ts = Date.now();
  const text = textParts.join("\n");
  const storeEntry = (refs?: ImageRef[]) => {
    const entry: BrowserIncomingMessage = {
      type: "user_message",
      content: text,
      timestamp: ts,
      id: deps.nextUserMessageId(ts),
      cliUuid,
      ...(refs?.length ? { images: refs } : {}),
    };
    session.messageHistory.push(entry);
    deps.broadcastToBrowsers(session, entry);
    deps.persistSession(session);
  };

  if (imageBlocks.length > 0 && deps.storeImage) {
    Promise.all(imageBlocks.map((image) => deps.storeImage!(session.id, image.data, image.media_type)))
      .then(storeEntry)
      .catch(() => storeEntry());
    return;
  }

  storeEntry();
}

export function handleToolResultMessage(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: CliUserReplayDeps,
): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  const toolResults = content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
  );
  let droppedAfterRevert = 0;
  const newToolResults = toolResults.filter((block) => {
    if (!deps.hasToolResultPreviewReplay(session, block.tool_use_id)) return true;
    deps.clearCodexToolResultWatchdog(session, block.tool_use_id);
    session.toolStartTimes.delete(block.tool_use_id);
    return false;
  });
  const filteredToolResults = shouldDropReplayHistoryAfterRevert(session)
    ? newToolResults.filter((block) => {
        droppedAfterRevert++;
        deps.clearCodexToolResultWatchdog(session, block.tool_use_id);
        session.toolStartTimes.delete(block.tool_use_id);
        return false;
      })
    : newToolResults;
  if (droppedAfterRevert > 0) {
    console.log(
      `[revert] Replay tool_result_preview DROPPED (${droppedAfterRevert} block(s), historyLen=${session.messageHistory.length})`,
    );
  }
  const completedToolStartTimes = deps.collectCompletedToolStartTimes(session, filteredToolResults);
  const previews = deps.buildToolResultPreviews(session, filteredToolResults);
  if (previews.length === 0) return;

  const browserMsg: BrowserIncomingMessage = {
    type: "tool_result_preview",
    previews,
  };
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
  deps.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
}

export function handleClaudeCliUserMessage(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: ClaudeCliUserMessageDeps,
): void {
  if (session.awaitingCompactSummary && !session.cliResuming) {
    const content = msg.message?.content;
    let summaryText: string | undefined;
    if (typeof content === "string" && content.length > 0) {
      summaryText = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find((block) => block.type === "text") as { type: "text"; text: string } | undefined;
      summaryText = textBlock?.text;
    }
    if (summaryText) {
      session.awaitingCompactSummary = false;
      deps.updateLatestCompactMarkerSummary(session, summaryText);
      deps.broadcastCompactSummary(session, summaryText);
      deps.persistSession(session);
      return;
    }
    session.awaitingCompactSummary = false;
  }
  if (session.resumedFromExternal) {
    extractUserPromptFromCLI(session, msg, deps);
  }
  handleToolResultMessage(session, msg, deps);
}

export function createClaudeMessageHandlers(
  deps: SystemMessageDeps &
    Pick<
      HandleAssistantRuntimeDeps,
      | "hasAssistantReplay"
      | "getLauncherSessionInfo"
      | "broadcastToBrowsers"
      | "persistSession"
      | "setGenerating"
      | "onToolUseObserved"
      | "promoteLeaderThreadTabForTransition"
    > &
    ResultMessageDeps &
    ClaudeCliUserMessageDeps &
    PassthroughMessageDeps,
): {
  handleResultMessage: (session: CliMessageRouteSessionLike, msg: CLIResultMessage) => void;
  handleSdkBrowserMessage: (session: ClaudeSdkBrowserMessageSessionLike, msg: any) => boolean;
} {
  const systemMessageDeps: SystemMessageDeps = {
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
    emitTakodeEvent: deps.emitTakodeEvent,
    injectCompactionRecovery: deps.injectCompactionRecovery,
    hasCompactBoundaryReplay: deps.hasCompactBoundaryReplay,
    freezeHistoryThroughCurrentTail: deps.freezeHistoryThroughCurrentTail,
    hasTaskNotificationReplay: deps.hasTaskNotificationReplay,
  };
  const assistantMessageDeps: HandleAssistantRuntimeDeps = {
    hasAssistantReplay: deps.hasAssistantReplay,
    getLauncherSessionInfo: deps.getLauncherSessionInfo,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    invalidateLeaderThreadTabsForSession: deps.invalidateLeaderThreadTabsForSession,
    promoteLeaderThreadTabForTransition: deps.promoteLeaderThreadTabForTransition,
    setGenerating: deps.setGenerating,
    onToolUseObserved: deps.onToolUseObserved,
    broadcastStatusRunning: (session) =>
      deps.broadcastToBrowsers(session, { type: "status_change", status: "running" }),
  };
  const resultMessageDeps: ResultMessageDeps = {
    onMonitoredThreadResult: deps.onMonitoredThreadResult,
    hasResultReplay: deps.hasResultReplay,
    reconcileReplayState: deps.reconcileReplayState,
    markTurnInterrupted: deps.markTurnInterrupted,
    getCurrentTurnTriggerSource: deps.getCurrentTurnTriggerSource,
    reconcileTerminalResultState: deps.reconcileTerminalResultState,
    finalizeOrphanedTerminalToolsOnResult: deps.finalizeOrphanedTerminalToolsOnResult,
    refreshGitInfoThenRecomputeDiff: deps.refreshGitInfoThenRecomputeDiff,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    freezeHistoryThroughCurrentTail: deps.freezeHistoryThroughCurrentTail,
    cancelPermissionNotification: deps.cancelPermissionNotification,
    onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
    onResultAttentionAndNotifications: deps.onResultAttentionAndNotifications,
    validateLeaderThreadOutcomes: deps.validateLeaderThreadOutcomes,
    onTurnCompleted: deps.onTurnCompleted,
    injectUserMessage: deps.injectUserMessage,
    refreshSessionConversation: deps.refreshSessionConversation,
    invalidateLeaderThreadTabsForSession: deps.invalidateLeaderThreadTabsForSession,
  };
  const cliUserMessageDeps: ClaudeCliUserMessageDeps = {
    hasUserPromptReplay: deps.hasUserPromptReplay,
    hasToolResultPreviewReplay: deps.hasToolResultPreviewReplay,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    nextUserMessageId: deps.nextUserMessageId,
    storeImage: deps.storeImage,
    clearCodexToolResultWatchdog: deps.clearCodexToolResultWatchdog,
    buildToolResultPreviews: deps.buildToolResultPreviews,
    collectCompletedToolStartTimes: deps.collectCompletedToolStartTimes,
    finalizeSupersededCodexTerminalTools: deps.finalizeSupersededCodexTerminalTools,
    broadcastCompactSummary: deps.broadcastCompactSummary,
    updateLatestCompactMarkerSummary: deps.updateLatestCompactMarkerSummary,
  };

  const passthroughDeps: PassthroughMessageDeps = {
    abortAutoApproval: deps.abortAutoApproval,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    cancelPermissionNotification: deps.cancelPermissionNotification,
    clearActionAttentionIfNoPermissions: deps.clearActionAttentionIfNoPermissions,
    persistSession: deps.persistSession,
  };

  return {
    handleResultMessage: (session: CliMessageRouteSessionLike, msg: CLIResultMessage) =>
      handleResultMessage(session as unknown as ResultMessageSessionLike, msg, resultMessageDeps),
    handleSdkBrowserMessage: (session: ClaudeSdkBrowserMessageSessionLike, msg: any) =>
      handleSdkBrowserMessage(session, msg, {
        system: systemMessageDeps,
        assistant: assistantMessageDeps,
        result: resultMessageDeps,
        user: cliUserMessageDeps,
        passthrough: passthroughDeps,
      }),
  };
}

function handleSdkBrowserMessage(
  session: ClaudeSdkBrowserMessageSessionLike,
  msg: any,
  deps: {
    system: SystemMessageDeps;
    assistant: HandleAssistantRuntimeDeps;
    result: ResultMessageDeps;
    user: ClaudeCliUserMessageDeps;
    passthrough: PassthroughMessageDeps;
  },
): boolean {
  const {
    system: systemMessageDeps,
    assistant: assistantMessageDeps,
    result: resultMessageDeps,
    user: cliUserMessageDeps,
  } = deps;
  switch (msg.type) {
    case "stream_event":
      handleStreamEventMessage(session, msg, deps.passthrough);
      return true;
    case "tool_progress":
      handleToolProgressMessage(session, msg, deps.passthrough);
      return true;
    case "tool_use_summary":
      handleToolUseSummaryMessage(session, msg, deps.passthrough);
      return true;
    case "auth_status":
      handleAuthStatusMessage(session, msg, deps.passthrough);
      return true;
    case "control_cancel_request":
      handleControlCancelRequestMessage(session, msg, deps.passthrough);
      return true;
  }

  if (msg.type === "assistant") {
    handleAssistantMessageWithRuntime(session, msg, assistantMessageDeps);
    return true;
  }

  if (msg.type === "result") {
    if (session.queuedTurnStarts > 0) {
      console.log(
        `[ws-bridge] Draining ${session.queuedTurnStarts} queued turn(s) for SDK session ${sessionTag(session.id)} — CLI already processed them inline`,
      );
      session.queuedTurnStarts = 0;
      session.queuedTurnReasons = [];
      session.queuedTurnUserMessageIds = [];
      session.queuedTurnInterruptSources = [];
      session.queuedTurnActiveRoutes = [];
    }
    handleResultMessage(session, (msg as any).data ?? msg, resultMessageDeps);
    return true;
  }

  if (msg.type === "task_notification") {
    handleTaskNotification(
      session,
      {
        type: "system",
        subtype: "task_notification",
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        status: msg.status,
        output_file: msg.output_file,
        summary: msg.summary,
      } as CLISystemTaskNotificationMessage,
      systemMessageDeps,
    );
    return true;
  }

  if (msg.type === "status_change") {
    handleSdkStatusChange(session, msg, systemMessageDeps);
    return true;
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    handleSdkCompactBoundary(session, msg as CLISystemCompactBoundaryMessage, systemMessageDeps);
    return true;
  }

  if (msg.type === "user") {
    handleClaudeCliUserMessage(session, msg as CLIUserMessage, cliUserMessageDeps);
    return true;
  }

  return false;
}

function handleSdkStatusChange(
  session: SystemMessageSessionLike,
  msg: { status?: string | null; permissionMode?: string },
  deps: SystemMessageDeps,
): void {
  const wasCompacting = session.state.is_compacting;
  const forceCompactPending = session.forceCompactPending;
  const enteringCompacting = msg.status === "compacting" && (!wasCompacting || forceCompactPending);
  if (enteringCompacting && !session.cliResuming) {
    const ts = Date.now();
    const markerId = `compact-boundary-${ts}`;
    session.messageHistory.push({
      type: "compact_marker",
      timestamp: ts,
      id: markerId,
    });
    recordCompactionStarted(session, { id: markerId, timestamp: ts });
    deps.freezeHistoryThroughCurrentTail(session);
    session.awaitingCompactSummary = true;
    deps.broadcastToBrowsers(session, {
      type: "compact_boundary",
      id: markerId,
      timestamp: ts,
    });
    deps.broadcastToBrowsers(session, {
      type: "session_update",
      session: { lifecycle_events: session.state.lifecycle_events },
    });
  }
  handleSystemStatus(
    session,
    {
      type: "system",
      subtype: "status",
      status: msg.status ?? null,
      ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
    } as CLISystemStatusMessage,
    deps,
  );
  deps.persistSession(session);
}

function handleSdkCompactBoundary(
  session: SystemMessageSessionLike,
  msg: CLISystemCompactBoundaryMessage,
  deps: SystemMessageDeps,
): void {
  if (session.cliResuming) return;

  const cliUuid = msg.uuid;
  const meta = msg.compact_metadata;
  if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

  const existingMarker = session.messageHistory.findLast(
    (message) => message.type === "compact_marker" && message.markerKind !== "session_recycled",
  );
  if (existingMarker && existingMarker.type === "compact_marker" && !existingMarker.cliUuid) {
    existingMarker.cliUuid = cliUuid;
    existingMarker.trigger = meta?.trigger;
    existingMarker.preTokens = meta?.pre_tokens;
    recordCompactionBoundary(session, {
      id: existingMarker.id ?? `compact-boundary-${existingMarker.timestamp}`,
      timestamp: existingMarker.timestamp,
      trigger: meta?.trigger,
      preTokens: meta?.pre_tokens,
    });
    deps.broadcastToBrowsers(session, {
      type: "session_update",
      session: { lifecycle_events: session.state.lifecycle_events },
    });
    deps.persistSession(session);
    return;
  }

  session.compactedDuringTurn = true;
  handleCompactBoundary(session, msg, deps);
}

export function getAssistantContentAppendBlocks(
  existing: CLIAssistantMessage["message"]["content"],
  incoming: CLIAssistantMessage["message"]["content"],
  seenToolUseIds: Set<string>,
): CLIAssistantMessage["message"]["content"] {
  if (incoming.length === 0) return [];
  const existingSignatures = existing.map((block) => JSON.stringify(block));
  const incomingSignatures = incoming.map((block) => JSON.stringify(block));
  if (hasAssistantContentSequence(existingSignatures, incomingSignatures)) return [];

  const overlap = getAssistantContentOverlapLength(existingSignatures, incomingSignatures);
  const append: CLIAssistantMessage["message"]["content"] = [];
  for (let index = overlap; index < incoming.length; index++) {
    const block = incoming[index]!;
    if (block.type === "tool_use" && block.id) {
      if (seenToolUseIds.has(block.id)) continue;
      seenToolUseIds.add(block.id);
    }
    append.push(block);
  }
  return append;
}

function mergeAssistantRawContent(
  existing: CLIAssistantMessage["message"]["content"],
  incoming: CLIAssistantMessage["message"]["content"],
): CLIAssistantMessage["message"]["content"] {
  if (incoming.length === 0) return existing;
  const existingSignatures = existing.map((block) => JSON.stringify(block));
  const incomingSignatures = incoming.map((block) => JSON.stringify(block));

  if (hasAssistantContentSequence(incomingSignatures, existingSignatures)) return [...incoming];
  if (hasAssistantContentSequence(existingSignatures, incomingSignatures)) return existing;

  const overlap = getAssistantContentOverlapLength(existingSignatures, incomingSignatures);
  if (overlap > 0) return [...existing, ...incoming.slice(overlap)];
  return [...existing, ...incoming];
}

export function extractActivityPreview(session: AssistantMessageSessionLike, content: unknown[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const candidate = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (candidate.type !== "tool_use") continue;
    if (candidate.name === "TodoWrite") {
      const todos = candidate.input?.todos as { status?: string; activeForm?: string; content?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const active = todos.find((todo) => todo.status === "in_progress");
        session.lastActivityPreview = active ? (active.activeForm || active.content || "").slice(0, 80) : undefined;
      }
    } else if (candidate.name === "TaskUpdate") {
      const status = candidate.input?.status as string | undefined;
      const activeForm = candidate.input?.activeForm as string | undefined;
      if (status === "in_progress" && activeForm) {
        session.lastActivityPreview = activeForm.slice(0, 80);
      }
    }
  }
}

function handleSystemStatus(
  session: SystemMessageSessionLike,
  msg: CLISystemStatusMessage,
  deps: SystemMessageDeps,
): void {
  const wasCompacting = session.state.is_compacting;
  const forceCompactPending = session.forceCompactPending;
  session.state.is_compacting = msg.status === "compacting";
  const enteringCompacting = msg.status === "compacting" && (!wasCompacting || forceCompactPending);
  if (msg.status === "compacting") {
    session.forceCompactPending = false;
  }
  if (enteringCompacting && !session.cliResuming) {
    session.compactedDuringTurn = true;
    deps.emitTakodeEvent(session.id, "compaction_started", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
  }
  if (wasCompacting && msg.status !== "compacting" && !session.cliResuming) {
    recordCompactionFinished(session);
    deps.broadcastToBrowsers(session, {
      type: "session_update",
      session: { lifecycle_events: session.state.lifecycle_events },
    });
    deps.emitTakodeEvent(session.id, "compaction_finished", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
    deps.injectCompactionRecovery(session);
  }

  if (msg.permissionMode) {
    session.state.permissionMode = msg.permissionMode;
    if (!session.cliResuming) {
      const uiMode = msg.permissionMode === "plan" ? "plan" : "agent";
      session.state.uiMode = uiMode;
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode, uiMode },
      });
    } else {
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode },
      });
    }
  }

  if (!session.cliResuming) {
    deps.broadcastToBrowsers(session, { type: "status_change", status: msg.status ?? null });
    deps.onSessionActivityStateChanged(session.id, "system_status");
  }
}

function handleCompactBoundary(
  session: SystemMessageSessionLike,
  msg: CLISystemCompactBoundaryMessage,
  deps: SystemMessageDeps,
): void {
  if (session.cliResuming) return;
  const cliUuid = msg.uuid;
  const meta = msg.compact_metadata;
  if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

  const ts = Date.now();
  const markerId = `compact-boundary-${ts}`;
  session.messageHistory.push({
    type: "compact_marker",
    timestamp: ts,
    id: markerId,
    cliUuid,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  recordCompactionBoundary(session, {
    id: markerId,
    timestamp: ts,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.freezeHistoryThroughCurrentTail(session);
  session.awaitingCompactSummary = true;
  deps.broadcastToBrowsers(session, {
    type: "compact_boundary",
    id: markerId,
    timestamp: ts,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { lifecycle_events: session.state.lifecycle_events },
  });
  deps.persistSession(session);
}

function handleTaskNotification(
  session: SystemMessageSessionLike,
  msg: CLISystemTaskNotificationMessage,
  deps: SystemMessageDeps,
): void {
  const browserMsg = {
    type: "task_notification" as const,
    task_id: msg.task_id,
    tool_use_id: msg.tool_use_id,
    status: msg.status,
    output_file: msg.output_file,
    summary: msg.summary,
  };
  if (msg.task_id && msg.tool_use_id && deps.hasTaskNotificationReplay(session, msg.task_id, msg.tool_use_id)) {
    return;
  }
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
}

function handleStreamEventMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIStreamEventMessage,
  deps: Pick<PassthroughMessageDeps, "broadcastToBrowsers">,
): void {
  markRecentAskVisibleResponseFromStream(session, msg as BrowserIncomingMessage);
  deps.broadcastToBrowsers(session, {
    type: "stream_event",
    event: msg.event,
    parent_tool_use_id: msg.parent_tool_use_id,
  });
}

function handleControlCancelRequestMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIControlCancelRequestMessage,
  deps: PassthroughMessageDeps,
): void {
  const reqId = msg.request_id;
  const pending = session.pendingPermissions.get(reqId);
  if (!pending) return;
  deps.abortAutoApproval(session, reqId);
  session.pendingPermissions.delete(reqId);
  deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
  deps.cancelPermissionNotification(session.id, reqId);
  deps.clearActionAttentionIfNoPermissions(session);
  deps.persistSession(session);
  console.log(
    `[ws-bridge] CLI cancelled pending permission ${reqId} (${pending.tool_name}) for session ${sessionTag(session.id)}`,
  );
}

function handleToolProgressMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIToolProgressMessage,
  deps: Pick<PassthroughMessageDeps, "broadcastToBrowsers">,
): void {
  if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
    const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
    const merged = prev + msg.output_delta;
    session.toolProgressOutput.set(
      msg.tool_use_id,
      merged.length > TOOL_PROGRESS_OUTPUT_LIMIT ? merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT) : merged,
    );
  }
  session.lastToolProgressAt = Date.now();
  deps.broadcastToBrowsers(session, {
    type: "tool_progress",
    tool_use_id: progressToolUseId(msg),
    tool_name: msg.tool_name,
    elapsed_time_seconds: msg.elapsed_time_seconds,
    ...(typeof msg.output_delta === "string" ? { output_delta: msg.output_delta } : {}),
  });
}

/**
 * Claude CLI heartbeats for a long-running tool arrive as `tool_progress` with
 * `heartbeat: true` and a fresh `<toolUseId>-heartbeat-<n>` id every 30s.
 * Report them under the real tool id so the browser keeps one entry per tool
 * that the tool's result clears, instead of a growing list of stale entries.
 */
function progressToolUseId(msg: CLIToolProgressMessage): string {
  return msg.heartbeat === true ? msg.tool_use_id.replace(/-heartbeat-\d+$/, "") : msg.tool_use_id;
}

function handleToolUseSummaryMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIToolUseSummaryMessage,
  deps: Pick<PassthroughMessageDeps, "broadcastToBrowsers">,
): void {
  deps.broadcastToBrowsers(session, {
    type: "tool_use_summary",
    summary: msg.summary,
    tool_use_ids: msg.preceding_tool_use_ids,
  });
}

function handleAuthStatusMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIAuthStatusMessage,
  deps: Pick<PassthroughMessageDeps, "broadcastToBrowsers">,
): void {
  deps.broadcastToBrowsers(session, {
    type: "auth_status",
    isAuthenticating: msg.isAuthenticating,
    output: msg.output,
    error: msg.error,
  });
}

function maybeUpdateContextUsedPercentFromAssistantUsage(
  session: AssistantMessageSessionLike,
  usage: TokenUsage | undefined,
  modelHint: string | undefined,
  broadcastToBrowsers: HandleAssistantMessageDeps["broadcastToBrowsers"],
): void {
  if (!usage) return;
  const model = session.state.model || modelHint;
  const contextWindow = resolveLiveClaudeContextWindow(model, session.state.claude_token_details);
  if (!contextWindow) return;
  const nextContextPct = computeContextUsedPercent(usage, contextWindow);
  if (typeof nextContextPct !== "number" || session.state.context_used_percent === nextContextPct) return;
  session.state.context_used_percent = nextContextPct;
  recordContextUsageHistory(session, "claude_assistant_usage");
  broadcastToBrowsers(session, {
    type: "session_update",
    session: { context_used_percent: nextContextPct },
  });
}

function hasAssistantContentSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function getAssistantContentOverlapLength(existing: string[], incoming: string[]): number {
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let size = maxOverlap; size > 0; size--) {
    let matches = true;
    for (let offset = 0; offset < size; offset++) {
      if (existing[existing.length - size + offset] !== incoming[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "TaskStop",
]);
