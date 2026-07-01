import type { BackendType } from "./session-types.js";
import type { ModelAuthorityDecision, ModelProvenanceMigration } from "./model-identity-contract.js";
import type { CodexLeaderCompactionMode } from "../shared/codex-leader-compaction-mode.js";
import type { CodexMultiAgentVersion } from "../shared/codex-multi-agent-version.js";

export interface LaunchOptions {
  model?: string;
  /** Persisted explanation of the managed Codex model winner and overridden candidates. */
  modelAuthority?: ModelAuthorityDecision;
  /** Durable warning record when original Codex model provenance was unavailable. */
  modelProvenanceMigration?: ModelProvenanceMigration;
  /** Internal one-shot marker: this launch created the migration record rather than inheriting it. */
  modelProvenanceMigrationCreated?: boolean;
  permissionMode?: string;
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  /** Codex collaboration UI mode, kept separate from the permission profile. */
  uiMode?: "plan" | "agent";
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Codex reasoning effort (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Server-selected native Codex collaboration runtime version. */
  codexMultiAgentVersion?: CodexMultiAgentVersion;
  /** Server-resolved creator reference used to atomically validate normal worker attachment before spawn. */
  createdBySessionRef?: string;
  /** Codex app-server service tier for future turns. null/undefined means Standard. */
  codexServiceTier?: string | null;
  /** Optional Codex model context window override. */
  /** Desired usable context capacity; raw provider/catalog values are derived during Codex launch prep. */
  codexMaxContextLength?: number;
  /** Claude reasoning effort. */
  claudeReasoningEffort?: string;
  /** Claude max-context override; currently only the 1M beta path is supported. */
  claudeMaxContextLength?: number;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Deprecated compatibility setting; leader launch config is now derived from recycle thresholds. */
  codexLeaderContextWindowOverrideTokens?: number;
  /** Legacy compatibility only; leader thresholds are derived from source model effective context. */
  codexLeaderRecycleThresholdTokens?: number;
  /** Codex leader context management mode. Missing means the backward-compatible recycle mode. */
  codexLeaderCompactionMode?: CodexLeaderCompactionMode;
  /** Deprecated compatibility setting; non-leader compaction is left to Codex defaults. */
  codexNonLeaderAutoCompactThresholdPercent?: number;
  /** Docker container ID — when set, CLI runs inside container via docker exec */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
  /** Pre-resolved worktree info from the session creation flow */
  worktreeInfo?: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
    portTarget?: {
      repoRoot: string;
      branch: string;
      worktreePath?: string;
      sourceSessionId?: string;
      sourceSessionNum?: number | null;
      sourceLabel?: string;
    };
  };
  /** CLI session ID to resume (from an external CLI session, e.g. VS Code or terminal) */
  resumeCliSessionId?: string;
  /** Session whose Codex home may contain the rollout file for resumeCliSessionId. */
  codexResumeSourceSessionId?: string;
  /** Fail startup instead of falling back to a fresh Codex thread when resumeCliSessionId cannot be resumed. */
  requireResumeCliSessionId?: boolean;
  /** Plugin directories to load for SDK sessions (maps to --plugin-dir CLI flags). */
  pluginDirs?: string[];
  /** Extra instructions appended to the system prompt (e.g., orchestrator guardrails). */
  extraInstructions?: string;
  /** Authoritative Takode memory/session-space slug for default memory repo resolution. */
  memorySessionSpaceSlug?: string;
  /** Env profile slug used to resolve launch env, matching normal session creation. */
  envSlug?: string;
  /** Env keys removed after env profile resolution and before fresh session identity injection. */
  blockedEnvKeys?: string[];
  /** Skip writing the cwd-scoped CLI fallback auth file for sessions that should not become the local default caller. */
  skipSessionAuthFile?: boolean;
  /** Side Chat id for hidden thread sessions; persisted under the legacy slackThreadId field. */
  sideChatId?: string;
  /** Backward-compatible alias for sideChatId. */
  slackThreadId?: string;
  sideChatAnchorMessageId?: string;
  slackThreadAnchorMessageId?: string;
  sideChatAnchorHistoryIndex?: number;
  slackThreadAnchorHistoryIndex?: number;
  sideChatReadOnly?: boolean;
  slackThreadReadOnly?: boolean;
  /** Hidden implementation session omitted from normal session lists. */
  hidden?: boolean;
  /** Whether this session should consume a normal public #N session number. Defaults to true. */
  publicSessionNumber?: boolean;
  parentSessionId?: string;
  /** True when this is an orchestrator session (gets TAKODE_ROLE env). */
  isOrchestrator?: boolean;
}
