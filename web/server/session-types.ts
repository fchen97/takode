import type { BackendType } from "./backend-type.js";
import type { TakodeHerdBatchSnapshot, TakodeHerdEventBrowserMetadata } from "./takode-event-types.js";
import type { ConversationAnnotation, AnnotationMessage } from "../shared/conversation-annotations.js";
import type { ReplyContext } from "../shared/reply-context.js";
import type { BackendSessionState } from "./backend-session-state.js";
import type { ThreadRoutingError } from "../shared/thread-routing-error.js";
export type { ThreadRoutingError } from "../shared/thread-routing-error.js";
export type { LeaderThreadTextRole } from "../shared/thread-routing.js";
import type { McpServerConfig, McpServerDetail } from "./mcp-types.js";
export type { McpServerConfig, McpServerDetail } from "./mcp-types.js";
import type { CodexMessagePhase } from "../shared/codex-message-phase.js";
import type {
  CodexPendingBatchInput,
  CodexPendingInputFailureReason,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  ProgrammaticHistoryFollowUp,
} from "./codex-pending-input-types.js";
export type {
  CodexPendingBatchInput,
  CodexPendingInputFailureReason,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  ProgrammaticHistoryFollowUp,
} from "./codex-pending-input-types.js";
import type { LeaderOpenThreadTabsState, LeaderThreadTabUpdate } from "../shared/leader-open-thread-tabs.js";
import type { LeaderActivePhaseSummarySegment } from "../shared/leader-active-phase-summary.js";
import type { LeaderThreadStatus } from "../shared/thread-status-marker.js";
import type { ModelProvenanceMigration } from "./model-identity-contract.js";
import type { CodexAutoPauseRecoveryLink, CodexAutoPauseRecoverySummary } from "./codex-auto-pause-types.js";
import type { CodexGoalCapabilityState, CodexGoalState } from "./codex-goal.js";
import type { CodexTurnRecoveryDiagnosticMetadata } from "./codex-recovery-diagnostic-types.js";
import type { ActiveCodexReasoningPreview, CodexReasoningDetailMessage } from "./codex-reasoning-types.js";
import type { CodexAppReference, CodexSkillReference } from "./codex-reference-types.js";
import type {
  BackendReconnectProgress,
  CodexAutoPauseInputSourceKind,
  CodexAutoPauseRecoveryProgress,
  CodexOutboundTurnBase,
  CodexPendingDeliveryProofSignal,
  CodexProviderFailureContext,
  CodexProviderRetryState,
  CodexResultErrorFamily,
  CodexTurnRecoveryState,
} from "./codex-outbound-turn-types.js";
import type { LeaderProjectionSnapshot } from "./leader-projection-types.js";
import type { SessionLifecycleBrowserMessage } from "./session-lifecycle-message.js";
import type { SessionDefaultsSettings } from "../shared/session-defaults.js";
import type {
  SyncedProjectionResyncMessage,
  SyncedProjectionSnapshotMessage,
  SyncedProjectionSubscribeMessage,
  SyncedProjectionSubscription,
  SyncedProjectionSubscriptionsAckMessage,
  SyncedProjectionUpdateMessage,
} from "../shared/synced-projection.js";
import type { QuestTitlePreview } from "./quest-types.js";
import type { KeyedListDelta } from "../shared/keyed-list-delta.js";
import type { HistoryWindowState, InitialThreadWindowRequest, ThreadWindowState } from "./window-protocol-types.js";
import type {
  CodexCompactionCause,
  CodexCompactionCauseSource,
  CodexContextWindowDiagnostics,
  CodexLeaderRecycleContinuation,
  CodexLeaderRecycleTrigger,
  CodexModelSwitchCompactionGuard,
  SessionContextLengthSnapshot,
  SessionLifecycleEvent,
} from "./codex-context-types.js";
import type { SessionTokenUsageSample } from "./workspace-token-usage-types.js";
export type {
  CodexAutoPauseRecoveryLink,
  CodexAutoPauseRecoveryOutcome,
  CodexAutoPauseRecoveryReasonCode,
  CodexAutoPauseRecoveryReceipt,
  CodexAutoPauseRecoverySummary,
} from "./codex-auto-pause-types.js";
export type {
  BackendReconnectProgress,
  CodexAutoPauseInputSourceKind,
  CodexAutoPauseRecoveryProgress,
  CodexHistoryIncorporationState,
  CodexHistoryPresence,
  CodexOutboundTurnStatus,
  CodexPendingDeliveryProofKind,
  CodexPendingDeliveryProofSignal,
  CodexProviderFailureContext,
  CodexProviderFailureContextFamily,
  CodexProviderRecoveryFamily,
  CodexProviderRetryState,
  CodexResultErrorFamily,
  CodexTurnRecoveryReason,
  CodexTurnRecoveryContinuationMode,
  CodexTurnRecoveryState,
  CodexTurnRecoveryStatus,
} from "./codex-outbound-turn-types.js";
export type {
  LeaderProjectionSnapshot,
  LeaderProjectionThreadRow,
  LeaderProjectionThreadSummary,
} from "./leader-projection-types.js";
export type {
  AnsweredMessageReference,
  HistoryWindowState,
  InitialThreadWindowRequest,
  ThreadWindowState,
} from "./window-protocol-types.js";
export type { CodexAppReference, CodexSkillReference } from "./codex-reference-types.js";
export type { ActiveCodexReasoningPreview, CodexReasoningDetailMessage } from "./codex-reasoning-types.js";
export type { CodexMessagePhase } from "../shared/codex-message-phase.js";
export type * from "./leader-thread-response-types.js";
export type {
  CodexAutoCompactTokenLimitScope,
  CodexAutoCompactTokenLimitScopeSource,
  CodexCompactionCause,
  CodexCompactionCauseSource,
  CodexContextCapacitySource,
  CodexContextWindowDiagnostics,
  CodexLeaderRecycleContinuation,
  CodexLeaderRecycleEvent,
  CodexLeaderRecycleLineage,
  CodexLeaderRecycleTokenSnapshot,
  CodexLeaderRecycleTrigger,
  CodexModelSwitchCompactionGuard,
  SessionCompactionLifecycleEvent,
  SessionContextLengthSnapshot,
  SessionLifecycleEvent,
} from "./codex-context-types.js";
export type { SessionTokenUsageSample } from "./workspace-token-usage-types.js";

// Types for the WebSocket bridge between Claude Code CLI and the browser

// ─── CLI Message Types (NDJSON from Claude Code CLI) ──────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  claude_code_version: string;
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  output_style: string;
  uuid: string;
}

export interface CLISystemStatusMessage {
  type: "system";
  subtype: "status";
  // Claude CLI 2.1.289 / Agent SDK 0.2.141 also send "requesting" while a model request is in flight.
  status: "compacting" | "requesting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

export interface CLISystemCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata?: {
    trigger?: "auto" | "manual";
    pre_tokens?: number;
  };
  uuid: string;
  session_id: string;
}

export interface CLISystemTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id: string;
  status: string;
  output_file?: string;
  summary?: string;
  uuid?: string;
  session_id?: string;
}

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  /** Sanitized adapter-observed evidence that can disambiguate a misleading provider error. */
  codex_provider_failure_context?: CodexProviderFailureContext;
  /** Server-authored marker for a hidden, actively retrying provider result. */
  codex_provider_retry?: CodexProviderRetryState;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  // Observed from recordings: modelUsage totals are cumulative across the session
  // (for cost/accounting), not per-turn usage.
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      maxOutputTokens: number;
      costUSD: number;
    }
  >;
  total_lines_added?: number;
  total_lines_removed?: number;
  /** Codex turn id when this result was synthesized from a Codex turn/completed event. */
  codex_turn_id?: string;
  uuid: string;
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface CLIToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  output_delta?: string;
  /** Set on CLI keepalive progress for a long-running tool; its id gets a `-heartbeat-<n>` suffix. */
  heartbeat?: boolean;
  uuid: string;
  session_id: string;
}

