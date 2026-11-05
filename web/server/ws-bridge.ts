import { BrowserSocketSessionSwitches } from "./bridge/browser-socket-session-switches.js";
import type { QuestStartedFrom } from "./quest-types.js";
import { notifySessionSavedForArtifacts } from "./artifact-library.js";
import { noteSessionError, noteTurnEnded, type TurnEndOutcome } from "./scribe-registry.js";
import type { ViewportHandoffSessionState } from "../shared/viewport-handoff.js";
import type { KnownSnapshotParts } from "../shared/snapshot-part-hash.js";
import { viewportHandoffStateMessage } from "./bridge/browser-subscribe-snapshots.js";
import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { computeCodexRetainedPayloadBytes, computeReplayHistoryBytes } from "./session-payload-metrics.js";
import { notifyCodexWorkerV2RolloutActivity } from "./codex-worker-v2-rollout-hooks.js";
import { WsBridgeSyncedProjectionController } from "./ws-bridge-synced-projections.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import type { PushoverNotifier } from "./pushover.js";
import type { TrafficStatsSnapshot } from "./traffic-stats.js";
import type {
  CLIMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLISystemCompactBoundaryMessage,
  CLIUserMessage,
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
  BufferedBrowserEvent,
  ToolResultPreview,
  ContentBlock,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  SessionTaskEntry,
  CodexOutboundTurn,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  VsCodeSelectionState,
  VsCodeWindowState,
  VsCodeOpenFileCommand,
  CodexLeaderRecycleTrigger,
  TakodeEvent,
  TakodeEventDataByType,
  TakodeEventType,
  TakodePermissionRequestEventData,
  TakodeWorkerStreamEventData,
  BoardRow,
  SessionNotification,
  SessionAttentionRecord,
  TakodeHerdBatchSnapshot,
  ThreadRef,
  ActiveTurnRoute,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT, assertNever, formatVsCodeSelectionPrompt } from "./session-types.js";
import type { QuestJourneyState } from "./session-types.js";
import { SessionStore } from "./session-store.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot, CodexSessionMeta } from "./codex-adapter.js";
import type { ClaudeSdkSessionMeta } from "./claude-sdk-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";
import type { CliLauncher } from "./cli-launcher.js";
import { buildBoardRowSessionStatuses } from "./board-row-session-status.js";
import * as gitUtils from "./git-utils.js";
import { sessionTag } from "./session-tag.js";
import type { PerfTracer } from "./perf-tracer.js";
import { HerdEventDispatcher, isSessionIdleRuntime } from "./herd-event-dispatcher.js";
import { injectCompactionRecovery as injectCompactionRecoveryController } from "./bridge/compaction-recovery.js";
import { detectLongSleepBashCommand, LONG_SLEEP_REMINDER_TEXT } from "./bridge/bash-sleep-policy.js";
import { getApprovalSummary, getDenialSummary } from "./bridge/permission-summaries.js";
import {
  cleanupBranchState as cleanupBranchStateIndex,
  invalidateSessionsSharingBranch as invalidateSessionsSharingBranchIndex,
  updateBranchIndex as updateBranchIndexState,
} from "./bridge/branch-session-index.js";
import {
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementState,
  completeCodexTurn as completeCodexTurnState,
  enqueueCodexTurn as enqueueCodexTurnState,
  getCodexHeadTurn as getCodexHeadTurnState,
  getCodexTurnAwaitingAck as getCodexTurnAwaitingAckState,
  getCodexTurnInRecovery as getCodexTurnInRecoveryState,
  removeCompletedCodexTurns as removeCompletedCodexTurnsState,
} from "./bridge/codex-turn-queue.js";
import {
  clampFrozenCount as clampFrozenCountController,
  freezeHistoryThroughCurrentTail as freezeHistoryThroughCurrentTailController,
} from "./bridge/browser-transport-controller.js";
import {
  broadcastToBrowsers as broadcastToBrowsersController,
  deriveActiveTurnRoute as deriveActiveTurnRouteBrowserTransportController,
  deriveSessionStatus as deriveSessionStatusController,
  findMatchingPendingCodexInput as findMatchingPendingCodexInputBrowserTransportController,
  getPendingCodexInputDeliveryState as getPendingCodexInputDeliveryStateBrowserTransportController,
  handleBrowserClose as handleBrowserCloseController,
  handleBrowserMessage as handleBrowserMessageTransportController,
  handleBrowserOpen as handleBrowserOpenController,
  isHerdEventSource as isHerdEventSourceBrowserTransportController,
  type ProgrammaticUserMessageOptions,
  isHistoryBackedEvent as isHistoryBackedEventController,
  refreshBrowserConversationViews as refreshBrowserConversationViewsController,
  sameAgentSource as sameAgentSourceBrowserTransportController,
  sendToBrowser,
} from "./bridge/browser-transport-controller.js";
import {
  captureSessionNavigationLauncherActivity,
  captureSessionNavigationSourceMessage,
  getSessionNavigationLastActivityAt,
  resolveSessionNavigationStatus,
} from "./bridge/session-navigation-projection-controller.js";
import { isSessionPaused } from "./session-pause.js";
import type { BrowserTransportStateLike } from "./bridge/browser-transport-controller.js";
import { deliverProgrammaticUserMessage } from "./bridge/programmatic-user-message-delivery.js";
import { isSystemSourceTag } from "./bridge/adapter-browser-routing-source-tags.js";
import {
  handleCodexResultErrorAutoPauseForBridge,
  pruneStalePendingCodexHerdInputsForBridge,
} from "./bridge/ws-bridge-codex-pending-input-deps.js";
import { pauseSessionForDelivery, unpauseSessionForDelivery } from "./bridge/session-pause-delivery.js";
import { resumeRecoveryDeliveryTransfers } from "./bridge/recovery-delivery-transfer.js";
import { getRecoveryDeliveryTransferDepsForBridge } from "./bridge/ws-bridge-recovery-delivery-transfer-deps.js";
import {
  routeSideChatUserMessage as routeSideChatUserMessageController,
  syncSideChatRecord as syncSideChatRecordController,
  syncSideChatRecordForChild as syncSideChatRecordForChildController,
  type SideChatBridgeDeps,
} from "./side-chat-bridge.js";
import { attachClaudeSdkAdapterLifecycle } from "./bridge/claude-sdk-adapter-lifecycle-controller.js";
import { flushQueuedMessagesToCodexAdapter as flushQueuedMessagesToCodexAdapterController } from "./bridge/codex-adapter-browser-message-controller.js";
import {
  completeDoneBoardRowsForQuestInAllSessions as completeDoneBoardRowsForQuestInAllSessionsController,
  completeQueuedBoardRowsForQuestInAllSessions as completeQueuedBoardRowsForQuestInAllSessionsController,
  getBoardForSession as getBoardForSessionController,
  getBoardDispatchableSignature as getBoardDispatchableSignatureController,
  getBoardDispatchableSignatureForSession as getBoardDispatchableSignatureForSessionController,
  getBoardStallSignature as getBoardStallSignatureController,
  getBoardStallSignatureForSession as getBoardStallSignatureForSessionController,
  getCompletedBoardForSession as getCompletedBoardForSessionController,
  pruneStaleBoardStalledHerdBatch as pruneStaleBoardStalledHerdBatchController,
  removeBoardRowFromAllSessions as removeBoardRowFromAllSessionsController,
  sweepBoardDispatchableWarnings as sweepBoardDispatchableWarningsController,
  sweepBoardStallWarnings as sweepBoardStallWarningsController,
} from "./bridge/board-watchdog-controller.js";
import { listSessionWaits } from "./bridge/board-stall-participants.js";
import {
  buildCodexLeaderRecycleTokenUsage,
  failCodexLeaderRecycleRecovery,
  prepareCodexLeaderRecycleSession,
} from "./bridge/codex-leader-recycle-controller.js";
import {
  backendAttached as backendAttachedController,
  backendConnected as backendConnectedController,
  beginCodexRollback as beginCodexRollbackController,
  buildPersistedSessionPayload as buildPersistedSessionPayloadController,
  clearActionAttentionIfNoPermissions as clearActionAttentionIfNoPermissionsController,
  clearAttentionAndMarkRead as clearAttentionAndMarkReadController,
  clearCodexAutomaticRecoverySuppression as clearCodexAutomaticRecoverySuppressionController,
  deriveBackendState as deriveBackendStateController,
  finalizeCodexRollback as finalizeCodexRollbackController,
  getNotifications as getNotificationsController,
  getCurrentTurnTriggerSource as getCurrentTurnTriggerSourceController,
  handleResultAttentionAndNotifications as handleResultAttentionAndNotificationsController,
  killSession as killSessionController,
  getOrCreateSession as getOrCreateSessionController,
  hasAssistantReplay as hasAssistantReplayController,
  hasCompactBoundaryReplay as hasCompactBoundaryReplayController,
  hasResultReplay as hasResultReplayController,
  hasTaskNotificationReplay as hasTaskNotificationReplayController,
  hasToolResultPreviewReplay as hasToolResultPreviewReplayController,
  hasUserPromptReplay as hasUserPromptReplayController,
  markAllNotificationsDoneBySessionId as markAllNotificationsDoneBySessionIdController,
  markCodexAutoRecoveryFailed as markCodexAutoRecoveryFailedController,
  markNotificationDoneBySessionId as markNotificationDoneBySessionIdController,
  notifyUserBySessionId as notifyUserBySessionIdController,
  prepareSessionForRevert as prepareSessionForRevertController,
  reconcileCodexQuestToolResult as reconcileCodexQuestToolResultController,
  restorePersistedSessions as restorePersistedSessionsController,
  removeSession as removeSessionController,
  getSessionActivitySnapshot as getSessionActivitySnapshotController,
  setBackendState as setBackendStateController,
  setAttention as setAttentionController,
  trackCodexQuestCommands as trackCodexQuestCommandsController,
  closeSession as closeSessionController,
  wakeDueSnoozedNotifications as wakeDueSnoozedNotificationsController,
} from "./bridge/session-registry-controller.js";
import { isDuplicateCodexAssistantReplay as isDuplicateCodexAssistantReplayController } from "./bridge/codex-assistant-replay-dedup.js";
import { wakeDueThreadReminders } from "./bridge/thread-reminders.js";
import { markCodexTurnRecoveryActionRequired } from "./bridge/codex-interrupted-turn-recovery.js";
import { codexReasoningSnapshotFields } from "./bridge/codex-reasoning-preview-state.js";
import { createClaudeMessageHandlers as createClaudeMessageHandlersController } from "./bridge/claude-message-controller.js";
import {
  handleCodexPermissionRequest as handleCodexPermissionRequestController,
  handleInterrupt as handleInterruptController,
  handleSetModel as handleSetModelController,
  handleCodexSetModel as handleCodexSetModelController,
  handleCodexSetReasoningEffort as handleCodexSetReasoningEffortController,
  handleSdkPermissionRequest as handleSdkPermissionRequestController,
  handleSetAskPermission as handleSetAskPermissionController,
  handleSetPermissionMode as handleSetPermissionModeController,
  handleCodexSetPermissionMode as handleCodexSetPermissionModeController,
  handleCodexSetUiMode as handleCodexSetUiModeController,
  hasPendingForceCompact as hasPendingForceCompactController,
  isCliSlashCommand as isCliSlashCommandController,
  queueForceCompactPendingMessage as queueForceCompactPendingMessageController,
} from "./bridge/adapter-browser-routing-controller.js";
import {
  interruptSession as interruptSessionController,
  setClaudeReasoningEffort as setClaudeReasoningEffortController,
  setCodexServiceTier as setCodexServiceTierController,
  setSessionModel as setSessionModelController,
  setSessionPermissionMode as setSessionPermissionModeController,
} from "./bridge/browser-control-routing.js";
import {
  addPendingCodexInput as addPendingCodexInputController,
  attachCodexAdapterLifecycle as attachCodexAdapterLifecycleController,
  armCodexFreshTurnRequirement as armCodexFreshTurnRequirementController,
  clearCodexIntentionalRelaunch as clearCodexIntentionalRelaunchController,
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementController,
  commitPendingCodexInputs as commitPendingCodexInputsController,
  completeCodexTurnsForResult as completeCodexTurnsForResultController,
  dispatchQueuedCodexTurns as dispatchQueuedCodexTurnsController,
  extractUserTextFromResumedTurn as extractUserTextFromResumedTurnController,
  getCancelablePendingCodexInputs as getCancelablePendingCodexInputsController,
  getPendingCodexInputsByIds as getPendingCodexInputsByIdsController,
  hydrateCodexResumedHistory as hydrateCodexResumedHistoryController,
  markCodexIntentionalRelaunch as markCodexIntentionalRelaunchController,
  maybeFlushQueuedCodexMessages as maybeFlushQueuedCodexMessagesController,
  pokeStaleCodexPendingDelivery as pokeStaleCodexPendingDeliveryController,
  rebuildQueuedCodexPendingStartBatch as rebuildQueuedCodexPendingStartBatchController,
  reconcileCodexResumedTurn as reconcileCodexResumedTurnController,
  recordSteeredCodexTurn as recordSteeredCodexTurnController,
  removePendingCodexInput as removePendingCodexInputController,
  retryPendingCodexTurn as retryPendingCodexTurnController,
  requestCodexAutoRecovery as requestCodexAutoRecoveryOrchestratorController,
  setPendingCodexInputCancelable as setPendingCodexInputCancelableController,
  setPendingCodexInputsCancelable as setPendingCodexInputsCancelableController,
  trySteerPendingCodexInputs as trySteerPendingCodexInputsController,
} from "./bridge/codex-recovery-orchestrator.js";
import {
  rearmRecoveredQueuedHeadTurn as rearmRecoveredQueuedHeadTurnController,
  reconcileRecoveredQueuedTurnLifecycle as reconcileRecoveredQueuedTurnLifecycleController,
} from "./bridge/codex-queued-turn-lifecycle.js";
import { retireCodexAutoPauseRecoveryTesting } from "./bridge/codex-auto-pause-recovery-testing.js";
import {
  buildToolResultPreviews as buildToolResultPreviewsController,
  clearAllCodexToolResultWatchdogs as clearAllCodexToolResultWatchdogsController,
  clearCodexToolResultWatchdog as clearCodexToolResultWatchdogController,
  collectCompletedToolStartTimes as collectCompletedToolStartTimesController,
  finalizeSupersededCodexTerminalTools as finalizeSupersededCodexTerminalToolsController,
  finalizeOrphanedTerminalToolsOnResult as finalizeOrphanedTerminalToolsOnResultController,
  finalizeRecoveredDisconnectedTerminalTools as finalizeRecoveredDisconnectedTerminalToolsController,
  findToolUseBlockInHistory as findToolUseBlockInHistoryController,
  getIndexedToolResult,
  getToolResultPreviewLimit as getToolResultPreviewLimitController,
  pruneToolResultsForCurrentHistory as pruneToolResultsForCurrentHistoryController,
  recoverToolStartTimesFromHistory as recoverToolStartTimesFromHistoryController,
  scheduleCodexToolResultWatchdogs as scheduleCodexToolResultWatchdogsController,
  shouldDeferCodexToolResultWatchdog as shouldDeferCodexToolResultWatchdogController,
  synthesizeCodexToolResultsFromResumedTurn as synthesizeCodexToolResultsFromResumedTurnController,
  type CodexToolResultSynthesisSummary,
} from "./bridge/tool-result-recovery-controller.js";