export interface CLIToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    description?: string;
    tool_use_id: string;
    agent_id?: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export interface CLIAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIControlResponseMessage {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

/** CLI cancels a pending control_request it previously sent (e.g. after interrupt or hook auto-approval) */
export interface CLIControlCancelRequestMessage {
  type: "control_cancel_request";
  request_id: string;
}

export interface CLIUserMessage {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[] | string;
  };
  parent_tool_use_id: string | null;
  tool_use_result?: Record<string, unknown>;
  uuid: string;
  session_id: string;
}

export type CLIMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLISystemCompactBoundaryMessage
  | CLISystemTaskNotificationMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIToolProgressMessage
  | CLIToolUseSummaryMessage
  | CLIControlRequestMessage
  | CLIControlResponseMessage
  | CLIControlCancelRequestMessage
  | CLIKeepAliveMessage
  | CLIAuthStatusMessage
  | CLIUserMessage;

// ─── Tool Result Preview ─────────────────────────────────────────────────────

export interface ToolResultPreview {
  tool_use_id: string;
  /** Truncated content (last TOOL_RESULT_PREVIEW_LIMIT chars) */
  content: string;
  is_error: boolean;
  /** Original content size in UTF-8 bytes */
  total_size: number;
  /** Whether the preview was truncated */
  is_truncated: boolean;
  /** Wall-clock duration in seconds (tool_use → tool_result), rounded to 0.1s. Omitted if unknown. */
  duration_seconds?: number;
  /** Present when the server synthesized this preview to resolve an orphaned Codex tool call. */
  synthetic_reason?: string;
  /** Whether retained live terminal output was available for a synthesized preview. */
  retained_output?: boolean;
}

export const TOOL_RESULT_PREVIEW_LIMIT = 300;

// ─── Content Block Types ──────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
      /** Server-authored projected-preview metadata; provider-native blocks must not be trusted to supply it. */
      total_size?: number;
      is_truncated?: boolean;
      duration_seconds?: number;
    }
  | { type: "thinking"; thinking: string; budget_tokens?: number; thinking_time_ms?: number };

export interface VsCodeSelectionMetadata {
  absolutePath: string;
  relativePath: string;
  displayPath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export type ThreadRefSource = "explicit" | "inferred" | "backfill";

export interface ThreadRef {
  threadKey: string;
  questId?: string;
  source: ThreadRefSource;
  attachedAt?: number;
  attachedBy?: string;
}

export interface ThreadAttachmentMarker {
  type: "thread_attachment_marker";
  id: string;
  timestamp: number;
  markerKey: string;
  sourceThreadKey?: string;
  sourceQuestId?: string;
  threadKey: string;
  questId?: string;
  attachedAt: number;
  attachedBy: string;
  messageIds: string[];
  messageIndices: number[];
  ranges: string[];
  count: number;
  firstMessageId?: string;
  firstMessageIndex?: number;
}

export interface ThreadAttachmentMovementSummary {
  threadKey: string;
  questId?: string;
  count: number;
  details: string[];
  markerIds: string[];
}

export interface ThreadAttachmentUpdateChangedMessage {
  historyIndex: number;
  messageId: string;
  threadRefs: ThreadRef[];
}

export interface ThreadAttachmentUpdateEntry {
  target: { threadKey: string; questId?: string };
  source?: { threadKey: string; questId?: string };
  markers: ThreadAttachmentMarker[];
  markerHistoryIndices: number[];
  changedMessages: ThreadAttachmentUpdateChangedMessage[];
  ranges: string[];
  count: number;
}

export interface ThreadAttachmentUpdate {
  type: "thread_attachment_update";
  version: 1;
  updateId: string;
  timestamp: number;
  attachedAt: number;
  attachedBy: string;
  historyLength: number;
  affectedThreadKeys: string[];
  maxDistanceFromTail: number;
  maxChangedMessages: number;
  updates: ThreadAttachmentUpdateEntry[];
}

export interface ThreadTransitionMarker {
  type: "thread_transition_marker";
  id: string;
  timestamp: number;
  markerKey: string;
  sourceThreadKey: string;
  sourceQuestId?: string;
  threadKey: string;
  questId?: string;
  transitionedAt: number;
  reason: "route_switch";
  sourceMessageIndex?: number;
  targetThreadFreshness?: "new_quest_thread" | "existing_quest_thread";
}

export interface ActiveTurnRoute {
  threadKey: string;
  questId?: string;
}

export type SideChatContextStrategy = "native-fork" | "bounded-replay";

export type SideChatFallbackReasonCode =
  | "invalid-root-session"
  | "leader-session"
  | "invalid-anchor"
  | "unsupported-backend"
  | "codex-anchor-not-in-turn"
  | "codex-anchor-turn-incomplete"
  | "codex-anchor-not-final-assistant"
  | "codex-later-turn-incomplete"
  | "codex-adapter-disconnected"
  | "codex-fork-failed"
  | "codex-rollback-failed"
  | "claude-missing-session-or-anchor"
  | "claude-fork-failed";

export interface SideChatNativeEligibility {
  eligible: boolean;
  reason?: string;
  reasonCode?: SideChatFallbackReasonCode;
}

export interface SideChatFallbackEligibility {
  available: boolean;
  requiresConfirmation: boolean;
  reason?: string;
  reasonCode?: SideChatFallbackReasonCode;
}

export interface SideChatPreflight {
  ok: true;
  anchorMessageId: string;
  backendType: BackendType;
  existingSideChat?: SideChatRecord;
  native: SideChatNativeEligibility;
  fallback: SideChatFallbackEligibility;
}

export type SideChatFallbackMode = "native-only" | "allow-bounded-replay";

export interface SideChatRecord {
  id: string;
  rootSessionId: string;
  childSessionId: string;
  anchorMessageId: string;
  anchorHistoryIndex: number;
  anchorPreview: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview?: string;
  seeded: boolean;
  contextStrategy?: SideChatContextStrategy;
  contextFallbackReasonCode?: SideChatFallbackReasonCode;
  contextFallbackReason?: string;
}

export interface SideChatChildState {
  rootSessionId: string;
  threadId: string;
  anchorMessageId: string;
  anchorHistoryIndex: number;
  readOnly: true;
  contextStrategy?: SideChatContextStrategy;
  contextFallbackReasonCode?: SideChatFallbackReasonCode;
  contextFallbackReason?: string;
}

/** @deprecated Legacy persisted type name. Session JSON still uses slackThread* keys. */
export type SlackThreadRecord = SideChatRecord;
/** @deprecated Legacy persisted type name. Session JSON still uses slackThread* keys. */
export type SlackThreadChildState = SideChatChildState;

/**
 * Format a VSCode selection into a text prompt that tells the model which file
 * and line range the user has selected. Used by ws-bridge (CLI path),
 * claude-sdk-adapter, and codex-adapter when forwarding user messages.
 */
export function formatVsCodeSelectionPrompt(selection: VsCodeSelectionMetadata): string {
  if (selection.startLine === selection.endLine) {
    return `[user selection in VSCode: ${selection.relativePath} line ${selection.startLine}] (this may or may not be relevant)`;
  }
  return `[user selection in VSCode: ${selection.relativePath} lines ${selection.startLine}-${selection.endLine}] (this may or may not be relevant)`;
}

export interface VsCodeSelectionSnapshot {
  absolutePath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export interface VsCodeSelectionState {
  selection: VsCodeSelectionSnapshot | null;
  updatedAt: number;
  sourceId: string;
  sourceType: "browser-panel" | "vscode-window";
  sourceLabel?: string;
}

export interface VsCodeWindowState {
  sourceId: string;
  sourceType: "vscode-window";
  sourceLabel?: string;
  workspaceRoots: string[];
  updatedAt: number;
  lastActivityAt: number;
  lastSeenAt: number;
}

export interface VsCodeOpenFileTarget {
  absolutePath: string;
  line?: number;
  column?: number;
  endLine?: number;
  targetKind?: "file" | "directory";
}

export interface VsCodeOpenFileCommand {
  commandId: string;
  sourceId: string;
  target: VsCodeOpenFileTarget;
  createdAt: number;
}

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | import("./browser-connection-message-types.js").BrowserConnectionOutgoingMessage
  | {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
      imageRefs?: import("./image-store.js").ImageRef[];
      deliveryContent?: string;
      /** Server-only visible/history entries committed after this model-bound input. */
      historyFollowUps?: ProgrammaticHistoryFollowUp[];
      /** Server-only firing provenance; removed from untrusted browser ingress. */
      timerFiring?: import("./timer-types.js").TimerFiring;
      annotations?: ConversationAnnotation[];
      replyContext?: ReplyContext;
      threadMonitorResultId?: string;
      vscodeSelection?: VsCodeSelectionMetadata;
      client_msg_id?: string;
      /** Direct user entry point that should stay deliverable while other input sources are paused. */
      inputSource?: "composer" | "programmatic";
      /** Server-only override for Codex result-error auto-pause source classification. */
      autoPauseSourceKind?: CodexAutoPauseInputSourceKind;
      /** Server-only correlation for an automatic input released after a successful manual probe. */
      autoPauseRecoveries?: CodexAutoPauseRecoveryLink[];
      /** Server-only freshness proof for a deferred Thread Outcome Reminder. */
      leaderThreadOutcomeReminderGuard?: import("./leader-thread-response-types.js").LeaderThreadOutcomeReminderGuard;
      /** UI-only thread routing metadata. Main is implicit; quest threads are optional projections. */
      threadKey?: string;
      questId?: string;
      threadRefs?: ThreadRef[];
      /** Side Chat branch backed by a hidden child backend session. Persisted as slackThreadId for compatibility. */
      slackThreadId?: string;
      /** Present when the message was injected programmatically (e.g. via takode CLI or cron). */
      agentSource?: { sessionId: string; sessionLabel?: string };
      /** Server-only metadata for rebuilding/pruning queued herd batches before delivery. */
      takodeHerdBatch?: TakodeHerdBatchSnapshot;
    }
  | {
      type: "codex_start_pending";
      pendingInputIds: string[];
      inputs: CodexPendingBatchInput[];
      /** Stable opaque identity echoed by Codex when this exact ordered batch enters history. */
      clientUserMessageId?: string;
    }
  | {
      type: "codex_steer_pending";
      pendingInputIds: string[];
      expectedTurnId: string;
      inputs: CodexPendingBatchInput[];
      /** Stable opaque identity echoed by Codex when this exact ordered batch enters history. */
      clientUserMessageId?: string;
    }
  | {
      type: "vscode_selection_update";
      selection: VsCodeSelectionSnapshot | null;
      updatedAt: number;
      sourceId: string;
      sourceType: "browser-panel" | "vscode-window";
      sourceLabel?: string;
      client_msg_id?: string;
    }
  | {
      type: "permission_response";
      annotationMessage?: AnnotationMessage;
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: PermissionUpdate[];
      message?: string;
      /** Internal-only actor attribution for externally routed permission responses. */
      actorSessionId?: string;
      client_msg_id?: string;
    }
  | {
      /**
       * Point this open browser socket at another session (null: at none) instead
       * of opening a new connection, which costs several round trips on a slow link.
       */
      type: "session_switch";
      session_id: string | null;
    }
  | {
      type: "session_subscribe";
      last_seq: number;
      known_frozen_count?: number;
      known_frozen_hash?: string;
      history_window_section_turn_count: number;
      history_window_visible_section_count: number;
      history_window_target_message_id?: string;
      history_window_target_index?: number;
      initial_thread_window?: InitialThreadWindowRequest;
      full_history_sync?: boolean;
      synced_projection_subscriptions?: SyncedProjectionSubscription[];
      /** Large snapshot parts the browser holds, by hash; the server leaves out those still identical. */
      known_snapshot_parts?: import("../shared/snapshot-part-hash.js").KnownSnapshotParts;
    }
  | SyncedProjectionSubscribeMessage
  | SyncedProjectionResyncMessage
  | {
      /** A list update applied to a list this browser no longer holds; the server sends the list again. */
      type: "list_resync";
      list:
        | "notifications"
        | "attention_records"
        | "tree_groups"
        | "completed_board"
        | "row_session_statuses"
        | "leader_projection";
      /** Hash of the list the browser holds (unused for the leader projection, which is resent whole). */
      held: string;
    }
  | {
      /** The browser shows this session: clear its unread state, as `PATCH /sessions/:id/read` does. */
      type: "session_read";
      mode: "session-view";
    }
  | {
      type: "history_window_request";
      from_turn: number;
      turn_count: number;
      section_turn_count: number;
      visible_section_count: number;
      cached_window_hash?: string;
      target_message_id?: string;
      target_history_index?: number;
      activate_view?: boolean;
    }
  | {
      type: "thread_window_request";
      thread_key: string;
      from_item: number;
      item_count: number;
      section_item_count: number;
      visible_item_count: number;
      cached_window_hash?: string;
      target_message_id?: string;
      activate_view?: boolean;
    }
  | {
      type: "conversation_view_update";
      view: "history" | "thread";
      thread_key?: string;
      from: number;
      count: number;
      section_count: number;
      visible_count: number;
      cached_window_hash?: string;
    }
  | {
      type: "leader_thread_tabs_update";
      operation: LeaderThreadTabUpdate;
      client_msg_id?: string;
    }
  | {
      type: "history_sync_mismatch";
      frozen_count: number;
      expected_frozen_hash: string;
      actual_frozen_hash: string;
      expected_full_hash: string;
      actual_full_hash: string;
    }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string; interruptSource?: "user" | "leader" | "system" }
  | { type: "cancel_pending_codex_input"; id: string; client_msg_id?: string }
  | { type: "retry_pending_codex_input"; id: string; client_msg_id?: string }
  | { type: "resolve_codex_turn_recovery"; recoveryId: string; client_msg_id?: string }
  | { type: "release_codex_auto_paused_inputs"; pausedAt: number; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_codex_reasoning_effort"; effort: string; client_msg_id?: string }
  /** Empty `effort` returns Claude to its default effort. */
  | { type: "set_claude_reasoning_effort"; effort: string; client_msg_id?: string }
  | { type: "set_codex_service_tier"; serviceTier: string | null; client_msg_id?: string }
  | { type: "set_codex_ui_mode"; uiMode: "plan" | "agent"; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | { type: "mcp_set_servers"; servers: Record<string, McpServerConfig>; client_msg_id?: string }
  /** Start signing in to an MCP server that asks for it (Codex). */
  | { type: "mcp_sign_in"; serverName: string; client_msg_id?: string }
  /** Finish a sign-in with the callback address a browser on another device could not open. */
  | { type: "mcp_sign_in_callback"; serverName: string; callbackUrl: string; client_msg_id?: string }
  | { type: "set_ask_permission"; askPermission: boolean; client_msg_id?: string };
export type PausedInboundSource = "browser" | "programmatic";

export interface PausedInboundMessage {
  id: string;
  queuedAt: number;
  source: PausedInboundSource;
  message: Extract<BrowserOutgoingMessage, { type: "user_message" }>;
}

export interface SessionPauseState {
  pausedAt: number;
  pausedBy?: string;
  reason?: string;
  queuedMessages: PausedInboundMessage[];
  lastQueuedAt?: number;
}

export interface CodexAutoPauseHeldInput {
  id: string;
  queuedAt: number;
  lastQueuedAt: number;
  source: PausedInboundSource;
  message: Extract<BrowserOutgoingMessage, { type: "user_message" }>;
  count: number;
}

export interface CodexResultErrorAutoPauseState {
  family: CodexResultErrorFamily;
  fingerprint: string;
  streak: number;
  threshold: number;
  pausedAt: number | null;
  lastError: string;
  lastErrorAt: number;
  lastSourceKind: CodexAutoPauseInputSourceKind;
  totalMatchingErrors: number;
  heldInputs: CodexAutoPauseHeldInput[];
  /** Server-authoritative explicit release accepted for this exact pause epoch. */
  releaseProgress?: import("./codex-auto-pause-types.js").CodexAutoPauseReleaseProgress;
}

export type ContextUsageHistorySource = "claude_assistant_usage" | "claude_result_usage" | "codex_token_usage";

export interface ContextUsageHistoryEntry {
  timestamp: number;
  source: ContextUsageHistorySource;
  contextUsedPercent?: number;
  contextTokensUsed?: number;
  /** Numerator used for the reported percentage after role-specific display policy. */
  displayContextTokensUsed?: number;
  providerReportedTotalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  modelContextWindow?: number;
  leaderRecycleThresholdTokens?: number;
}

// Quest Journey state machine -- canonical source in shared/quest-journey.ts
export { QUEST_JOURNEY_STATES, QUEST_JOURNEY_HINTS } from "../shared/quest-journey.js";
export type { QuestJourneyPlanState, QuestJourneyState } from "../shared/quest-journey.js";

/** A single row on the leader's work board. */
export interface BoardRow {
  questId: string;
  /** Short title of the quest (cached for display). */
  title?: string;
  /** Human-readable quest description TLDR (cached for display). */
  questTldr?: string;
  /** Session ID of the assigned worker (optional). */
  worker?: string;
  /** Session number of the assigned worker (optional, cached for display). */
  workerNum?: number;
  /** Legacy metadata from the removed board no-code path. Ignored by active workflow logic. */
  noCode?: boolean;
  /** Active Quest Journey phase plan for this board row. */
  journey?: import("../shared/quest-journey.js").QuestJourneyPlanState;
  /** Legacy board state for compatibility; derived from the current Quest Journey phase. */
  status?: string;
  /** Queue-only dependencies: quest IDs (q-N), session numbers (#N), or free-worker. */
  waitFor?: string[];
  /** Linked same-session needs-input notification IDs that intentionally pause active work. */
  waitForInput?: string[];
  /** The leader's open questions to the user about this quest that do not pause Work. */
  openQuestions?: string[];
  /** The User Checkpoint Takode added for the leader's open questions (see board-user-checkpoint.ts). */
  autoCheckpoint?: BoardRowAutoCheckpoint;
  /** Epoch ms when this row was first added to the board. Used for stable sort. */
  createdAt: number;
  /**
   * Epoch ms of the latest transition from an inactive board state into active work.
   * This is the freshness event for automatic leader-tab surfacing and must not
   * advance during ordinary active phase/status updates.
   */
  threadTabActivatedAt?: number;
  /** Epoch ms when this row was last updated. */
  updatedAt: number;
  /** Epoch ms when this row was moved to the completed list. Present only for completed items. */
  completedAt?: number;
  /** The landing-queue change the quest waits for, from Work -> Memory until it lands. */
  landing?: BoardRowLanding;
  /** Set when another leader removed this stale row from a paused or archived leader's board. */
  staleRemoval?: BoardRowStaleRemoval;
}

/** Why a row left a stopped leader's board without its quest finishing there (kept in its board history). */
export interface BoardRowStaleRemoval {
  reason: string;
  /** The leader that removed it. */
  removedBy: string;
  removedAt: number;
}

export interface BoardRowAutoCheckpoint {
  /** Journey position of the checkpoint Takode added. */
  checkpointIndex: number;
  /** When Takode resumed the Work after it because every question was resolved; a new question soon after reopens it. */
  resumedAt?: number;
}

/**
 * A quest handed to Memory with a submitted landing-queue change. The quest,
 * not the worker, waits for it: after Memory the row moves to Landing, and
 * Takode records the landed commits and completes the quest, or keeps it in
 * Landing as bounced until the leader routes the fix.
 */
export interface BoardRowLanding {
  entryId: string;
  /** Worker that submitted it; the landed commits are recorded as its Work delivery. */
  workerSessionId: string;
  /** The Work occurrence that submitted it. */
  workPhaseOccurrenceId: string;
  preparationId?: string;
  branch: string;
  /** The submitted change's tip commit. */
  tip: string;
  /** Latest known outcome of the entry. */
  outcome?: "landed" | "bounced" | "withdrawn";
  /** Why it bounced or was withdrawn. */
  reason?: string;
  /** Recorded delivery of the landed commits. */
  deliveryId?: string;
  /** Why recording the landed commits failed; Takode retries. */
  recordError?: string;
  /** Final Memory's completion, applied once the change has landed and been recorded. */
  completion?: ParkedQuestCompletion;
}

export interface ParkedQuestCompletion {
  verificationItems: import("./quest-types.js").QuestVerificationItem[];
  debrief: string;
  debriefTldr: string;
  debriefMachine?: string;
  memoryCommitShas?: string[];
  /** Epoch ms when final Memory completed. */
  completedAt: number;
}

export interface BoardParticipantStatus {
  sessionId: string;
  sessionNum?: number | null;
  name?: string;
  status: "running" | "idle" | "disconnected" | "archived";
  activeTurnRoute?: ActiveTurnRoute | null;
  codexReasoningPreviews?: ActiveCodexReasoningPreview[];
  generationStartedAt?: number | null;
}

export interface BoardRowSessionStatus {
  worker?: BoardParticipantStatus;
  reviewer?: BoardParticipantStatus | null;
  /** Helper sessions the row waits on (`--wait-for #N`), in wait-for order; archived ones are left out. */
  helpers?: BoardParticipantStatus[];
}

/**
 * The completed work board and the board rows' session statuses as a board
 * update or state snapshot carries them: whole, as changes from a copy the
 * browser holds, or neither when it holds the current one; the hash names the
 * current list (see server/bridge/browser-board-rows.ts). Statuses travel as
 * `[questId, status]` entries in their changes and hash.
 */
export interface BoardListFields {
  completedBoard?: BoardRow[];
  completedBoardDelta?: KeyedListDelta<BoardRow>;
  completedBoardHash?: string;
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
  rowSessionStatusesDelta?: KeyedListDelta<[string, BoardRowSessionStatus]>;
  rowSessionStatusesHash?: string;
}

export interface ThreadWindowEntry {
  message: BrowserIncomingMessage;
  history_index: number;
  synthetic?: boolean;
}

/** High-level task recognized by the session auto-namer. */
export interface SessionTaskEntry {
  title: string;
  action: "name" | "revise" | "new";
  timestamp: number;
  /** ID of the user message that triggered this naming evaluation. */
  triggerMessageId: string;
  /** When "quest", this entry was created by claiming a quest (not by the auto-namer). */
  source?: "quest";
  /** Present for quest-sourced entries so UI can deep-link to Questmaster details. */
  questId?: string;
}

export type NotificationCategory = "needs-input" | "review" | "waiting";

export interface TakodeNotificationPayload {
  id?: string;
  category: NotificationCategory;
  summary?: string;
  /** Legacy in-card decision context; new prompts carry context as the anchored feed message. */
  body?: string;
  /** Question-only prompt; see SessionNotification.questionOnly. */
  questionOnly?: boolean;
  suggestedAnswers?: string[];
  questions?: NeedsInputNotificationQuestion[];
  timestamp: number;
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}

export interface ThreadOutcomeReminderSatisfaction {
  status: "satisfied";
  notificationId: string;
  notificationSummary?: string;
  satisfiedAt: number;
}

export interface NeedsInputNotificationQuestion {
  prompt: string;
  suggestedAnswers?: string[];
}

export interface QuestLifecycleEventSnapshot {
  questId: string;
  title: string;
  status: string;
  description?: string;
  tldr?: string;
  tags?: string[];
  images?: import("./quest-types.js").QuestImage[];
  verificationItems?: import("./quest-types.js").QuestVerificationItem[];
  leaderSessionId?: string;
}

/**
 * Something the user may want to hear about happened in a tab: a new needs-input
 * prompt for the user, or a result to read (a tab became newly unread, or a
 * Notify Me result). Sent to every browser, which decides whether to play a sound.
 */
export interface AttentionAlertMessage {
  type: "attention_alert";
  session_id: string;
  kind: "needs-input" | "result";
  /** The leader thread tab the alert belongs to; absent for ordinary sessions, whose tab is the session. */
  thread_key?: string;
}

/** Messages the bridge sends to the browser */
export type BrowserIncomingMessageBase =
  | import("./browser-connection-message-types.js").BrowserConnectionIncomingMessage
  | { type: "session_draft_update"; change: import("../shared/session-drafts.js").SessionDraftChange }
  | { type: "voice_result_pending"; result: import("../shared/voice-results.js").PendingVoiceResult }
  | { type: "session_update"; session: Partial<BrowserSessionState> }
  | {
      type: "assistant";
      message: CLIAssistantMessage["message"];
      parent_tool_use_id: string | null;
      codexMessagePhase?: CodexMessagePhase;
      timestamp?: number;
      uuid?: string;
      tool_start_times?: Record<string, number>;
      turn_duration_ms?: number;
      notification?: TakodeNotificationPayload;
      threadStatusMarkers?: LeaderThreadStatus[];
    }
  | import("../shared/markdown-report.js").MarkdownReportMessage
  | CodexReasoningDetailMessage
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | { type: "result"; data: CLIResultMessage; interrupted?: boolean }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | {
      type: "tool_progress";
      tool_use_id: string;
      tool_name: string;
      elapsed_time_seconds: number;
      /** Codex-only: incremental terminal output chunk from commandExecution/outputDelta. */
      output_delta?: string;
    }
  | {
      type: "transcription_progress";
      requestId: string;
      phase: "transcribing" | "finalizing" | "enhancing" | "editing" | "appending" | "complete" | "error";
      mode?: "dictation" | "edit" | "append";
      timestamp: number;
      timing?: {
        uploadDurationMs?: number;
        sttDurationMs?: number;
        enhancementDurationMs?: number;
        audioSizeBytes?: number;
        audioMimeType?: string | null;
        audioFileName?: string | null;
        serverTiming?: {
          bodyReadDurationMs?: number;
          contextBuildDurationMs?: number;
          ssePhaseWriteDurationMs?: number;
          sttCompleteWriteDurationMs?: number;
          resultReadyDurationMs?: number;
          resultWriteDurationMs?: number;
          serverTotalDurationMs?: number;
          uploadFormatMimeType?: string;
          uploadFormatExtension?: string;
        };
      };
      result?: {
        mode?: "dictation" | "edit" | "append";
        text: string;
        rawText?: string;
        instructionText?: string;
        backend: string;
        enhanced: boolean;
        timing?: {
          uploadDurationMs?: number;
          sttDurationMs?: number;
          enhancementDurationMs?: number;
          audioSizeBytes?: number;
          audioMimeType?: string | null;
          audioFileName?: string | null;
          serverTiming?: {
            bodyReadDurationMs?: number;
            contextBuildDurationMs?: number;
            ssePhaseWriteDurationMs?: number;
            sttCompleteWriteDurationMs?: number;
            resultReadyDurationMs?: number;
            resultWriteDurationMs?: number;
            serverTotalDurationMs?: number;
            uploadFormatMimeType?: string;
            uploadFormatExtension?: string;
          };
        };
      };
      error?: string;
    }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | {
      type: "status_change";
      status: "compacting" | "reverting" | "idle" | "running" | null;
      codexCompactionCause?: CodexCompactionCause;
      codexCompactionCauseSource?: CodexCompactionCauseSource;
      activeTurnRoute?: ActiveTurnRoute | null;
      /** Server turn start, sent with "running" so the browser timer counts from dispatch. */
      generationStartedAt?: number;
      codexReasoningPreviews?: ActiveCodexReasoningPreview[];
      codexAutoPauseRecoveryProgress?: CodexAutoPauseRecoveryProgress | null;
    }
  | { type: "permissions_cleared" }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string; id?: string; timestamp?: number }
  | { type: "backend_disconnected"; reason?: "idle_limit" | "broken" | "recovery_suppressed" }
  | { type: "backend_connected" }
  | { type: "vscode_selection_state"; state: VsCodeSelectionState | null }
  | ({
      type: "user_message";
      content: string;
      /** Exact model-bound content retained only for committed Codex turn-recovery events. */
      modelDeliveryContent?: string;
      timestamp: number;
      id?: string;
      client_msg_id?: string;
      cliUuid?: string;
      images?: import("./image-store.js").ImageRef[];
      annotations?: ConversationAnnotation[];
      replyContext?: ReplyContext;
      agentSource?: { sessionId: string; sessionLabel?: string };
      vscodeSelection?: VsCodeSelectionMetadata;
      threadKey?: string;
      questId?: string;
      threadRefs?: ThreadRef[];
      slackThreadId?: string;
      threadRoutingError?: ThreadRoutingError;
      takodeHerdEventKeys?: string[];
      takodeHerdEvents?: TakodeHerdEventBrowserMetadata[];
      threadOutcomeReminder?: ThreadOutcomeReminderSatisfaction;
      /** Server-authored durable grouping boundary when visible streamed response text preceded this human input. */
      recentAskBoundaryBefore?: "visible_response";
    } & CodexTurnRecoveryDiagnosticMetadata &
      import("./leader-thread-response-types.js").LeaderAnswerTrackedUserMetadata)
  | import("./leader-thread-response-types.js").LegacyLeaderThreadResponseMessage<
      TakodeNotificationPayload,
      ThreadRef,
      ThreadRoutingError
    >
  | { type: "codex_pending_inputs"; inputs: PendingCodexInput[] }
  | { type: "codex_pending_input_cancelled"; input: PendingCodexInput }
  | {
      type: "codex_pending_input_failed";
      input: PendingCodexInput;
      reason: CodexPendingInputFailureReason;
      message: string;
    }
  | {
      type: "codex_auto_pause_recovery_summary";
      id: string;
      timestamp: number;
      content: string;
      searchText: string;
      recovery: CodexAutoPauseRecoverySummary;
    }
  | ThreadAttachmentUpdate
  | { type: "history_window_sync"; messages: BrowserIncomingMessage[]; window: HistoryWindowState; cache_hit?: boolean }
  | {
      type: "thread_window_sync";
      thread_key: string;
      /** The window's entries, or with `entries_delta` its new and changed entries in window order. */
      entries: ThreadWindowEntry[];
      /**
       * Present when the window is sent as changes from the window hashed `base`
       * that the browser named as held: drop `removed` entries, replace and add
       * `entries` by `threadWindowEntryId`, arranged by `order` when given.
       */
      entries_delta?: { base: string; removed: string[]; order?: string[] };
      window: ThreadWindowState;
      /** Left out on a cache hit: the window hash covers it, so the browser's cached window has it. */
      response_state?: import("./leader-thread-response-types.js").LeaderThreadResponseProjection;
      cache_hit?: boolean;
    }
  | {
      type: "leader_projection_snapshot";
      /**
       * Each list is present whole, or left out when the browser holds the
       * current one or `<list>Delta` carries the changes from the copy it
       * named (see server/bridge/leader-projection-lists.ts).
       */
      projection: Omit<LeaderProjectionSnapshot, "threadSummaries" | "messageAttentionRecords"> &
        Partial<Pick<LeaderProjectionSnapshot, "threadSummaries" | "messageAttentionRecords">>;
      threadSummariesHash?: string;
      threadSummariesDelta?: KeyedListDelta<import("./leader-projection-types.js").LeaderProjectionThreadSummary>;
      messageAttentionRecordsHash?: string;
      messageAttentionRecordsDelta?: KeyedListDelta<SessionAttentionRecord>;
    }
  | {
      /** The session's scroll-position handoffs, sent on subscribe and after each accepted change. */
      type: "viewport_handoff_state";
      /** Absent on a subscribe whose browser named the current state as held. */
      state?: import("../shared/viewport-handoff.js").ViewportHandoffSessionState;
      /** Instead of `state`: the identity of the held state, which is current. */
      held?: string;
      serverNow: number;
    }
  | SyncedProjectionSnapshotMessage
  | SyncedProjectionSubscriptionsAckMessage
  | SyncedProjectionUpdateMessage
  | {
      type: "history_sync";
      frozen_base_count: number;
      frozen_base_history_index: number;
      frozen_delta: BrowserIncomingMessage[];
      hot_messages: BrowserIncomingMessage[];
      frozen_count: number;
      expected_frozen_hash: string;
      expected_full_hash: string;
    }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "conversation_sync_complete"; through_seq: number }
  | { type: "session_task_history"; tasks: SessionTaskEntry[] }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | import("../shared/compaction-marker.js").CompactionBoundaryMessage
  | import("../shared/compaction-marker.js").CompactionMarkerMessage
  | { type: "compact_summary"; summary: string }
  | { type: "tool_result_preview"; previews: ToolResultPreview[] }
  | ThreadAttachmentMarker
  | ThreadTransitionMarker
  | {
      type: "cross_thread_activity_marker";
      id: string;
      timestamp: number;
      threadKey: string;
      questId?: string;
      count: number;
      activityKind?: "thread_attach";
      summary?: string;
      attachedCount?: number;
      firstMessageId: string;
      lastMessageId: string;
      firstHistoryIndex?: number;
      lastHistoryIndex?: number;
      startedAt: number;
      updatedAt: number;
    }
  | {
      type: "permission_denied";
      id: string;
      tool_name: string;
      tool_use_id: string;
      summary: string;
      timestamp: number;
      request_id?: string;
    }
  | {
      type: "permission_approved";
      annotationMessage?: AnnotationMessage;
      id: string;
      tool_name: string;
      tool_use_id: string;
      summary: string;
      timestamp: number;
      request_id?: string;
      answers?: { question: string; answer: string }[];
    }
  | {
      type: "leader_group_idle";
      leader_session_id: string;
      leader_label: string;
      member_count: number;
      idle_for_ms: number;
      timestamp: number;
    }
  | ({
      type: "state_snapshot";
      sessionStatus: string | null;
      permissionMode: string;
      backendConnected: boolean;
      backendState?: SessionState["backend_state"];
      backendError?: string | null;
      backendReconnect?: BackendReconnectProgress | null;
      codexProviderRetry?: CodexProviderRetryState | null;
      codexStreamRetry?: SessionState["codex_stream_retry"];
      codexTurnRecovery?: CodexTurnRecoveryState | null;
      uiMode: string | null;
      askPermission: boolean;
      generationStartedAt?: number | null;
      activeTurnRoute?: ActiveTurnRoute | null;
      codexReasoningPreviews?: ActiveCodexReasoningPreview[];
      codexAutoPauseRecoveryProgress?: CodexAutoPauseRecoveryProgress | null;
      /** Left out when the browser named an identical copy in its subscribe. */
      board?: BoardRow[];
      leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
      /** Left out with its records when the feed attention snapshot of the same subscribe sent them. */
      notifications?: SessionNotification[];
      notificationsDelta?: KeyedListDelta<SessionNotification>;
      notificationsHash?: string;
      /** Unsent drafts shared by the user's browsers (see shared/session-drafts.ts). */
      drafts?: import("../shared/session-drafts.js").SessionDraftsState;
      attentionRecords?: SessionAttentionRecord[];
      attentionRecordsDelta?: KeyedListDelta<SessionAttentionRecord>;
      attentionRecordsHash?: string;
      notificationUrgency?: "needs-input" | "review" | null;
      activeNotificationCount?: number;
      activeNeedsInputNotificationCount?: number;
      activeReviewNotificationCount?: number;
      mutedNeedsInputNotificationCount?: number;
      notificationStatusVersion?: number;
      notificationStatusUpdatedAt?: number;
    } & BoardListFields)
  | {
      /** Sent before a subscribe's conversation window, so the feed's first render
       *  already has the notification chips and attention rows placed in it. */
      type: "feed_attention_snapshot";
      /**
       * Each list comes whole, as a delta from the list the browser named in
       * its subscribe, or not at all when the browser holds the current one
       * (see server/bridge/feed-attention-lists.ts). The hash names the current list.
       */
      notifications?: SessionNotification[];
      notificationsDelta?: KeyedListDelta<SessionNotification>;
      notificationsHash?: string;
      attentionRecords?: SessionAttentionRecord[];
      attentionRecordsDelta?: KeyedListDelta<SessionAttentionRecord>;
      attentionRecordsHash?: string;
      notificationUrgency?: "needs-input" | "review" | null;
      activeNotificationCount?: number;
      activeNeedsInputNotificationCount?: number;
      activeReviewNotificationCount?: number;
      mutedNeedsInputNotificationCount?: number;
      notificationStatusVersion?: number;
      notificationStatusUpdatedAt?: number;
    }
  | { type: "session_stuck" }
  | { type: "session_unstuck" }
  | { type: "quest_list_updated"; quest?: QuestTitlePreview }
  | { type: "todo_state_updated"; revision: number; updatedAt: number }
  | { type: "settings_updated"; sessionDefaults: SessionDefaultsSettings }
  | {
      type: "quest_lifecycle_event";
      id: string;
      timestamp: number;
      kind: "claimed" | "submitted";
      quest: QuestLifecycleEventSnapshot;
    }
  | {
      type: "session_quest_claimed";
      quest: {
        id: string;
        title: string;
        status?: string;
        verificationInboxUnread?: boolean;
        leaderSessionId?: string;
      } | null;
    }
  | {
      type: "task_notification";
      task_id: string;
      tool_use_id: string;
      status: string;
      output_file?: string;
      summary?: string;
    }
  | SessionLifecycleBrowserMessage
  | {
      type: "notification_anchored";
      messageId: string | null;
      notification: TakodeNotificationPayload;
    }
  | ({
      type: "board_updated";
      board: BoardRow[];
      leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
    } & BoardListFields)
  | {
      type: "notification_update";
      /** Whole, or as a delta from the list the previous update sent; the hash names the current list. */
      notifications?: SessionNotification[];
      notificationsDelta?: KeyedListDelta<SessionNotification>;
      notificationsHash?: string;
      notificationUrgency?: NotificationUrgency;
      activeNotificationCount?: number;
      activeNeedsInputNotificationCount?: number;
      activeReviewNotificationCount?: number;
      notificationStatusVersion?: number;
      notificationStatusUpdatedAt?: number;
      mutedNeedsInputNotificationCount?: number;
    }
  | {
      type: "attention_records_update";
      /** Whole, or as a delta from the records the previous update sent; the hash names the current records. */
      attentionRecords?: SessionAttentionRecord[];
      attentionRecordsDelta?: KeyedListDelta<SessionAttentionRecord>;
      attentionRecordsHash?: string;
    }
  | { type: "timer_update"; timers: import("./timer-types.js").SessionTimer[] }
  | AttentionAlertMessage
  | {
      type: "session_activity_update";
      session_id: string;
      session: {
        notificationUrgency?: NotificationUrgency;
        activeNotificationCount?: number;
        activeNeedsInputNotificationCount?: number;
        activeReviewNotificationCount?: number;
        mutedNeedsInputNotificationCount?: number;
        notificationStatusVersion?: number;
        notificationStatusUpdatedAt?: number;
        leaderActiveBoardRows?: BoardRow[];
        leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
        modelProvenanceMigration?: ModelProvenanceMigration;
      };
    }
  | {
      type: "tree_groups_update";
      treeGroups: import("./tree-group-store.js").TreeGroup[];
      /** Whole, or as a delta of `[sessionId, groupId]` entries from the tree groups the browser holds. */
      treeAssignments?: Record<string, string>;
      treeAssignmentsDelta?: KeyedListDelta<[string, string]>;
      treeNodeOrder: Record<string, string[]>;
      /** `snapshotPartHash` of the tree groups this message leaves the browser with. */
      treeGroupsHash?: string;
    };

type BrowserIncomingMessageMetadata = import("./leader-thread-response-types.js").LeaderRoutedAssistantMetadata & {
  seq?: number;
  /** Raw messageHistory index when this live event is already durably persisted. */
  history_index?: number;
  /** Optional quest/thread memberships. Main is implicit for every history entry. */
  threadRefs?: ThreadRef[];
  threadKey?: string;
  questId?: string;
  threadRoutingError?: ThreadRoutingError;
  codexSubagent?: import("../shared/codex-native-subagent-types.js").CodexNativeSubagentOwnership;
};

export type BrowserIncomingMessage = BrowserIncomingMessageBase & BrowserIncomingMessageMetadata;

export type ReplayableBrowserIncomingMessage = Exclude<
  BrowserIncomingMessageBase,
  {
    type:
      | "event_replay"
      | "browser_connection_probe"
      | "synced_projection_snapshot"
      | "synced_projection_update"
      | "synced_projection_subscriptions_ack"
      | "session_draft_update"
      | "voice_result_pending";
  }
> &
  BrowserIncomingMessageMetadata;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export {
  isClaudeFamily,
  normalizePersistedBackendType,
  parseBackendSelection,
  type BackendType,
} from "./backend-type.js";

/** Exhaustive check — TypeScript errors if a switch doesn't cover all cases. */
export function assertNever(x: never, msg?: string): never {
  throw new Error(msg ?? `Unexpected value: ${JSON.stringify(x)}`);
}

export interface StarredMessageRecord {
  messageId: string;
  role: "user" | "assistant";
  historyIndex: number;
  sourceThreadKey: string;
  routeThreadKey: string;
  timestamp: number;
  starredAt: number;
  questId?: string;
}

export type CodexOutboundTurn = CodexOutboundTurnBase<BrowserOutgoingMessage>;

export interface SessionState extends BackendSessionState {
  session_id: string;
  /** Durable Takode session-group identity. Explicitly set to "default" when ungrouped. */
  treeGroupId?: string;
  /** Authoritative memory/session-space slug used for default memory repo resolution. */
  memorySessionSpaceSlug?: string;
  /** Whether this session is an orchestrator/leader session. */
  isOrchestrator?: boolean;
  /** Codex leader context management mode; missing values mean backward-compatible recycling. */
  codexLeaderCompactionMode?: import("../shared/codex-leader-compaction-mode.js").CodexLeaderCompactionMode;
  /** Server-owned leader quest/thread tab state. Browsers must treat this as authoritative. */
  leaderOpenThreadTabs?: LeaderOpenThreadTabsState;
  /** Durable Notify Me preferences and results; never owned by read/view state. */
  threadMonitoring?: import("../shared/thread-monitoring.js").ThreadMonitoringState;
  /** Server-owned starred chat messages keyed by stable raw message ID. */
  starredMessages?: Record<string, StarredMessageRecord>;
  /**
   * Messages whose long content (a report, a long user message) is shown expanded in every
   * browser, keyed by stable raw message ID with the time it was expanded. Collapsed is the default.
   */
  expandedMessages?: Record<string, number>;
  backend_type?: BackendType;
  model: string;
  /** Server-owned historical warning for one-time unknown-provenance migration. */
  modelProvenanceMigration?: ModelProvenanceMigration;
  /** Server-owned configured Codex web access for the next launch/resume. */
  codex_internet_access?: boolean | null;
  /** Server-owned configured Codex usable context capacity target for the next launch/resume. */
  codex_max_context_length?: number | null;
  /** Launch-resolved context/compaction values used only for diagnostics and truthful presentation. */
  codex_context_window_diagnostics?: CodexContextWindowDiagnostics;
  /** Server-owned Codex leader context management mode for the next launch/resume. */
  codex_leader_compaction_mode?: import("../shared/codex-leader-compaction-mode.js").CodexLeaderCompactionMode;
  /** Server-owned configured Claude reasoning effort; applied live to a running process and on launch/resume. */
  claude_reasoning_effort?: string | null;
  /** Server-owned configured Claude max-context override for the next launch/resume. */
  claude_max_context_length?: number | null;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  /** Latest status-retrieval failure; only a successful retrieval clears it. */
  mcp_status_error?: string | null;
  agents: string[];
  slash_commands: string[];
  skills: string[];
  /** Codex skill metadata used for `$` mention insertion. */
  skill_metadata?: CodexSkillReference[];
  /** Codex app metadata used for `$` mention insertion. */
  apps?: CodexAppReference[];
  /** Codex reported skill/app metadata may be stale after an automatic skills/changed event. */
  skills_stale?: boolean;
  apps_stale?: boolean;
  skills_stale_since?: number | null;
  skills_last_changed_at?: number | null;
  skills_last_change_reason?: "skills_changed" | null;
  skills_change_count?: number;
  total_cost_usd: number;
  /** Backend-owned count of real human/operator user turns. */
  user_turn_count?: number;
  /** Backend-owned count of completed result-backed assistant turns. */
  agent_turn_count?: number;
  /** Legacy visible turn count; mirrors user_turn_count when backend history is available. */
  num_turns: number;
  context_used_percent: number;
  /** Approximate JSON byte size of the server-side message history. */
  message_history_bytes?: number;
  /**
   * Approximate Codex-retained payload size, including full tool results that
   * are hidden behind browser replay previews.
   */
  codex_retained_payload_bytes?: number;
  is_compacting: boolean;
  git_branch: string;
  /** Current HEAD commit SHA (server-derived, used for history rewrite detection). */
  git_head_sha?: string;
  git_default_branch?: string;
  diff_base_branch?: string;
  /** True when diff_base_branch came from an explicit user selection in the UI. */
  diff_base_branch_explicit?: boolean;
  /** Stable anchor commit for "agent-made diff" in worktree sessions. */
  diff_base_start_sha?: string;
  is_worktree: boolean;
  is_containerized: boolean;
  /** Registered remote host the session runs on; absent when it runs on the coordinator's machine. */
  host_id?: string;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
  /** Intentional diff-stat budget skip reason; distinct from refresh failures. */
  diff_stats_skipped_reason?: string | null;
  /** Epoch ms for the last server git metadata refresh attempt. */
  git_status_refreshed_at?: number;
  /** Last git refresh error, surfaced so stale chips do not look authoritative. */
  git_status_refresh_error?: string | null;
  // Codex-specific token details (forwarded from thread/tokenUsage/updated)
  codex_token_details?: {
    /** Provider-reported last input; retained as the leader recycle trigger input. */
    contextTokensUsed?: number;
    /** Numerator used for the ordinary context percentage after role-specific policy. */
    displayContextTokensUsed?: number;
    /** Provider-reported latest response total and normal Codex display numerator. */
    providerReportedTotalTokens?: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    modelContextWindow: number;
  };
  /** Resolved Codex leader recycle threshold for display-only effective context metrics. */
  codex_leader_recycle_threshold_tokens?: number;
  // Claude/CloudCode token details (forwarded from result.modelUsage)
  claude_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    modelContextWindow: number;
  };
  /** Debug lifecycle events for the session info panel. */
  lifecycle_events?: SessionLifecycleEvent[];
  // Codex-specific rate limits (forwarded from account/rateLimits/updated)
  codex_rate_limits?: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  };
  /** Requested Codex reasoning effort retained for relaunch and editing. */
  codex_reasoning_effort?: string;
  /** Runtime-reported effort; null is an explicit Codex default. */
  codex_effective_reasoning_effort?: string | null;
  codex_effective_reasoning_effort_reported?: boolean;
  /** Codex app-server service tier selected for future turns. null/undefined means Standard. */
  codex_service_tier?: string | null;
  /** Compact server-authoritative Codex Goal projection for the active thread. */
  codex_goal?: CodexGoalState | null;
  /** Fail-closed support state for the active Codex Goal protocol. */
  codex_goal_capability?: CodexGoalCapabilityState;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** UI mode: "plan" or "agent" — virtual concept, maps to CLI modes via askPermission */
  uiMode?: "plan" | "agent";
  /** Whether the session requires permission prompts for tool use (default: true) */
  askPermission?: boolean;
  /** Epoch ms when the user last viewed this session (server-only, never from CLI) */
  lastReadAt?: number;
  /** Current attention reason (server-only, never from CLI) */
  attentionReason?: "action" | "error" | "review" | null;
  /** Server-owned emergency pause state. While set, new user work is held or rejected. */
  pause?: SessionPauseState | null;
  /** Codex-only auto-pause state for repeated classified terminal result errors. */
  codex_result_error_auto_pause?: CodexResultErrorAutoPauseState | null;
  /** Exact-owner state for an interrupted Codex turn that has not reached a final response. */
  codex_turn_recovery?: CodexTurnRecoveryState | null;
  /** Ephemeral server-authored browser projection; never persisted as recovery state. */
  codex_result_error_auto_pause_recovery_progress?: CodexAutoPauseRecoveryProgress | null;
  /** Questmaster: ID of the quest claimed by this session */
  claimedQuestId?: string;
  /** Questmaster: title of the claimed quest (for display without fetching) */
  claimedQuestTitle?: string;
  /** Questmaster: current status of the claimed quest */
  claimedQuestStatus?: string;
  /** Questmaster: present while a completed claimed quest is still in review workflow */
  claimedQuestVerificationInboxUnread?: boolean;
  /** Questmaster: orchestrating leader session for the claimed quest, when known */
  claimedQuestLeaderSessionId?: string;
  /** Authoritative browser-safe native Codex child snapshot. */
  codex_native_subagents?: import("../shared/codex-native-subagent-types.js").CodexNativeSubagentSnapshot;
  /** Codex-only visual stage for image-attached user sends. */
  codex_image_send_stage?: "uploading" | "processing" | "responding" | null;
  /** Per-session notification inbox entries (server-only, never from CLI) */
  notifications?: SessionNotification[];
  /** Server-authoritative attention records for Main ledger rows and top chips. */
  attentionRecords?: SessionAttentionRecord[];
  /** Server-authoritative current Thread Waiting/Ready markers keyed by normalized thread key. */
  leaderThreadStatuses?: Record<string, LeaderThreadStatus>;
  /** "Remind me later" wake times keyed by normalized thread key; browsers get them through the tab projection. */
  leaderThreadReminders?: Record<string, import("./bridge/thread-reminders.js").LeaderThreadReminder>;
  /** Server-authoritative Side Chat records, persisted under the legacy slackThreads key for compatibility. */
  slackThreads?: Record<string, SideChatRecord>;
  /** Present on hidden child backend sessions that power one Side Chat, persisted under the legacy key. */
  slackThreadChild?: SideChatChildState;
  /** Hidden sessions are omitted from normal user session lists but remain addressable by branch UI. */
  hidden?: boolean;
}