// `takode board` output is compact, high-signal state that agents routinely
// reason about. A 300-char tail preview can hide dependent rows and make the
// model think a row disappeared when only the preview was truncated.
const TAKODE_BOARD_RESULT_PREVIEW_LIMIT = 12_000;
import type { QuestLifecycleStatus } from "./bridge/quest-detector.js";

export interface RestartPrepCodexFallbackOutcome {
  ok: boolean;
  action: "codex_recovery_requested" | "codex_disconnected" | "skipped" | "failed";
  detail: string;
  diagnostics?: Record<string, string | number | boolean | null>;
}
import {
  clearOptimisticRunningTimer as clearOptimisticRunningTimerLifecycle,
  getQueuedTurnLifecycleEntries as getQueuedTurnLifecycleEntriesLifecycle,
  markRunningFromUserDispatch as markRunningFromUserDispatchLifecycle,
  markTurnInterrupted as markTurnInterruptedLifecycle,
  promoteNextQueuedTurn as promoteNextQueuedTurnLifecycle,
  reconcileTerminalResultState as reconcileTerminalResultStateLifecycle,
  replaceQueuedTurnLifecycleEntries as replaceQueuedTurnLifecycleEntriesLifecycle,
  setGenerating as setGeneratingLifecycle,
  type InterruptSource as GenerationInterruptSource,
  type UserDispatchTurnTarget,
  trackUserMessageForTurn as trackUserMessageForTurnLifecycle,
} from "./bridge/generation-lifecycle.js";
import { reconcileRestoredBoardRows } from "./bridge/restored-board-state.js";
import { runWsBridgeStuckSessionWatchdogSweep } from "./bridge/stuck-session-watchdog-controller.js";
import { buildTurnToolSummary as buildTurnToolSummaryController } from "./bridge/turn-tool-summary.js";
import {
  computeDiffStatsAsync as computeDiffStatsAsyncController,
  makeDefaultState,
  refreshGitInfo as refreshGitInfoController,
  refreshWorktreeGitStateForSnapshot as refreshWorktreeGitStateForSnapshotController,
  recomputeDiffIfDirty as recomputeDiffIfDirtyController,
} from "./bridge/session-git-state.js";
import type {
  BackendAdapter,
  CompactRequestedAwareAdapter,
  CurrentTurnIdAwareAdapter,
  PendingOutgoingAwareAdapter,
  RateLimitsAwareAdapter,
  TurnSteerFailedAwareAdapter,
  TurnStartedAwareAdapter,
  TurnSteeredAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./bridge/adapter-interface.js";

const ADAPTER_FAILURE_RESET_WINDOW_MS = 120_000;
const CODEX_INTENTIONAL_RELAUNCH_GUARD_MS = 15_000;
const CODEX_RETRY_SAFE_RESUME_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "contextCompaction"]);
const CODEX_TOOL_RESULT_WATCHDOG_MS = 120_000;

export type { SocketData, WorkerStreamCheckpointResult } from "./bridge/ws-bridge-session.js";
import type {
  BrowserSocketData,
  CodexBridgeAdapter,
  ClaudeSdkBridgeAdapter,
  GitSessionKey,
  InterruptSource,
  Session,
  SocketData,
  WorkerStreamCheckpointResult,
} from "./bridge/ws-bridge-session.js";
import {
  getSessionGitStateDeps as getSessionGitStateDepsController,
  getSessionCleanupDeps as getSessionCleanupDepsController,
  getSessionNotificationDeps as getSessionNotificationDepsController,
  getSessionRegistryDeps as getSessionRegistryDepsController,
  getCompactionRecoveryRuntimeDeps as getCompactionRecoveryRuntimeDepsController,
  getCommonClaudeRuntimeDeps as getCommonClaudeRuntimeDepsController,
  getCommonCodexRuntimeDeps as getCommonCodexRuntimeDepsController,
  getClaudeMessageHandlers as getClaudeMessageHandlersController,
  getToolResultRecoveryDeps as getToolResultRecoveryDepsController,
  getBrowserTransportDeps as getBrowserTransportDepsController,
  getClaudeSdkAdapterLifecycleDeps as getClaudeSdkAdapterLifecycleDepsController,
  getCodexAdapterBrowserMessageDeps as getCodexAdapterBrowserMessageDepsController,
  getCodexAttachLifecycleDeps as getCodexAttachLifecycleDepsController,
  getWorkBoardStateDeps as getWorkBoardStateDepsController,
  getQuestBoardCompletionDeps as getQuestBoardCompletionDepsController,
  getBoardWatchdogDeps as getBoardWatchdogDepsController,
  getBrowserRoutingDeps as getBrowserRoutingDepsController,
  getCodexRecoveryOrchestratorDeps as getCodexRecoveryOrchestratorDepsController,
  getGenerationLifecycleDeps as getGenerationLifecycleDepsController,
  maybeBroadcastGlobalSessionActivityUpdate,
  sessionBackgroundTasks,
} from "./ws-bridge-deps.js";
import {
  broadcastGlobalAndScheduleBoardParticipantRefresh,
  scheduleBoardParticipantRefreshForSession,
} from "./bridge/board-participant-invalidation-controller.js";