type BrowserSessionInternalAlias =
  | "leaderOpenThreadTabs"
  | "leaderThreadStatuses"
  | "leaderThreadReminders"
  | "threadMonitoring";

/** Session state safe for current-build browser snapshots and patches. */
export type BrowserSessionState = Omit<SessionState, BrowserSessionInternalAlias>;

/** Keep durable/internal owners off broad browser session messages. */
export function projectBrowserSessionState<T extends Partial<SessionState>>(
  state: T,
): Omit<T, BrowserSessionInternalAlias> {
  const {
    leaderOpenThreadTabs: _leaderOpenThreadTabs,
    leaderThreadStatuses: _leaderThreadStatuses,
    leaderThreadReminders: _leaderThreadReminders,
    threadMonitoring: _threadMonitoring,
    codex_result_error_auto_pause_recovery_testing: _recoveryTesting,
    ...browserState
  } = state as T & { codex_result_error_auto_pause_recovery_testing?: unknown };
  return browserState as Omit<T, BrowserSessionInternalAlias>;
}

/**
 * The session a browser gets in `session_init`: its whole browser-visible state. Browsers replace
 * their copy with it, so a partial one (like a backend's own init) would erase expanded messages,
 * stars and other session state until the next reconnect.
 */
export function browserSessionInitState(state: SessionState, isOrchestrator: boolean): BrowserSessionState {
  return { ...projectBrowserSessionState(state), isOrchestrator };
}

export type NotificationUrgency = "needs-input" | "review" | null;

export type SessionAttentionRecordType =
  | "needs_input"
  | "review_ready"
  | "blocked_user_resolvable"
  | "quest_journey_started"
  | "quest_thread_created"
  | "quest_completed_recent"
  | "quest_reopened_or_rework"
  | "attention_summary";

export type SessionAttentionRecordPriority =
  | "needs_input"
  | "review"
  | "blocked"
  | "created"
  | "completed"
  | "milestone";

export type SessionAttentionRecordState =
  | "unresolved"
  | "muted"
  | "seen"
  | "resolved"
  | "dismissed"
  | "reopened"
  | "superseded";

export interface SessionAttentionRecordRoute {
  threadKey: string;
  questId?: string;
  messageId?: string;
  messageIndex?: number;
  bannerId?: string;
  questOverlay?: string;
}

export interface SessionAttentionRecord {
  id: string;
  leaderSessionId: string;
  type: SessionAttentionRecordType;
  source: {
    kind: "notification" | "board" | "quest" | "herd" | "message" | "manual";
    id?: string;
    questId?: string;
    messageId?: string | null;
    signature?: string;
  };
  questId?: string;
  threadKey: string;
  title: string;
  summary: string;
  /** Optional quest description TLDR used by quest lifecycle presentation rows. */
  questTldr?: string;
  actionLabel: "Answer" | "Review" | "Unblock" | "Open" | "Jump";
  priority: SessionAttentionRecordPriority;
  state: SessionAttentionRecordState;
  journeyLifecycleStatus?: "active" | "completed";
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  dismissedAt?: number;
  reopenedAt?: number;
  route: SessionAttentionRecordRoute;
  chipEligible: boolean;
  ledgerEligible: boolean;
  dedupeKey: string;
  supersedesDedupeKeys?: string[];
  threadAttachmentSummary?: ThreadAttachmentMovementSummary;
}