const BOARD_STALL_THRESHOLD_MS = 3 * 60_000;

const CODEX_DISCONNECT_GRACE_MS = 15_000;
const CODEX_RECOVERY_TIMEOUT_MS = 30_000;

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private static readonly EVENT_BUFFER_LIMIT = 600;
  private static readonly LEADER_GROUP_IDLE_NOTIFY_DELAY_MS = 10_000;
  private static readonly USER_MESSAGE_RUNNING_TIMEOUT_MS = 30_000;
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  private sessions = new Map<string, Session>();
  private readonly syncedProjections = new WsBridgeSyncedProjectionController({
    getSession: (sessionId) => this.sessions.get(sessionId),
    listSessions: () => this.sessions.values(),
    getLauncherSessionInfo: (sessionId) => this.launcher?.getSession(sessionId),
    getSessionName: (sessionId) =>
      this.sessionStoredNameGetter?.(sessionId) ?? this.launcher?.getSession(sessionId)?.name,
    getPendingTimerCount: (sessionId) => this.timerManager?.listTimers(sessionId).length ?? 0,
    getWaits: (sessionId) =>
      listSessionWaits(sessionId, {
        getLeaseWaits: (id) => this.resourceLeaseManager?.getLeaseWaits(id) ?? [],
        getBackgroundTasks: (id) => sessionBackgroundTasks(this.sessions.get(id), id),
        isLandingActive: (id) => this.landingQueue?.isLandingActive(id) ?? false,
        listBoardSessions: () => this.sessions.values(),
      }),
    getBackendConnected: (sessionId) => this.isBackendConnected(sessionId),
    getSessionStatus: (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (!session) return null;
      return resolveSessionNavigationStatus(
        session,
        deriveSessionStatusController(session, {
          backendConnected: backendConnectedController,
        }) as "running" | "compacting" | "reverting" | "idle" | null,
      );
    },
    getLastActivityAt: (sessionId) =>
      getSessionNavigationLastActivityAt(
        this.sessions.get(sessionId),
        this.launcher?.getSession(sessionId)?.lastActivityAt,
      ),
    getLastUserMessageAt: (sessionId) => this.launcher?.getSession(sessionId)?.lastUserMessageAt,
    getLastMessagePreviewAt: (sessionId) => this.sessions.get(sessionId)?.lastMessagePreviewAt,
    persistSession: (session) => this.persistSession(session),
  });
  private sideChatBridgeDeps: SideChatBridgeDeps = {
    sessions: this.sessions,
    getBrowserRoutingDeps: () => this.getBrowserRoutingDeps(),
    broadcastToBrowsers: (session, msg) => this.broadcastToBrowsers(session, msg),
    persistSession: (session) => this.persistSession(session),
  };
  /** Per-session serialization chain for externally injected/browser-routed messages.
   *  Preserves send order across async image ingestion without blocking other sessions. */
  private sessionRouteChains = new Map<string, Promise<void>>();
  private readonly browserSocketSwitches = new BrowserSocketSessionSwitches();
  private viewportHandoffReader: ((sessionId: string) => Promise<ViewportHandoffSessionState | null>) | null = null;
  private workerStreamCheckpointMsgTo = new Map<string, number>();
  /** Per-session serialization chain for Codex quest lifecycle reconciliation. */
  private codexQuestLifecycleChains = new Map<string, Promise<void>>();
  store: SessionStore | null = null;
  recorder: RecorderManager | null = null;
  timerManager: import("./timer-manager.js").TimerManager | null = null;
  resourceLeaseManager: import("./resource-lease-manager.js").ResourceLeaseManager | null = null;
  landingQueue: import("./landing-queue-manager.js").LandingQueueManager | null = null;
  /** Moves quests through the Landing phase as their changes land or bounce. */
  landingHandoff: import("./landing-quest-handoff.js").LandingQuestHandoff | null = null;
  /** Applies final Memory's parked completion once the quest's change landed (set by the quest routes). */
  completeLandedQuest:
    | ((
        questId: string,
        completion: import("./session-types.js").ParkedQuestCompletion,
        workerSessionId: string,
      ) => Promise<void>)
    | null = null;
  imageStore: ImageStore | null = null;
  pushoverNotifier: PushoverNotifier | null = null;
  launcher: CliLauncher | null = null;
  herdEventDispatcher: Pick<
    HerdEventDispatcher,
    | "emitTakodeEvent"
    | "emitTakodeEventForOrchestrator"
    | "subscribeTakodeEvents"
    | "onSessionActivityStateChanged"
    | "onOrchestratorTurnEnd"
    | "onOrchestratorDisconnect"
    | "getDiagnostics"
    | "forceFlushPendingEvents"
  > | null = null;
  perfTracer: PerfTracer | null = null;
  onCLISessionId:
    | ((
        sessionId: string,
        cliSessionId: string,
        instructionSnapshot?: import("./codex-adapter-types.js").CodexInstructionSnapshot,
      ) => void)
    | null = null;
  onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  onPermissionModeChanged: ((sessionId: string, newMode: string) => void) | null = null;
  onSessionRelaunchRequested: ((sessionId: string) => void) | null = null;
  onUserMessage:
    | ((
        sessionId: string,
        history: import("./session-types.js").BrowserIncomingMessage[],
        cwd: string,
        wasGenerating: boolean,
      ) => void)
    | null = null;
  onTurnCompleted:
    | ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void)
    | null = null;
  onAgentPaused:
    | ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void)
    | null = null;
  onSessionNamedByQuest: ((sessionId: string, title: string) => void) | null = null;
  resolveQuestTitle: ((questId: string) => Promise<string | null>) | null = null;
  resolveQuestStatus: ((questId: string) => Promise<string | null>) | null = null;
  resolveQuestStartedFrom: ((questId: string) => Promise<QuestStartedFrom | null>) | null = null;
  private userMsgCounter = 0;
  /** Per-project cache of slash commands, skills, and apps so new sessions get them
   *  before the CLI sends system/init (which only arrives after the first
   *  user message). Key is repo_root || cwd. */
  private slashCommandCache = new Map<
    string,
    {
      slash_commands: string[];
      skills: string[];
      skill_metadata: NonNullable<SessionState["skill_metadata"]>;
      apps: NonNullable<SessionState["apps"]>;
    }
  >();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recent CLI disconnects to detect mass disconnect events. */
  /** Machine-global browser transport state shared with VS Code/browser routing. */
  private browserTransportState: BrowserTransportStateLike = {
    vscodeSelectionState: null,
    vscodeWindows: new Map<string, VsCodeWindowState>(),
    vscodeOpenFileQueues: new Map<string, VsCodeOpenFileCommand[]>(),
    pendingVsCodeOpenResults: new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >(),
  };

  private static readonly VSCODE_WINDOW_STALE_MS = 30_000;
  private static readonly VSCODE_OPEN_FILE_TIMEOUT_MS = 8_000;
  sessionNameGetter: ((sessionId: string) => string) | null = null;
  /** Raw persisted name lookup for source-of-truth projections; unlike sessionNameGetter, it has no display fallback. */
  sessionStoredNameGetter: ((sessionId: string) => string | undefined) | null = null;
  onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;

  // ── Cross-session branch invalidation ──────────────────────────────────
  // Reverse index: branch name → set of session IDs that reference it
  // (as git_branch, diff_base_branch, or git_default_branch).
  // Only active (non-archived) sessions are indexed.
  private branchToSessions = new Map<string, Set<string>>();
  // Tracks which branches each session is indexed under, for fast removal.
  private sessionBranches = new Map<string, Set<string>>();
  // Per-session throttle for cross-session invalidation (epoch ms).
  // 30s prevents cascading when an agent pushes multiple commits in rapid
  // succession -- each push would otherwise trigger O(sessions) refreshes.
  private lastCrossSessionRefreshAt = new Map<string, number>();
  // Coalesce worktree snapshot refreshes so heavy-repo sidebar polls cannot
  // stack slow git refresh/diff jobs for the same session.
  private worktreeSnapshotRefreshes = new Map<string, Promise<SessionState | null>>();
  // Coalesce non-worktree ahead/behind reads across sessions that share the
  // same repo, comparison base, and HEAD.
  private nonWorktreeAheadBehindRefreshes = new Map<string, Promise<{ ahead: number; behind: number }>>();
  private static readonly CROSS_SESSION_THROTTLE_MS = 30_000;

  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "git_default_branch",
    "diff_base_branch",
    "git_head_sha",
    "diff_base_start_sha",
    "is_worktree",
    "is_containerized",
    "repo_root",
    "git_ahead",
    "git_behind",
    "total_lines_added",
    "total_lines_removed",
    "diff_stats_skipped_reason",
  ];

  private static localDateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Fill slash_commands/skills/apps from the per-project cache if not yet populated. */
  private prefillSlashCommands(session: Session): void {
    const projectKey = session.state.repo_root || session.state.cwd;
    const cached = projectKey ? this.slashCommandCache.get(projectKey) : undefined;
    if (cached) {
      if (!session.state.slash_commands?.length) session.state.slash_commands = cached.slash_commands;
      if (!session.state.skills?.length) session.state.skills = cached.skills;
      if (!session.state.skill_metadata?.length) session.state.skill_metadata = cached.skill_metadata;
      if (!session.state.apps?.length) session.state.apps = cached.apps;
    }
  }

  /**
   * When the slash command cache is populated for a project, push the commands
   * to all other sessions with the same project key that still have empty
   * slash_commands/skills/apps, so already-connected browsers get them immediately.
   */
  private backfillSlashCommands(projectKey: string, sourceSessionId: string): void {
    const cached = this.slashCommandCache.get(projectKey);
    if (!cached) return;
    for (const [id, session] of this.sessions) {
      if (id === sourceSessionId) continue;
      const key = session.state.repo_root || session.state.cwd;
      if (key !== projectKey) continue;
      const update: Partial<SessionState> = {};
      if (!session.state.slash_commands?.length && cached.slash_commands.length) {
        session.state.slash_commands = cached.slash_commands;
        update.slash_commands = cached.slash_commands;
      }
      if (!session.state.skills?.length && cached.skills.length) {
        session.state.skills = cached.skills;
        update.skills = cached.skills;
      }
      if (!session.state.skill_metadata?.length && cached.skill_metadata.length) {
        session.state.skill_metadata = cached.skill_metadata;
        update.skill_metadata = cached.skill_metadata;
      }
      if (!session.state.apps?.length && cached.apps.length) {
        session.state.apps = cached.apps;
        update.apps = cached.apps;
      }
      if (Object.keys(update).length > 0 && session.browserSockets.size > 0) {
        this.broadcastToBrowsers(session, { type: "session_update", session: update });
      }
    }
  }

  /** Send periodic pings to all browser sockets to detect dead connections.
   *  A 10s interval detects half-open TCP connections within ~10s instead of ~30s. */
  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      for (const session of this.sessions.values()) {
        // Ping browser sockets (prevents Bun's idle timeout from closing them)
        for (const ws of session.browserSockets) {
          try {
            ws.ping();
          } catch {
            session.browserSockets.delete(ws);
          }
        }
      }
    }, 10_000);
  }

  /** Periodically check for sessions stuck in "generating" state with no CLI activity. */
  startStuckSessionWatchdog(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      runWsBridgeStuckSessionWatchdogSweep({
        sessions: this.sessions.values(),
        now,
        launcher: this.launcher,
        recorder: this.recorder,
        herdEventDispatcher: this.herdEventDispatcher,
        requestCodexAutoRecovery: (session, reason) => this.requestCodexAutoRecovery(session, reason),
        broadcastToBrowsers: (session, message) => this.broadcastToBrowsers(session, message),
        persistSession: (session) => this.persistSession(session),
        setAttentionError: (session) => setAttentionController(session, "error", this.getSessionRegistryDeps()),
        markTurnInterrupted: (session, source) => this.markTurnInterrupted(session, source),
        setGenerating: (session, generating, reason) =>
          setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, generating, reason),
        emitTakodeTurnEnd: (sessionId, data) => this.emitTakodeEvent(sessionId, "turn_end", data),
        buildTurnToolSummary: (session) => this.buildTurnToolSummary(session),
        pokeStaleCodexPendingDelivery: (session, reason) =>
          pokeStaleCodexPendingDeliveryController(session, reason, this.getCodexRecoveryOrchestratorDeps()),
        restartBackend: (session) => this.onSessionRelaunchRequested?.(session.id),
      });
      this.sweepBoardStallWarnings(now);
      this.sweepBoardDispatchableWarnings(now);
      wakeDueSnoozedNotificationsController(this.sessions.values(), now, this.getSessionNotificationDeps());
      wakeDueThreadReminders(this.sessions.values(), now, this.getSessionNotificationDeps());
    }, 30_000);
    if (timer.unref) timer.unref();
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /** Publish the canonical navigation row after its persisted name authority changes. */
  invalidateSessionNavigation(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.syncedProjections.invalidateSessionNavigation(session);
  }

  /** Recompute each subscribed browser's bounded selected conversation after a history mutation. */
  refreshSessionConversation(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.refreshBrowserConversation(session);
  }

  /** Push a message to all connected browsers across ALL sessions. */
  broadcastGlobal(msg: BrowserIncomingMessage): void {
    if (msg.type === "session_archived" || msg.type === "session_deleted") {
      this.invalidateLeaderThreadTabsForSessionQuestState(msg.session_id);
    }
    broadcastGlobalAndScheduleBoardParticipantRefresh(this, msg);
  }

  /** Re-check group-idle state for any leader affected by this session's activity change. */
  private onSessionActivityStateChanged(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.syncedProjections.invalidateSession(session);
    }
    this.herdEventDispatcher?.onSessionActivityStateChanged?.(sessionId, reason);
    notifyCodexWorkerV2RolloutActivity(sessionId, reason);
  }

  // ── Takode orchestration event methods ──────────────────────────────────

  /** Emit a takode event, buffering it and notifying matching subscribers. */
  emitTakodeEvent<E extends TakodeEventType>(
    sessionId: string,
    event: E,
    data: TakodeEventDataByType[E],
    actorSessionId?: string,
  ): void {
    if (event === "turn_end") noteTurnEnded(sessionId, data as TurnEndOutcome);
    if (event === "session_error") noteSessionError(sessionId);
    if (!this.herdEventDispatcher) return;
    if (actorSessionId === undefined) {
      this.herdEventDispatcher.emitTakodeEvent(sessionId, event, data);
      return;
    }
    this.herdEventDispatcher.emitTakodeEvent(sessionId, event, data, actorSessionId);
  }

  emitWorkerStreamCheckpoint(sessionId: string): WorkerStreamCheckpointResult {
    const session = this.sessions.get(sessionId);
    if (!session?.isGenerating) {
      return { ok: true, streamed: false, reason: "not_generating" };
    }
    if (!this.herdEventDispatcher) {
      return { ok: true, streamed: false, reason: "dispatcher_unavailable" };
    }

    const summary = this.buildTurnToolSummary(session);
    const range = summary.msgRange;
    if (!range) {
      return { ok: true, streamed: false, reason: "no_activity" };
    }

    const lastCheckpointTo = this.workerStreamCheckpointMsgTo.get(sessionId) ?? -1;
    if (range.to <= lastCheckpointTo) {
      return { ok: true, streamed: false, reason: "no_activity", msgRange: range };
    }

    this.workerStreamCheckpointMsgTo.set(sessionId, range.to);
    const elapsed = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
    const turnSource = getCurrentTurnTriggerSourceController(session, {
      isSystemSourceTag,
    });
    const activeTurnRoute = session.activeTurnRoute;

    this.emitTakodeEvent(sessionId, "worker_stream", {
      reason: "checkpoint",
      duration_ms: elapsed,
      ...summary,
      turn_source: turnSource,
      ...(activeTurnRoute?.threadKey ? { threadKey: activeTurnRoute.threadKey } : {}),
      ...(activeTurnRoute?.questId ? { questId: activeTurnRoute.questId } : {}),
    });

    return { ok: true, streamed: true, reason: "streamed", msgRange: range };
  }

  /** Queue a recorded report without streaming its surrounding turn or ending Work. */
  emitWorkerReportCheckpoint(
    sessionId: string,
    questId: string,
    report: import("../shared/worker-report.js").WorkerReportReference,
  ): boolean {
    if (!this.herdEventDispatcher || !this.sessions.get(sessionId)?.isGenerating) return false;
    this.emitTakodeEvent(sessionId, "worker_stream", {
      reason: "report",
      duration_ms: 0,
      threadKey: questId,
      questId,
      report,
    });
    return true;
  }

  /** Subscribe to takode events for a set of sessions. Returns an unsubscribe function.
   *  If sinceEventId is provided, immediately replays buffered events with id > sinceEventId. */
  subscribeTakodeEvents(
    sessions: Set<string>,
    callback: (event: TakodeEvent) => void,
    sinceEventId?: number,
  ): () => void {
    return this.herdEventDispatcher?.subscribeTakodeEvents(sessions, callback, sinceEventId) ?? (() => {});
  }

  getBoardStallSignature(sessionId: string, questId: string): string | null {
    return getBoardStallSignatureForSessionController(this.sessions, sessionId, questId, this.getBoardWatchdogDeps());
  }

  getBoardRow(sessionId: string, questId: string): BoardRow | null {
    return this.sessions.get(sessionId)?.board.get(questId) ?? null;
  }

  getBoardDispatchableSignature(sessionId: string, questId: string): string | null {
    return getBoardDispatchableSignatureForSessionController(
      this.sessions,
      sessionId,
      questId,
      this.getBoardWatchdogDeps(),
    );
  }

  /**
   * Kill a session by terminating its backend (subprocess or SDK adapter).
   * Called by the idle manager. Returns true if the session was successfully
   * terminated.
   */
  async killSession(sessionId: string): Promise<boolean> {
    return killSessionController(this.sessions, sessionId, {
      killLauncher: async (targetSessionId: string) =>
        this.launcher ? await this.launcher.kill(targetSessionId) : false,
      endInterruptedTurn: (target) => {
        const session = target as Session;
        this.markTurnInterrupted(session, "system");
        setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, false, "session_stopped");
        this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
        this.persistSession(session);
      },
    });
  }

  /** Restore sessions from disk (call once at startup). */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    return restorePersistedSessionsController(this.sessions, await this.store.loadAll(), {
      recoverToolStartTimesFromHistory: (session) => this.recoverToolStartTimesFromHistory(session as Session),
      finalizeRecoveredDisconnectedTerminalTools: (session, reason) =>
        this.finalizeRecoveredDisconnectedTerminalTools(session as Session, reason),
      scheduleCodexToolResultWatchdogs: (session, reason) =>
        this.scheduleCodexToolResultWatchdogs(session as Session, reason),
      reconcileRestoredBoardState: (session) => reconcileRestoredBoardRows(session as Session, this.resolveQuestStatus),
      setLastUserMessageAt: (sessionId, timestamp) => this.launcher?.setLastUserMessageAt(sessionId, timestamp),
      resumeRecoveryDeliveryTransfers: (session) =>
        resumeRecoveryDeliveryTransfers(session as Session, getRecoveryDeliveryTransferDepsForBridge(this)),
      persistConvertedTokenUsage: (session) => this.persistSession(session as Session),
      persistHistoryMetadataRepair: async (session, expectedFrozenCount) => {
        if (!this.store) return;
        await this.store.rewriteFrozenHistoryMetadata(
          buildPersistedSessionPayloadController(session as Session),
          expectedFrozenCount,
        );
      },
    });
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    this.syncedProjections.invalidateSession(session);
    notifySessionSavedForArtifacts(session.id);
    if (!this.store) return;
    clampFrozenCountController(session);
    this.store.save(buildPersistedSessionPayloadController(session));
  }

  /** Persist a session to disk immediately (bypass debounce). */
  persistSessionSync(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.syncedProjections.invalidateSession(session);
    if (!this.store) return;
    clampFrozenCountController(session);
    this.store.saveSync(buildPersistedSessionPayloadController(session));
  }

  /** Persist a session. Pass the indices of existing history entries edited in place. */
  persistSessionById(sessionId: string, editedHistoryIndices?: readonly number[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!editedHistoryIndices?.length || !this.store) return this.persistSession(session);
    this.syncedProjections.invalidateSession(session);
    clampFrozenCountController(session);
    void this.store.saveHistoryEdits(buildPersistedSessionPayloadController(session), editedHistoryIndices);
  }

  pauseSession(sessionId: string, options?: { pausedBy?: string; reason?: string }) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return pauseSessionForDelivery(session, options, {
      broadcastToBrowsers: (targetSession, message) => this.broadcastToBrowsers(targetSession, message),
      persistSession: (targetSession) => this.persistSession(targetSession),
    });
  }

  async unpauseSession(sessionId: string): Promise<{ queued: number } | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return unpauseSessionForDelivery(session, {
      ...getRecoveryDeliveryTransferDepsForBridge(this),
      onCLIRelaunchNeeded: this.onCLIRelaunchNeeded ?? undefined,
    });
  }

  handleCodexResultErrorAutoPause(
    session: Session,
    msg: CLIResultMessage,
    completedTurn: CodexOutboundTurn | null,
    interrupted = false,
  ): Promise<void> | void {
    return handleCodexResultErrorAutoPauseForBridge(this, session, msg, completedTurn, interrupted);
  }

  private getSessionGitStateDeps() {
    return getSessionGitStateDepsController(this);
  }

  private async refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ): Promise<void> {
    await refreshGitInfoController(session, this.getSessionGitStateDeps(), options);
  }

  /**
   * Force-refresh git metadata and diff totals for worktree sessions even when
   * no agent-side activity marked diffStatsDirty. This covers external git
   * operations like reset/rebase/sync that change the worktree behind Takode's
   * back but should still clear stale +/- badges in session snapshots.
   */
  async refreshWorktreeGitStateForSnapshot(
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): Promise<SessionState | null> {
    return refreshWorktreeGitStateForSnapshotController(sessionId, this.getSessionGitStateDeps(), options);
  }

  /** Refresh git metadata and then recompute dirty diff stats. */
  private refreshGitInfoThenRecomputeDiff(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    void this.refreshGitInfo(session, options).then(() => {
      this.recomputeDiffIfDirty(session);
    });
  }

  /**
   * Recompute diff stats only if agent activity has occurred since the last computation.
   * Broadcasts updated stats to all browsers if recomputed.
   */
  recomputeDiffIfDirty(session: Session): void {
    recomputeDiffIfDirtyController(session, this.getSessionGitStateDeps());
  }

  private getSessionCleanupDeps() {
    return getSessionCleanupDepsController(this);
  }

  /**
   * Diff stats are server-computed from git and must not be overwritten by
   * Codex adapter session updates.
   */
  private sanitizeCodexSessionPatch(patch: Partial<SessionState>): Partial<SessionState> {
    const {
      total_lines_added: _ignoredAdded,
      total_lines_removed: _ignoredRemoved,
      diff_stats_skipped_reason: _ignoredSkippedReason,
      ...rest
    } = patch;
    return rest;
  }

  getSessionNotificationDeps() {
    return getSessionNotificationDepsController(this);
  }

  private getSessionRegistryDeps() {
    return getSessionRegistryDepsController(this);
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    return getOrCreateSessionController(this.sessions, sessionId, backendType, this.getSessionRegistryDeps());
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSyncedProjectionController(): WsBridgeSyncedProjectionController {
    return this.syncedProjections;
  }

  invalidateLeaderThreadTabsForQuestIds(questIds: readonly string[]): number {
    return this.syncedProjections.invalidateLeaderThreadTabsForQuestIds(questIds);
  }

  promoteLeaderThreadTabForQuest(questId: string, eventAt: number, sourceSessionId: string): number {
    return this.syncedProjections.promoteLeaderThreadTabForQuest(questId, eventAt, sourceSessionId);
  }

  promoteLeaderThreadTabForAttachment(sessionId: string, threadKey: string, attachedAt: number): boolean {
    return this.syncedProjections.promoteLeaderThreadTabForAttachment(sessionId, threadKey, attachedAt);
  }

  promoteLeaderThreadTabForTransition(sessionId: string, marker: import("./session-types.js").ThreadTransitionMarker) {
    return this.syncedProjections.promoteLeaderThreadTabForTransition(sessionId, marker);
  }

  promoteLeaderThreadTabForAttention(
    sessionId: string,
    threadKey: string,
    eventAt: number,
    kind: "primary" | "review",
  ): boolean {
    return this.syncedProjections.promoteLeaderThreadTabForAttention(sessionId, threadKey, eventAt, kind);
  }

  promoteLeaderThreadTabForMessageAttention(
    sessionId: string,
    message: Extract<BrowserIncomingMessage, { type: "user_message" }>,
  ): boolean {
    return this.syncedProjections.promoteLeaderThreadTabForMessageAttention(sessionId, message);
  }

  invalidateLeaderThreadTabsForSessionQuestState(sessionId: string): number {
    return this.syncedProjections.invalidateLeaderThreadTabsForSessionQuestState(sessionId);
  }

  touchSessionActivity(sessionId: string): void {
    this.launcher?.touchActivity(sessionId);
    const session = this.sessions.get(sessionId);
    if (
      session &&
      captureSessionNavigationLauncherActivity(session, this.launcher?.getSession(sessionId)?.lastActivityAt)
    ) {
      this.syncedProjections.invalidateSessionNavigation(session);
    }
  }

  invalidateAllSessionProjections(): void {
    this.syncedProjections.invalidateAllSessions();
  }

  syncSideChatRecord(rootSessionId: string, threadId: string): boolean {
    return syncSideChatRecordController(this.sideChatBridgeDeps, rootSessionId, threadId);
  }

  /** @deprecated Use syncSideChatRecord. Kept for older internal callers during the Side Chat rename. */
  syncSlackThreadRecord(rootSessionId: string, threadId: string): boolean {
    return this.syncSideChatRecord(rootSessionId, threadId);
  }

  syncSideChatRecordForChild(childSession: Session): boolean {
    return syncSideChatRecordForChildController(this.sideChatBridgeDeps, childSession);
  }

  /** @deprecated Use syncSideChatRecordForChild. Kept for older internal callers during the Side Chat rename. */
  syncSlackThreadRecordForChild(childSession: Session): boolean {
    return this.syncSideChatRecordForChild(childSession);
  }

  async routeSideChatUserMessage(
    rootSessionId: string,
    threadId: string,
    content: string,
    options?: { clientMsgId?: string },
  ): Promise<{ ok: true; childSessionId: string } | { ok: false; error: string }> {
    return routeSideChatUserMessageController(this.sideChatBridgeDeps, rootSessionId, threadId, content, options);
  }

  /** @deprecated Use routeSideChatUserMessage. Kept for older internal callers during the Side Chat rename. */
  async routeSlackThreadUserMessage(
    rootSessionId: string,
    threadId: string,
    content: string,
    options?: { clientMsgId?: string },
  ): Promise<{ ok: true; childSessionId: string } | { ok: false; error: string }> {
    return this.routeSideChatUserMessage(rootSessionId, threadId, content, options);
  }

  async setSessionPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    return setSessionPermissionModeController(this.sessions, this.getBrowserRoutingDeps(), sessionId, mode);
  }

  async setSessionModel(sessionId: string, model: string): Promise<boolean> {
    return setSessionModelController(this.sessions, this.getBrowserRoutingDeps(), sessionId, model);
  }

  async setCodexServiceTier(sessionId: string, serviceTier: string | null): Promise<boolean> {
    return setCodexServiceTierController(this.sessions, this.getBrowserRoutingDeps(), sessionId, serviceTier);
  }

  async setClaudeReasoningEffort(sessionId: string, effort: string | null): Promise<boolean> {
    return setClaudeReasoningEffortController(this.sessions, this.getBrowserRoutingDeps(), sessionId, effort);
  }

  async interruptSession(
    sessionId: string,
    source: InterruptSource = "user",
    options?: { interruptOrigin?: "restart_prep"; restartPrepOperationId?: string },
  ): Promise<boolean> {
    return interruptSessionController(this.sessions, this.getBrowserRoutingDeps(), sessionId, source, options);
  }

  async recoverCodexRestartPrepBlocker(
    sessionId: string,
    options?: { restartPrepOperationId?: string | null },
  ): Promise<RestartPrepCodexFallbackOutcome> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, action: "skipped", detail: "Session was no longer loaded." };
    }
    if (session.backendType !== "codex") {
      return { ok: false, action: "skipped", detail: "Fallback is only available for Codex sessions." };
    }
    if (!session.isGenerating) {
      return { ok: false, action: "skipped", detail: "Session is no longer running." };
    }

    const now = Date.now();
    const pendingTurn = getCodexTurnInRecoveryState(session);
    const adapter = session.codexAdapter;
    const diagnostics = this.getCodexRestartPrepFallbackDiagnostics(session);
    session.restartPrepInterruptOrigin = "restart_prep";
    session.restartPrepInterruptOperationId = options?.restartPrepOperationId ?? null;
    this.markTurnInterrupted(session, "user");
    if (pendingTurn) {
      pendingTurn.disconnectedAt = pendingTurn.disconnectedAt ?? now;
      pendingTurn.resumeConfirmedAt = null;
      pendingTurn.updatedAt = now;
      pendingTurn.lastError = "Restart prep moved this Codex turn into recovery after bounded interrupt attempts.";
    }
    this.clearCodexDisconnectGraceTimer(session, "restart_prep_fallback");
    setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, false, "restart_prep_codex_fallback");
    session.toolStartTimes.clear();

    const recoveryRequested = this.requestCodexAutoRecovery(
      session,
      `restart_prep:${options?.restartPrepOperationId ?? "unknown"}`,
    );
    if (!recoveryRequested) {
      if (adapter) {
        try {
          await adapter.disconnect();
        } catch (error) {
          this.persistSession(session);
          return {
            ok: false,
            action: "failed",
            detail: error instanceof Error ? error.message : String(error),
            diagnostics,
          };
        }
        if (session.codexAdapter === adapter) session.codexAdapter = null;
      }
      this.setBackendState(session, "disconnected", null);
      this.broadcastToBrowsers(session, { type: "backend_disconnected" });
    }

    this.recorder?.recordServerEvent(
      session.id,
      "restart_prep_codex_fallback",
      {
        operationId: options?.restartPrepOperationId ?? null,
        recoveryRequested,
        diagnostics,
      },
      "codex",
      session.state.cwd,
    );
    this.persistSession(session);
    return {
      ok: true,
      action: recoveryRequested ? "codex_recovery_requested" : "codex_disconnected",
      detail: recoveryRequested
        ? "Codex recovery was requested after bounded restart-prep interrupts did not clear the running blocker."
        : "Codex backend was disconnected after bounded restart-prep interrupts did not clear the running blocker.",
      diagnostics,
    };
  }

  prepareSessionForRevert(
    sessionId: string,
    truncateIdx: number,
    options?: { clearCodexState?: boolean },
  ): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return prepareSessionForRevertController(
      session,
      truncateIdx,
      {
        ...this.getSessionRegistryDeps(),
        setLastUserMessageAt: (targetSessionId, timestamp) =>
          this.launcher?.setLastUserMessageAt(targetSessionId, timestamp),
      },
      options,
    );
  }

  private finalizeCodexRollback(session: Session): void {
    const plan = session.pendingCodexRollback;
    if (!plan) return;
    const revertedSession = this.prepareSessionForRevert(session.id, plan.truncateIdx, {
      clearCodexState: plan.clearCodexState,
    });
    finalizeCodexRollbackController(session, this.getSessionRegistryDeps(), revertedSession);
  }

  beginCodexRollback(
    sessionId: string,
    plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean },
  ): { promise: Promise<void>; requiresRelaunch: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        promise: Promise.reject(new Error("Session not found")),
        requiresRelaunch: false,
      };
    }
    return beginCodexRollbackController(session, plan, this.getSessionRegistryDeps(), () => {
      this.finalizeCodexRollback(session);
    });
  }

  private hasAssistantReplay(session: Session, messageId: string): boolean {
    return hasAssistantReplayController(session, messageId);
  }

  private hasUserPromptReplay(session: Session, cliUuid: string): boolean {
    return hasUserPromptReplayController(session, cliUuid);
  }

  private hasResultReplay(session: Session, resultUuid: string): boolean {
    return hasResultReplayController(session, resultUuid);
  }

  private hasToolResultPreviewReplay(session: Session, toolUseId: string): boolean {
    return hasToolResultPreviewReplayController(session, toolUseId);
  }

  private hasTaskNotificationReplay(session: Session, taskId: string, toolUseId: string): boolean {
    return hasTaskNotificationReplayController(session, taskId, toolUseId);
  }

  private hasCompactBoundaryReplay(
    session: Session,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ): boolean {
    return hasCompactBoundaryReplayController(session, cliUuid, meta);
  }

  private isDuplicateCodexAssistantReplay(
    session: Session,
    msg: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  ): boolean {
    return isDuplicateCodexAssistantReplayController(session, msg);
  }

  private isHerdedWorkerSession(session: Session): boolean {
    return !!this.launcher?.getSession(session.id)?.herdedBy;
  }

  private formatVsCodeSelectionPrompt(selection: import("./session-types.js").VsCodeSelectionMetadata): string {
    return formatVsCodeSelectionPrompt(selection);
  }

  private getCompactionRecoveryRuntimeDeps() {
    return getCompactionRecoveryRuntimeDepsController(this);
  }

  private getCommonClaudeRuntimeDeps() {
    return getCommonClaudeRuntimeDepsController(this);
  }

  private getCommonCodexRuntimeDeps() {
    return getCommonCodexRuntimeDepsController(this);
  }

  private getClaudeMessageHandlers() {
    return getClaudeMessageHandlersController(this);
  }

  // ─── Work Board ──────────────────────────────────────────────────────────

  /** Remove a quest from ALL session boards (e.g. on quest deletion or cancellation).
   *  True deletion -- removes from both active board and completed history. */
  removeBoardRowFromAll(questId: string): void {
    removeBoardRowFromAllSessionsController(this.sessions, questId, {
      broadcastBoard: (targetSession, board, completedBoard) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "board_updated",
          board,
          completedBoard,
          rowSessionStatuses: this.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
        }),
      persistSession: (targetSession) => this.persistSession(targetSession as Session),
      invalidateLeaderThreadTabsForQuestIds: (questIds) => this.invalidateLeaderThreadTabsForQuestIds(questIds),
      markNotificationDone: (sessionId, notifId, done) =>
        markNotificationDoneBySessionIdController(this.sessions, sessionId, notifId, done, {
          broadcastToBrowsers: (targetSession, msg) => this.broadcastToBrowsers(targetSession as Session, msg),
          broadcastBoard: (targetSession, board, completedBoard) =>
            this.broadcastToBrowsers(targetSession as Session, {
              type: "board_updated",
              board,
              completedBoard,
              rowSessionStatuses: this.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
            }),
          persistSession: (targetSession) => this.persistSession(targetSession as Session),
        }),
    });
  }

  completeQueuedBoardRowsForQuest(questId: string): string[] {
    return this.completeBoardRowsForQuest(questId, completeQueuedBoardRowsForQuestInAllSessionsController);
  }

  completeDoneBoardRowsForQuest(questId: string, options: { cancelled?: boolean } = {}): string[] {
    return this.completeBoardRowsForQuest(questId, (sessions, id, deps) =>
      completeDoneBoardRowsForQuestInAllSessionsController(sessions, id, deps, options),
    );
  }

  private completeBoardRowsForQuest(
    questId: string,
    completeRows: typeof completeQueuedBoardRowsForQuestInAllSessionsController,
  ): string[] {
    return completeRows(this.sessions, questId, getQuestBoardCompletionDepsController(this));
  }

  private sweepBoardStallWarnings(now: number): void {
    sweepBoardStallWarningsController(this.sessions.values(), now, this.getBoardWatchdogDeps());
  }

  private sweepBoardDispatchableWarnings(now: number): void {
    sweepBoardDispatchableWarningsController(this.sessions.values(), now, this.getBoardWatchdogDeps());
  }

  /** Downgrade "action" attention to null when all pending permissions are resolved. */
  private clearActionAttentionIfNoPermissions(session: Session): void {
    clearActionAttentionIfNoPermissionsController(session, this.getSessionNotificationDeps());
  }

  private injectLongSleepReminder(session: Session): void {
    this.injectUserMessage(session.id, LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  }

  private handleObservedLongSleepBashToolUse(
    session: Session,
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
  ): void {
    // In bypass mode Claude runs Bash without asking, so the permission
    // pipeline's long-sleep denial never sees the call; catch it on observation.
    if (session.backendType !== "claude-sdk" || toolUse.name !== "Bash") return;
    if (session.state.permissionMode !== "bypassPermissions") return;
    const command = typeof toolUse.input?.command === "string" ? toolUse.input.command : "";
    if (!detectLongSleepBashCommand(command)) return;

    const denialId = `sleep-guard-${toolUse.id || randomUUID()}`;
    const alreadyDenied = session.messageHistory.some(
      (entry) =>
        entry.type === "permission_denied" &&
        ((entry as { id?: string }).id === denialId || (!!toolUse.id && entry.tool_use_id === toolUse.id)),
    );
    if (alreadyDenied) return;

    this.onSessionActivityStateChanged(session.id, "long_sleep_tool_use_denied");
    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: denialId,
      tool_name: "Bash",
      tool_use_id: toolUse.id || "",
      summary: getDenialSummary("Bash", { command }),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    this.broadcastToBrowsers(session, deniedMsg);
    this.emitTakodeEvent(session.id, "permission_resolved", { tool_name: "Bash", outcome: "denied" });
    handleInterruptController(session, "system", this.getBrowserRoutingDeps());
    this.injectLongSleepReminder(session);
    this.persistSession(session);
  }

  private syncBackendTypeFromLauncher(session: Session, reason: string): void {
    const launcherBackendType = this.launcher?.getSession(session.id)?.backendType;
    if (!launcherBackendType || launcherBackendType === session.backendType) return;
    if (backendAttachedController(session)) return;

    console.log(
      `[ws-bridge] Syncing session ${sessionTag(session.id)} backend ${session.backendType} -> ${launcherBackendType} (${reason})`,
    );
    session.backendType = launcherBackendType;
    session.state.backend_type = launcherBackendType;
    this.persistSession(session);
  }

  private setBackendState(
    session: Session,
    backendState: NonNullable<SessionState["backend_state"]>,
    backendError: string | null = null,
  ): void {
    setBackendStateController(session, backendState, backendError, this.getSessionRegistryDeps());
  }

  private clearCodexDisconnectGraceTimer(session: Session, reason: string): void {
    if (!session.codexDisconnectGraceTimer) return;
    clearTimeout(session.codexDisconnectGraceTimer);
    session.codexDisconnectGraceTimer = null;
    console.log(`[ws-bridge] Cleared Codex disconnect grace timer for session ${sessionTag(session.id)} (${reason})`);
  }

  private finalizeCodexRecoveringTurn(session: Session, reason: "recovery_timeout" | "recovery_failed"): void {
    this.clearCodexDisconnectGraceTimer(session, `codex_${reason}`);
    if (session.codexAdapter) return;
    if (!getCodexTurnInRecoveryState(session) && !session.state.codex_turn_recovery) return;
    retireCodexAutoPauseRecoveryTesting(session, {
      broadcastToBrowsers: (targetSession, message) => this.broadcastToBrowsers(targetSession, message),
      persistSession: (targetSession) => this.persistSession(targetSession),
    });
    markCodexTurnRecoveryActionRequired(session, reason, {
      broadcastToBrowsers: (targetSession, message) => this.broadcastToBrowsers(targetSession as Session, message),
      persistSession: (targetSession) => this.persistSession(targetSession as Session),
      setAttentionError: (targetSession) =>
        setAttentionController(targetSession as Session, "error", this.getSessionRegistryDeps()),
    });
    if (!session.isGenerating) {
      this.persistSession(session);
      return;
    }
    this.markTurnInterrupted(session, "system");
    setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, false, "codex_disconnect");
    this.broadcastToBrowsers(session, {
      type: "status_change",
      status: "idle",
      codexAutoPauseRecoveryProgress: null,
    });
    this.persistSession(session);
    console.log(
      `[ws-bridge] Finalized deferred Codex disconnect interruption for session ${sessionTag(session.id)} ` +
        `after ${reason}`,
    );
  }

  markCodexAutoRecoveryFailed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    markCodexAutoRecoveryFailedController(session, this.getSessionRegistryDeps());
  }

  clearCodexAutomaticRecoverySuppression(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearCodexAutomaticRecoverySuppressionController(session, this.getSessionRegistryDeps());
  }

  isBackendConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return backendConnectedController(session);
  }

  isSessionPaused(sessionId: string): boolean {
    return isSessionPaused(this.sessions.get(sessionId));
  }

  getBoardRowSessionStatuses(sessionId: string, board: BoardRow[], completedBoard: BoardRow[]) {
    if (board.length === 0 && completedBoard.length === 0) return {};
    const launcherSessions = this.launcher?.listSessions?.() ?? [];
    return buildBoardRowSessionStatuses(
      [...board, ...completedBoard],
      launcherSessions.map((session) => {
        const bridgeSession = this.sessions.get(session.sessionId);
        const cliConnected = this.isBackendConnected(session.sessionId);
        return {
          sessionId: session.sessionId,
          sessionNum: session.sessionNum,
          reviewerOf: session.reviewerOf,
          archived: session.archived,
          state: cliConnected && bridgeSession?.isGenerating ? "running" : session.state,
          cliConnected,
          name: this.sessionNameGetter?.(session.sessionId),
          activeTurnRoute:
            cliConnected && bridgeSession?.isGenerating
              ? deriveActiveTurnRouteBrowserTransportController(bridgeSession)
              : null,
          ...codexReasoningSnapshotFields(bridgeSession),
          generationStartedAt:
            cliConnected && bridgeSession?.isGenerating ? (bridgeSession.generationStartedAt ?? null) : null,
        };
      }),
    );
  }

  scheduleBoardParticipantRefresh(sessionId: string): void {
    scheduleBoardParticipantRefreshForSession(this, sessionId);
  }

  /** Is any transport attached (even if still initializing)? */
  isBackendAttached(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return backendAttachedController(session);
  }

  removeSession(sessionId: string) {
    removeSessionController(this.sessions, sessionId, this.getSessionCleanupDeps());
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    closeSessionController(this.sessions, sessionId, this.getSessionCleanupDeps());
  }

  // ── Codex adapter attachment ────────────────────────────────────────────

  /**
   * Attach a CodexAdapter to a session. The adapter handles all message
   * translation between the Codex app-server (stdio JSON-RPC) and the
   * browser WebSocket protocol.
   */
  attachCodexAdapter(sessionId: string, adapter: CodexBridgeAdapter): void {
    const session = this.getOrCreateSession(sessionId, "codex");
    attachCodexAdapterLifecycleController(sessionId, session, adapter, getCodexAttachLifecycleDepsController(this));
  }

  private flushQueuedMessagesToCodexAdapter(session: Session, adapter: CodexBridgeAdapter, reason: string): void {
    flushQueuedMessagesToCodexAdapterController(session, adapter, reason, {
      dispatchQueuedCodexTurns: (targetSession, dispatchReason) =>
        dispatchQueuedCodexTurnsController(
          targetSession as Session,
          dispatchReason,
          this.getCodexRecoveryOrchestratorDeps(),
        ),
    });
  }

  /** Attach a Claude SDK adapter (stdio transport) for a session.
   *  Mirrors attachCodexAdapter but simpler — SDK messages already match our protocol. */
  attachClaudeSdkAdapter(sessionId: string, adapter: ClaudeSdkBridgeAdapter): void {
    attachClaudeSdkAdapterLifecycle(sessionId, adapter, this.getClaudeSdkAdapterLifecycleDeps());
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    this.syncBackendTypeFromLauncher(session, "browser_open");
    handleBrowserOpenController(session, ws, this.getBrowserTransportDeps());
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    return this.browserSocketSwitches.handle(ws, data, {
      switchTo: (sessionId) => this.switchBrowserSession(ws, sessionId),
      handle: () => this.handleBoundBrowserMessage(ws, data),
    });
  }

  /** Set where browsers' scroll-position handoff state is read, for pushing it over their sockets. */
  setViewportHandoffReader(reader: (sessionId: string) => Promise<ViewportHandoffSessionState | null>): void {
    this.viewportHandoffReader = reader;
  }

  /** Send a session's handoff state to one subscribed socket, if it still shows that session. */
  sendViewportHandoffState(sessionId: string, ws: unknown): void {
    const read = this.viewportHandoffReader;
    if (!read) return;
    const socket = ws as ServerWebSocket<SocketData>;
    // Named in the subscribe, which forgets its held parts once its snapshot is out; read it before waiting.
    const held = (socket.data as { knownSnapshotParts?: KnownSnapshotParts }).knownSnapshotParts?.viewport_handoff;
    void read(sessionId)
      .then((state) => {
        if (!state || (socket.data as BrowserSocketData).sessionId !== sessionId) return;
        sendToBrowser(socket, viewportHandoffStateMessage(state, held));
      })
      .catch((error) => console.warn(`[viewport-handoff] Failed to read state for ${sessionTag(sessionId)}:`, error));
  }

  /** Push an accepted handoff change to every browser subscribed to the session, so none needs to read it. */
  pushViewportHandoffState(sessionId: string, state: ViewportHandoffSessionState): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const message = viewportHandoffStateMessage(state);
    for (const ws of session.browserSockets) {
      if ((ws.data as BrowserSocketData).subscribed) sendToBrowser(ws, message);
    }
  }

  /** Move an open browser socket to another session (or none), as a close and a fresh open would. */
  private switchBrowserSession(ws: ServerWebSocket<SocketData>, sessionId: string | null): void {
    this.handleBrowserClose(ws, 1000, "session switch");
    const data = ws.data as BrowserSocketData & Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (key !== "kind" && key !== "browserClientPlatform") delete data[key];
    }
    // An empty id matches no session, so a detached socket's messages are ignored until it switches again.
    data.sessionId = sessionId ?? "";
    if (sessionId) this.handleBrowserOpen(ws, sessionId);
  }

  private async handleBoundBrowserMessage(ws: ServerWebSocket<SocketData>, data: string) {
    const perfStart = this.perfTracer ? performance.now() : 0;
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.syncBackendTypeFromLauncher(session, "browser_message");
    const { messageType, completion } = handleBrowserMessageTransportController(
      session,
      data,
      ws,
      this.getBrowserTransportDeps(),
    );
    if (completion) {
      await completion;
    }

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        this.perfTracer.recordSlowWsMessage(sessionId, "browser", messageType, perfMs);
      }
    }
  }

  private enqueueCodexQuestLifecycle(session: Session, task: () => Promise<void>): Promise<void> {
    const prior = this.codexQuestLifecycleChains.get(session.id);
    const next = (prior ?? Promise.resolve()).catch(() => {}).then(() => task());
    const tracked = next.finally(() => {
      if (this.codexQuestLifecycleChains.get(session.id) === tracked) {
        this.codexQuestLifecycleChains.delete(session.id);
      }
    });
    this.codexQuestLifecycleChains.set(session.id, tracked);
    return tracked;
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and takode CLI to send prompts.
   *  Returns delivery status so callers can distinguish live delivery from queuing. */
  injectUserMessage(
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
    takodeHerdBatch?: TakodeHerdBatchSnapshot,
    threadRoute?: { threadKey: string; questId?: string; threadRefs?: ThreadRef[] },
    options?: ProgrammaticUserMessageOptions,
  ): "sent" | "queued" | "paused_queued" | "dropped" | "no_session" {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      options?.afterRejected?.("route_rejected");
      return "no_session";
    }
    return deliverProgrammaticUserMessage(session, content, agentSource, takodeHerdBatch, threadRoute, options, {
      broadcastToBrowsers: (targetSession, message) => this.broadcastToBrowsers(targetSession, message),
      persistSession: (targetSession) => this.persistSession(targetSession),
      getBrowserTransportDeps: () => this.getBrowserTransportDeps(),
      pruneStaleBoardStalledHerdBatch: (targetSession, batch) =>
        this.pruneStaleBoardStalledHerdBatch(targetSession, batch),
      syncBackendTypeFromLauncher: (targetSession, reason) => this.syncBackendTypeFromLauncher(targetSession, reason),
    });
  }

  private isLiveBoardStalledEvent(session: Session, event: TakodeEvent): boolean {
    if (event.event !== "board_stalled") return true;
    const row = session.board.get(event.data.questId);
    if (!row) return false;
    if (event.data.stage && row.status !== event.data.stage) return false;
    if (!event.data.signature) return true;
    return getBoardStallSignatureController(session, row.questId, this.getBoardWatchdogDeps()) === event.data.signature;
  }

  private pruneStaleBoardStalledHerdBatch(
    session: Session,
    batch: TakodeHerdBatchSnapshot | undefined,
  ): { batch?: TakodeHerdBatchSnapshot; content?: string; changed: boolean } {
    return pruneStaleBoardStalledHerdBatchController(session, batch, this.getBoardWatchdogDeps());
  }

  private pruneStalePendingCodexHerdInputs(session: Session, reason: string): boolean {
    return pruneStalePendingCodexHerdInputsForBridge(this, session, reason);
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.syncedProjections.removeSubscriber(ws);
      return;
    }
    handleBrowserCloseController(session, ws, this.getBrowserTransportDeps(), code, reason);
  }

  private collectCompletedToolStartTimes(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): number[] {
    return collectCompletedToolStartTimesController(session, toolResults);
  }

  private getToolResultRecoveryDeps() {
    return getToolResultRecoveryDepsController(this);
  }

  private getToolResultPreviewLimit(session: Session, toolUseId: string): number {
    return getToolResultPreviewLimitController(session, toolUseId, this.getToolResultRecoveryDeps());
  }

  private pruneToolResultsForCurrentHistory(session: Session): void {
    pruneToolResultsForCurrentHistoryController(session);
  }

  private recoverToolStartTimesFromHistory(session: Session): void {
    recoverToolStartTimesFromHistoryController(session);
  }

  private finalizeRecoveredDisconnectedTerminalTools(session: Session, reason: string): void {
    finalizeRecoveredDisconnectedTerminalToolsController(session, reason, this.getToolResultRecoveryDeps());
  }

  private finalizeOrphanedTerminalToolsOnResult(session: Session, msg: CLIResultMessage): void {
    finalizeOrphanedTerminalToolsOnResultController(session, msg, this.getToolResultRecoveryDeps());
  }

  private scheduleCodexToolResultWatchdogs(session: Session, reason: string): void {
    scheduleCodexToolResultWatchdogsController(session, reason, this.getToolResultRecoveryDeps());
  }

  private shouldDeferCodexToolResultWatchdog(session: Session, toolUseId: string): boolean {
    return shouldDeferCodexToolResultWatchdogController(session, toolUseId, this.getToolResultRecoveryDeps());
  }

  private synthesizeCodexToolResultsFromResumedTurn(
    session: Session,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ): CodexToolResultSynthesisSummary {
    return synthesizeCodexToolResultsFromResumedTurnController(
      session,
      turn,
      pending,
      this.getToolResultRecoveryDeps(),
    );
  }

  private buildToolResultPreviews(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): ToolResultPreview[] {
    return buildToolResultPreviewsController(session, toolResults, this.getToolResultRecoveryDeps());
  }

  getToolResult(
    sessionId: string,
    toolUseId: string,
  ): {
    content: string;
    is_error: boolean;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return getIndexedToolResult(session, toolUseId);
  }

  private static isImageNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const withCode = err as { code?: unknown; message?: unknown };
    if (withCode.code === "ENOENT") return true;
    const msg = typeof withCode.message === "string" ? withCode.message.toLowerCase() : "";
    return msg.includes("enoent") || msg.includes("no such file") || msg.includes("not found");
  }

  private notifyImageSendFailure(session: Session, err?: unknown): void {
    const detail = WsBridge.isImageNotFoundError(err)
      ? "image couldn't be found on server"
      : "the server couldn't store the image";
    if (err) {
      console.warn(`[ws-bridge] Image send failed for session ${sessionTag(session.id)}:`, err);
    } else {
      console.warn(`[ws-bridge] Image send failed for session ${sessionTag(session.id)}: ${detail}`);
    }
    this.broadcastToBrowsers(session, {
      type: "error",
      message: `Image failed to send: ${detail}. Please reattach and retry.`,
    });
  }

  private setCodexImageSendStage(
    session: Session,
    stage: SessionState["codex_image_send_stage"],
    options?: { persist?: boolean },
  ): void {
    if (session.backendType !== "codex") return;
    if ((session.state.codex_image_send_stage ?? null) === (stage ?? null)) return;
    session.state.codex_image_send_stage = stage ?? null;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { codex_image_send_stage: session.state.codex_image_send_stage ?? null },
    });
    if (options?.persist !== false) {
      this.persistSession(session);
    }
  }

  private requestCodexAutoRecovery(session: Session, reason: string): boolean {
    return requestCodexAutoRecoveryOrchestratorController(session, reason, this.getSessionRegistryDeps());
  }

  private getCodexRestartPrepFallbackDiagnostics(session: Session): Record<string, string | number | boolean | null> {
    const adapter = session.codexAdapter as
      | (Session["codexAdapter"] & {
          getLastDisconnectDiagnostics?: () => { closeId?: unknown } | null;
        })
      | null;
    const lastDisconnect = adapter?.getLastDisconnectDiagnostics?.() ?? null;
    return {
      backendState: session.state.backend_state ?? null,
      adapterConnected: adapter?.isConnected?.() ?? false,
      currentTurnId: adapter?.getCurrentTurnId?.() ?? null,
      pendingCodexTurns: session.pendingCodexTurns.length,
      pendingCodexInputs: session.pendingCodexInputs.length,
      pendingPermissions: session.pendingPermissions.size,
      closeId: typeof lastDisconnect?.closeId === "string" ? lastDisconnect.closeId : null,
    };
  }

  private getBrowserTransportDeps() {
    return getBrowserTransportDepsController(this);
  }

  private getClaudeSdkAdapterLifecycleDeps() {
    return getClaudeSdkAdapterLifecycleDepsController(this);
  }

  private getCodexAdapterBrowserMessageDeps() {
    return getCodexAdapterBrowserMessageDepsController(this);
  }

  private getWorkBoardStateDeps() {
    return getWorkBoardStateDepsController(this);
  }

  private getBoardWatchdogDeps() {
    return getBoardWatchdogDepsController(this);
  }

  private getBrowserRoutingDeps() {
    return getBrowserRoutingDepsController(this);
  }

  private getCodexRecoveryOrchestratorDeps() {
    return getCodexRecoveryOrchestratorDepsController(this);
  }

  private hasPendingForceCompact(session: Session): boolean {
    return hasPendingForceCompactController(session);
  }

  async recycleCodexLeaderSession(
    sessionId: string,
    trigger: CodexLeaderRecycleTrigger,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (isSessionPaused(session)) return { ok: false, error: "Session is paused; unpause before recycling" };
    if (session.backendType !== "codex") return { ok: false, error: "Session is not a Codex session" };
    const launcherInfo = this.launcher?.getSession(sessionId);
    if (!launcherInfo) return { ok: false, error: "Session not found" };
    if (!launcherInfo.isOrchestrator) return { ok: false, error: "Recycle is only supported for Codex leaders" };
    if (launcherInfo.codexLeaderRecyclePending) return { ok: true };
    if (!this.launcher) return { ok: false, error: "Launcher unavailable" };

    const tokenUsage = buildCodexLeaderRecycleTokenUsage(session);
    const prepared = this.launcher.prepareCodexLeaderRecycle(sessionId, { trigger, tokenUsage });
    if (!prepared.ok) {
      return { ok: false, error: prepared.error || "Failed to prepare Codex leader recycle" };
    }

    prepareCodexLeaderRecycleSession(session, trigger, CODEX_INTENTIONAL_RELAUNCH_GUARD_MS, {
      clearAllCodexToolResultWatchdogs: clearAllCodexToolResultWatchdogsController,
      broadcastToBrowsers: (targetSession, message) => this.broadcastToBrowsers(targetSession, message),
      markCodexIntentionalRelaunch: markCodexIntentionalRelaunchController,
      persistSession: (targetSession) => this.persistSession(targetSession),
      replaceQueuedTurnLifecycleEntries: (targetSession) =>
        replaceQueuedTurnLifecycleEntriesLifecycle(targetSession, []),
      setGenerating: (targetSession, generating, reason) =>
        setGeneratingLifecycle(this.getGenerationLifecycleDeps(), targetSession, generating, reason),
    });
    const relaunch = await this.launcher.relaunch(sessionId);
    if (!relaunch.ok) {
      this.launcher.completeCodexLeaderRecycle(sessionId);
      clearCodexIntentionalRelaunchController(session);
      session.relaunchPending = false;
      failCodexLeaderRecycleRecovery(session, this.getCodexRecoveryOrchestratorDeps());
      this.persistSession(session);
      return { ok: false, error: relaunch.error || "Failed to relaunch Codex leader session" };
    }
    return { ok: true };
  }

  queueForceCompactForRelaunch(sessionId: string): { ok: true } | { ok: false; error: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (isSessionPaused(session)) return { ok: false, error: "Session is paused; unpause before compacting" };
    if (session.backendType === "codex") return { ok: false, error: "Force compact not supported for Codex" };
    queueForceCompactPendingMessageController(session, this.getBrowserRoutingDeps());
    return { ok: true };
  }

  private markTurnInterrupted(session: Session, source: InterruptSource): void {
    markTurnInterruptedLifecycle(session, source);
  }

  private trackCodexQuestCommands(session: Session, content: ContentBlock[]): void {
    trackCodexQuestCommandsController(session, content);
  }

  private async reconcileCodexQuestToolResult(
    session: Session,
    toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  ): Promise<void> {
    await this.enqueueCodexQuestLifecycle(session, async () => {
      const deps = this.getSessionRegistryDeps();
      await reconcileCodexQuestToolResultController(session, toolResult, {
        ...deps,
        resolveQuestTitle: this.resolveQuestTitle
          ? async (questId: string) => (await this.resolveQuestTitle?.(questId)) ?? undefined
          : undefined,
      });
    });
  }

  private recomputeAndBroadcastHistoryBytes(session: Session): void {
    const replayHistoryBytes = computeReplayHistoryBytes(session.messageHistory);
    const codexRetainedPayloadBytes =
      session.backendType === "codex"
        ? computeCodexRetainedPayloadBytes(session.messageHistory, session.toolResults)
        : 0;
    const prevReplayBytes = session.state.message_history_bytes ?? 0;
    const prevRetainedBytes = session.state.codex_retained_payload_bytes ?? 0;

    session.state.message_history_bytes = replayHistoryBytes;
    if (session.backendType === "codex") {
      session.state.codex_retained_payload_bytes = codexRetainedPayloadBytes;
    }

    const sessionUpdate: Partial<SessionState> = {};
    if (prevReplayBytes === 0 ? replayHistoryBytes > 0 : Math.abs(replayHistoryBytes - prevReplayBytes) >= 1024) {
      sessionUpdate.message_history_bytes = replayHistoryBytes;
    }
    if (
      session.backendType === "codex" &&
      (prevRetainedBytes === 0
        ? codexRetainedPayloadBytes > 0
        : Math.abs(codexRetainedPayloadBytes - prevRetainedBytes) >= 1024)
    ) {
      sessionUpdate.codex_retained_payload_bytes = codexRetainedPayloadBytes;
    }

    if (Object.keys(sessionUpdate).length === 0) return;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: sessionUpdate,
    });
  }

  private getGenerationLifecycleDeps() {
    return getGenerationLifecycleDepsController(this);
  }

  private buildTurnToolSummary(session: Session) {
    return buildTurnToolSummaryController(session);
  }

  private isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
    return isHistoryBackedEventController(msg);
  }

  private broadcastToBrowsers(
    session: Session,
    msg: BrowserIncomingMessage,
    options?: { skipBuffer?: boolean; skipGlobalActivity?: boolean },
  ) {
    if (msg.type === "attention_alert") {
      // Every browser decides for itself whether the alert's tab is the one it shows. An alert
      // is never replayed, so it is sent unsequenced and leaves every session's event numbering alone.
      for (const target of this.sessions.values()) {
        for (const socket of target.browserSockets) sendToBrowser(socket, msg);
      }
      return;
    }
    this.captureSessionNavigationSourceMessage(session, msg);
    if (!options?.skipGlobalActivity) maybeBroadcastGlobalSessionActivityUpdate(this, session, msg);
    broadcastToBrowsersController(session, msg, this.getBrowserTransportDeps(), options);
  }

  private refreshBrowserConversation(session: Session): void {
    refreshBrowserConversationViewsController(session);
  }

  private captureSessionNavigationSourceMessage(session: Session, msg: BrowserIncomingMessage): void {
    if (captureSessionNavigationSourceMessage(session, msg))
      this.syncedProjections.invalidateSessionNavigation(session);
  }
}