/** A notification collected when `takode notify` fires. Persisted per session. */
export interface SessionNotification {
  id: string;
  category: NotificationCategory;
  summary?: string;
  /** Legacy decision context rendered inside the card. Only prompts created before question-only cards have it. */
  body?: string;
  /**
   * Question-only prompt: cards, phone alerts and attention panels show only the question. Any decision
   * context is the anchored feed message (`contextMessageId`), rendered as ordinary assistant text.
   */
  questionOnly?: boolean;
  /** History message holding this prompt's decision context; equals `messageId` when present. */
  contextMessageId?: string;
  suggestedAnswers?: string[];
  questions?: NeedsInputNotificationQuestion[];
  timestamp: number;
  /** Assistant message ID for jump-to-message links (null if no message was anchored) */
  messageId: string | null;
  /** Thread route for same-thread prompt matching. Main is explicit for new notifications. */
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
  done: boolean;
  /**
   * Why Takode itself made a leader thread unread: a newly settled answer, a published report
   * or a completed quest.
   * Absent on notifications an agent sent, and on older Thread Ready unread records.
   */
  unreadReason?: "answer" | "quest-complete" | "report";
  /** When the notification was last marked done (answered, read or dismissed); absent while open. */
  doneAt?: number;
  /** Muted unresolved needs-input prompts stay answerable but leave active attention counts. */
  muted?: boolean;
  mutedAt?: number;
  /** Snoozed prompts are muted until this time, then return as a fresh alert ("remind me later"). */
  snoozedUntil?: number;
  resolutionNotice?: {
    status: "pending" | "queued" | "delivered";
    source: "manual" | "response";
    resolvedAt: number;
    queuedInputId?: string;
    deliveredAt?: number;
  };
  /** Turn-end herd label recorded when this needs-input pause was surfaced. */
  herdDecisionWaitReportedAt?: number;
  /** Turn-end herd label recorded when the first later same-route external turn completed. */
  herdDecisionResumeReportedAt?: number;
}

// ─── Permission Request ──────────────────────────────────────────────────────

// ─── Permission Rule Types ───────────────────────────────────────────────────

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | {
      type: "addRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | {
      type: "replaceRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | {
      type: "removeRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | { type: "setMode"; mode: string; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  timestamp: number;
  /** Thread route used by leader/user prompt matching. Main is explicit for new prompt records. */
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
  slackThreadId?: string;
}

export type { CreationProgressEvent, CreationStepId } from "./session-creation-types.js";

// Takode orchestration (herd) event types live in their own module.
export type * from "./takode-event-types.js";
