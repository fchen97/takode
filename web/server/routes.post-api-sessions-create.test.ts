import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock env-manager and git-utils modules before any imports
vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => Promise.resolve([])),
  getEnv: vi.fn(() => Promise.resolve(null)),
  getEffectiveImage: vi.fn(() => Promise.resolve(null)),
  createEnv: vi.fn(() => Promise.resolve(undefined)),
  updateEnv: vi.fn(() => Promise.resolve(undefined)),
  deleteEnv: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("node:child_process", () => {
  const execSyncMock = vi.fn((_cmd?: string) => "" as any);
  // exec mock: callback-based, delegates to execSync for consistent test behavior.
  // Attaches stdout/stderr to the error object so promisify(exec) can find them,
  // matching Node's custom exec promisify behavior.
  const execMock = vi.fn((...args: any[]) => {
    const cmd = args[0] as string;
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    try {
      const result = execSyncMock(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      const e = err as any;
      if (e.stdout === undefined) e.stdout = "";
      if (e.stderr === undefined) e.stderr = "";
      if (callback) callback(err, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
    }
  });
  const execFileMock = vi.fn((_file?: string, _args?: string[], _options?: any, callback?: any) => {
    if (typeof _options === "function") callback = _options;
    if (callback) callback(null, { stdout: "", stderr: "" });
  });
  return { execSync: execSyncMock, exec: execMock, execFile: execFileMock };
});

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string) => null as string | null));
const mockExpandTilde = vi.hoisted(() => vi.fn((p: string) => p)); // pass-through by default
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((_varNames: string[]) => ({}) as Record<string, string>));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  expandTilde: mockExpandTilde,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
    access: vi.fn(async () => {}), // default: file exists (no throw)
  };
});

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  getRepoInfoAsync: vi.fn(async () => null),
  listBranches: vi.fn(() => []),
  listBranchesAsync: vi.fn(async () => []),
  listWorktrees: vi.fn(() => []),
  listWorktreesAsync: vi.fn(async () => []),
  ensureWorktree: vi.fn(),
  ensureWorktreeAsync: vi.fn(),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitFetchAsync: vi.fn(async () => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  gitPullAsync: vi.fn(async () => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
  checkoutBranchAsync: vi.fn(async () => {}),
  removeWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn(async () => ({ removed: true })),
  isWorktreeDirty: vi.fn(() => false),
  isWorktreeDirtyAsync: vi.fn(async () => false),
  archiveBranchAsync: vi.fn(async () => true),
  resolveDefaultBranch: vi.fn(() => "main"),
  getBranchStatus: vi.fn(() => ({ ahead: 0, behind: 0 })),
  deleteArchivedRefAsync: vi.fn(async () => {}),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
  getNextLeaderNumber: vi.fn(() => 1),
  _resetForTest: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: "",
    pushoverApiToken: "",
    pushoverDelaySeconds: 30,
    pushoverEnabled: true,
    pushoverEventFilters: { needsInput: true, review: true, error: true },
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    heavyRepoModeEnabled: false,
    autoApprovalEnabled: false,
    autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4,
    autoApprovalTimeoutSeconds: 45,
    namerConfig: { backend: "claude" },
    autoNamerEnabled: true,
    transcriptionConfig: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: { editor: "none" },
    defaultClaudeBackend: "claude",
    sleepInhibitorEnabled: false,
    sleepInhibitorDurationMinutes: 5,
    questmasterViewMode: "cards",
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: patch.pushoverUserKey ?? "",
    pushoverApiToken: patch.pushoverApiToken ?? "",
    pushoverDelaySeconds: patch.pushoverDelaySeconds ?? 30,
    pushoverEnabled: patch.pushoverEnabled ?? true,
    pushoverEventFilters: patch.pushoverEventFilters ?? { needsInput: true, review: true, error: true },
    pushoverBaseUrl: patch.pushoverBaseUrl ?? "",
    claudeBinary: patch.claudeBinary ?? "",
    codexBinary: patch.codexBinary ?? "",
    maxKeepAlive: patch.maxKeepAlive ?? 0,
    heavyRepoModeEnabled: patch.heavyRepoModeEnabled ?? false,
    autoApprovalEnabled: patch.autoApprovalEnabled ?? false,
    autoApprovalModel: patch.autoApprovalModel ?? "haiku",
    autoApprovalMaxConcurrency: patch.autoApprovalMaxConcurrency ?? 4,
    autoApprovalTimeoutSeconds: patch.autoApprovalTimeoutSeconds ?? 45,
    namerConfig: patch.namerConfig ?? { backend: "claude" },
    autoNamerEnabled: patch.autoNamerEnabled ?? true,
    transcriptionConfig: patch.transcriptionConfig ?? {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: patch.editorConfig ?? { editor: "none" },
    defaultClaudeBackend: patch.defaultClaudeBackend ?? "claude",
    sleepInhibitorEnabled: patch.sleepInhibitorEnabled ?? false,
    sleepInhibitorDurationMinutes: patch.sleepInhibitorDurationMinutes ?? 5,
    questmasterViewMode: patch.questmasterViewMode ?? "cards",
    updatedAt: Date.now(),
  })),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server-id"),
  getClaudeUserDefaultModel: vi.fn(async () => ""),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestratorSystemPrompt, createRoutes } from "./routes.js";
import { _resetModelCache } from "./routes/system.js";
import { trafficStats } from "./traffic-stats.js";
import { _resetServerLoggerForTest, createLogger, initServerLogger } from "./server-logger.js";
import * as serverLoggerModule from "./server-logger.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as questStore from "./quest-store.js";
import * as sessionNames from "./session-names.js";
import * as settingsManager from "./settings-manager.js";
import * as transcriptionEnhancer from "./transcription-enhancer.js";
import * as treeGroupStore from "./tree-group-store.js";
import { containerManager } from "./container-manager.js";
import { DEFAULT_SESSION_DEFAULTS } from "../shared/session-defaults.js";
import { _resetCodexModelCatalogCacheForTest, loadCodexModelCatalog } from "./codex-model-catalog.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    isAlive: vi.fn(() => true),
    relaunch: vi.fn(async () => ({ ok: true })),
    relaunchWithResumeAt: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(),
    setArchived: vi.fn(),
    setWorktreeCleanupState: vi.fn(),
    updateWorktree: vi.fn(),
    removeSession: vi.fn(),
    getOrchestratorGuardrails: vi.fn(() => "# Takode — Cross-Session Orchestration\n..."),
    getPort: vi.fn(() => 3456),
    getMemorySessionSpaceSlug: vi.fn(() => "Takode"),
    setMemorySessionSpaceSlug: vi.fn(() => false),
    verifySessionAuthToken: vi.fn(() => true),
    herdSessions: vi.fn(() => ({ herded: [], notFound: [], conflicts: [], reassigned: [], leaders: [] })),
    unherdSession: vi.fn(() => false),
    getHerdedSessions: vi.fn(() => []),
    // resolveSessionId: pass-through for exact UUIDs (used by resolveId helper in routes)
    resolveSessionId: vi.fn((id: string) => id),
    getSessionNum: vi.fn(() => undefined),
  } as any;
}

function createMockBridge() {
  return {
    _sessions: {} as Record<string, any>,
    _vscodeSelectionState: null as any,
    _vscodeWindows: [] as any[],
    closeSession: vi.fn(),
    getSession: vi.fn(function (this: any, sessionId: string) {
      if (sessionId in this._sessions) return this._sessions[sessionId];
      const stateEntries = this.getAllSessions();
      const stateEntry = Array.isArray(stateEntries)
        ? stateEntries.find((entry: any) => entry?.session_id === sessionId || entry?.sessionId === sessionId)
        : null;
      const messageHistory = this.getMessageHistory(sessionId) ?? [];
      if (!stateEntry && messageHistory.length === 0) {
        return null;
      }
      return {
        id: sessionId,
        state: stateEntry?.state ?? stateEntry ?? {},
        messageHistory,
        notifications: [],
        pendingPermissions: new Map(),
        taskHistory: [],
        keywords: [],
        lastReadAt: 0,
        attentionReason: null,
        isGenerating: false,
      };
    }),
    getOrCreateSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    refreshWorktreeGitStateForSnapshot: vi.fn(async () => null),
    getLastUserMessage: vi.fn(() => undefined),
    isBackendConnected: vi.fn(() => false),
    markWorktree: vi.fn(),
    applyInitialSessionState: vi.fn(),
    setDiffBaseBranch: vi.fn(() => true),
    refreshGitInfoPublic: vi.fn(async () => true),
    onSessionArchived: vi.fn(),
    onSessionUnarchived: vi.fn(),
    persistSessionById: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
    getVsCodeSelectionState: vi.fn(function (this: any) {
      return this._vscodeSelectionState;
    }),
    updateVsCodeSelectionState: vi.fn(function (this: any, state: any) {
      this._vscodeSelectionState = state;
      return true;
    }),
    getVsCodeWindowStates: vi.fn(function (this: any) {
      return this._vscodeWindows;
    }),
    upsertVsCodeWindowState: vi.fn(function (this: any, state: any) {
      const next = {
        ...state,
        workspaceRoots: [...(state.workspaceRoots ?? [])],
        lastSeenAt: 9999,
      };
      this._vscodeWindows = [...this._vscodeWindows.filter((window: any) => window.sourceId !== state.sourceId), next];
      return next;
    }),
    pollVsCodeOpenFileCommands: vi.fn(() => []),
    resolveVsCodeOpenFileResult: vi.fn(() => true),
    requestVsCodeOpenFile: vi.fn(async () => ({ sourceId: "window-a", commandId: "cmd-1" })),
    addTaskEntry: vi.fn(),
    updateQuestTaskEntries: vi.fn(),
    removeBoardRowFromAll: vi.fn(),
    prepareSessionForRevert: vi.fn(
      (sessionId: string, truncateIdx: number, options?: { clearCodexState?: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        if (!session) return null;
        session.messageHistory = session.messageHistory.slice(0, truncateIdx);
        session.frozenCount = Math.min(session.frozenCount ?? 0, session.messageHistory.length);
        session.assistantAccumulator?.clear?.();
        session.pendingMessages = [];
        session.lastOutboundUserNdjson = null;
        session.userMessageIdsThisTurn = [];
        session.queuedTurnStarts = 0;
        session.queuedTurnReasons = [];
        session.queuedTurnUserMessageIds = [];
        session.queuedTurnInterruptSources = [];
        session.interruptedDuringTurn = false;
        session.interruptSourceDuringTurn = null;
        session.isGenerating = false;
        session.generationStartedAt = null;
        session.disconnectWasGenerating = false;
        session.seamlessReconnect = false;
        session.toolStartTimes?.clear?.();
        session.toolProgressOutput?.clear?.();
        session.dropReplayHistoryAfterRevert = session.backendType === "claude" || session.backendType === "claude-sdk";
        session.pendingPermissions?.clear?.();
        session.eventBuffer = [];
        session.awaitingCompactSummary = false;
        session.claudeCompactBoundarySeen = false;
        session.compactedDuringTurn = false;
        session.forceCompactPending = false;
        if (session.state) session.state.is_compacting = false;
        if (options?.clearCodexState) {
          session.pendingCodexTurns = [];
          session.pendingCodexInputs = [];
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = null;
          if (session.optimisticRunningTimer) session.optimisticRunningTimer = null;
          bridge.broadcastToSession(sessionId, { type: "codex_pending_inputs", inputs: [] });
        }
        bridge.broadcastToSession(sessionId, { type: "permissions_cleared" });
        return session;
      },
    ),
    beginCodexRollback: vi.fn(
      (sessionId: string, plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        const adapter = session?.codexAdapter;
        if (adapter?.isConnected?.() && adapter.rollbackTurns) {
          return {
            promise: adapter.rollbackTurns(plan.numTurns).then(() => {
              const reverted = bridge.prepareSessionForRevert(sessionId, plan.truncateIdx, {
                clearCodexState: plan.clearCodexState,
              });
              bridge.persistSessionSync(sessionId);
              bridge.broadcastToSession(sessionId, { type: "message_history", messages: reverted.messageHistory });
              bridge.broadcastToSession(sessionId, { type: "status_change", status: "idle" });
            }),
            requiresRelaunch: false,
          };
        }
        return { promise: Promise.resolve(), requiresRelaunch: true };
      },
    ),
    persistSessionSync: vi.fn(),
    getMessageHistory: vi.fn(() => []),
    getToolResult: vi.fn(() => null),
    injectUserMessage: vi.fn(() => "sent" as const),
    emitTakodeEvent: vi.fn(),
    subscribeTakodeEvents: vi.fn(() => () => {}),
    routeExternalPermissionResponse: vi.fn(),
    routeExternalInterrupt: vi.fn(async () => {}),
    routeBrowserMessage: vi.fn(function (this: any, session: any, msg: any) {
      if (msg?.type === "permission_response") {
        return this.routeExternalPermissionResponse(
          session,
          {
            type: "permission_response",
            request_id: msg.request_id,
            behavior: msg.behavior,
            ...(msg.updated_input ? { updated_input: msg.updated_input } : {}),
            ...(msg.message ? { message: msg.message } : {}),
          },
          msg.actorSessionId,
        );
      }
      if (msg?.type === "interrupt") {
        return this.routeExternalInterrupt(session, msg.interruptSource);
      }
      return undefined;
    }),
    getTrafficStatsSnapshot: vi.fn(() => ({
      windowStartedAt: 1000,
      capturedAt: 2000,
      totals: { messages: 1, payloadBytes: 10, wireBytes: 10 },
      buckets: [],
      sessions: {},
      historySyncBreakdown: {
        totals: {
          requests: 0,
          frozenDeltaBytes: 0,
          hotMessagesBytes: 0,
          frozenDeltaMessages: 0,
          hotMessagesCount: 0,
        },
        sessions: {},
      },
      toolResultFetches: {
        totals: { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 },
        sessions: {},
        topRepeated: [],
      },
    })),
    resetTrafficStats: vi.fn(),
  } as any;
}

function ensureBridgeSession(
  bridge: ReturnType<typeof createMockBridge>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return (bridge._sessions[sessionId] = {
    id: sessionId,
    state: {},
    browserSockets: new Set(),
    messageHistory: [],
    notifications: [],
    pendingPermissions: new Map(),
    taskHistory: [],
    keywords: [],
    lastReadAt: 0,
    attentionReason: null,
    isGenerating: false,
    ...overrides,
  });
}

function createMockStore() {
  return {
    setArchived: vi.fn(async () => true),
    flushAll: vi.fn(async () => {}),
  } as any;
}

function createMockRecorder() {
  return {
    getRecordingsDir: vi.fn(() => "/tmp/companion-recordings"),
    isGloballyEnabled: vi.fn(() => true),
    getMaxLines: vi.fn(() => 500000),
    isRecording: vi.fn(() => true),
    getRecordingStatus: vi.fn(() => ({ filePath: "/tmp/companion-recordings/session-1.jsonl" })),
    enableForSession: vi.fn(),
    disableForSession: vi.fn(),
    listRecordings: vi.fn(async () => []),
  } as any;
}

function createMockTimerManager() {
  return {
    createTimer: vi.fn(),
    listTimers: vi.fn(() => []),
    cancelTimer: vi.fn(async () => true),
    cancelAllTimers: vi.fn(async () => {}),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let app: Hono;
let launcher: ReturnType<typeof createMockLauncher>;
let bridge: ReturnType<typeof createMockBridge>;
let sessionStore: ReturnType<typeof createMockStore>;
let tracker: ReturnType<typeof createMockTracker>;
let recorder: ReturnType<typeof createMockRecorder>;
let timerManager: ReturnType<typeof createMockTimerManager>;
let treeGroupTempDir: string;
let homeDir: string;
let streamsDir: string;

async function cacheInstalledCodexModelsForTest(models: Array<Record<string, unknown>>): Promise<void> {
  await loadCodexModelCatalog({
    codexBinary: "/fake/codex",
    statImpl: (async () => ({ mtimeMs: 1, size: 1 })) as never,
    runCodexCommand: async (_binary, args) => ({
      stdout: args[0] === "--version" ? "codex-cli test" : JSON.stringify({ models }),
    }),
  });
}

function overrideSettingsForTest(sessionDefaults: typeof DEFAULT_SESSION_DEFAULTS): () => void {
  const originalGetSettings = vi.mocked(settingsManager.getSettings).getMockImplementation();
  vi.mocked(settingsManager.getSettings).mockImplementation(() => ({
    ...(originalGetSettings?.() ?? settingsManager.getSettings()),
    sessionDefaults,
  }));
  return () => {
    if (originalGetSettings) vi.mocked(settingsManager.getSettings).mockImplementation(originalGetSettings);
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  trafficStats.reset();
  _resetServerLoggerForTest();
  // Reset the LiteLLM model cache so each test starts clean.
  _resetModelCache();
  _resetCodexModelCatalogCacheForTest();
  // Stub global fetch to prevent LiteLLM proxy calls in tests.
  // Model endpoint tests exercise the fallback path (models_cache.json).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no proxy in tests"))),
  );
  homeDir = mkdtempSync(join(tmpdir(), "routes-create-home-"));
  vi.stubEnv("HOME", homeDir);
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  recorder = createMockRecorder();
  timerManager = createMockTimerManager();
  treeGroupTempDir = mkdtempSync(join(tmpdir(), "routes-create-tree-groups-"));
  treeGroupStore._resetForTest(join(treeGroupTempDir, "tree-groups.json"));
  streamsDir = (await import("./stream-store.js")).getStreamsDir();
  rmSync(streamsDir, { recursive: true, force: true });
  app = new Hono();
  const terminalManager = { getInfo: () => null, spawn: () => "", kill: () => {} } as any;
  app.route(
    "/api",
    createRoutes(
      launcher,
      bridge,
      sessionStore,
      tracker,
      terminalManager,
      undefined,
      recorder,
      undefined,
      timerManager,
    ),
  );

  // Default no-op mocks for container workspace isolation (called during container session creation)
  vi.spyOn(containerManager, "copyWorkspaceToContainer").mockResolvedValue(undefined);
  vi.spyOn(containerManager, "reseedGitAuth").mockImplementation(() => {});
});

afterEach(async () => {
  await treeGroupStore._flushForTest();
  _resetCodexModelCatalogCacheForTest();
  vi.unstubAllEnvs();
  rmSync(treeGroupTempDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(streamsDir, { recursive: true, force: true });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

// ─── SSE Session Creation Streaming ──────────────────────────────────────────
/** Parse an SSE response body into an array of {event, data} objects */
async function parseSSE(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const events: { event: string; data: string }[] = [];
  // SSE frames are separated by double newlines
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) events.push({ event, data });
  }
  return events;
}

describe("POST /api/sessions/create", () => {
  it("launches a session and returns its info", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ sessionId: "session-1", state: "starting", cwd: "/test" });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    );
  });

  it("skips fallback auth writes for leader-created non-worktree child sessions", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", createdBy: "leader-1", useWorktree: false }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/test",
        skipSessionAuthFile: true,
      }),
    );
  });

  it("preserves fallback auth writes for leader-created worktree child sessions", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/test-wt-child",
      actualBranch: "main-wt-child",
      created: true,
    } as any);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", createdBy: "leader-1", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/test-wt-child",
        skipSessionAuthFile: false,
      }),
    );
  });

  it("applies centralized Codex session defaults when create fields are omitted", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: {
        ...DEFAULT_SESSION_DEFAULTS.codex,
        model: "gpt-5.4",
        serviceTier: "priority",
        reasoningEffort: "max",
        internetAccess: true,
        maxContextLength: 240_000,
      },
      claude: DEFAULT_SESSION_DEFAULTS.claude,
    });

    let res: Response;
    try {
      res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "codex", cwd: "/test" }),
      });
    } finally {
      restoreSettings();
    }

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        model: "gpt-5.4",
        codexServiceTier: "priority",
        codexReasoningEffort: "max",
        codexInternetAccess: true,
        codexMaxContextLength: 240_000,
      }),
    );
  });

  it.each([
    ["leader-created worker", { createdBy: "leader-1" }, "v2"],
    ["archived-leader reference", { createdBy: "leader-archived" }, "v1"],
    ["manual session", {}, "v1"],
    ["leader", { role: "orchestrator" }, "v1"],
    ["reviewer", { createdBy: "leader-1", reviewerOf: 42 }, "v1"],
    ["external resume", { createdBy: "leader-1", resumeCliSessionId: "existing-thread" }, "v1"],
  ] as const)("selects %s multi-agent launch authority", async (_label, body, expectedVersion) => {
    // Only a normal Codex worker whose creator resolves to a real leader receives V2.
    launcher.getSession.mockImplementation((id: string) => {
      if (id === "leader-1") return { sessionId: id, isOrchestrator: true };
      if (id === "leader-archived") return { sessionId: id, isOrchestrator: true, archived: true };
      return undefined;
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "codex", cwd: "/test", ...body }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ codexMultiAgentVersion: expectedVersion }));
  });

  it("rejects a known Codex model-effort combination the installed catalog does not support", async () => {
    // Server validation is authoritative for UI, CLI spawn, and replacement callers;
    // a known model must fail before launcher state is created.
    await cacheInstalledCodexModelsForTest([
      {
        slug: "gpt-limited",
        display_name: "GPT Limited",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
    ]);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "codex",
        cwd: "/test",
        model: "gpt-limited",
        codexReasoningEffort: "ultra",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Codex reasoning effort "ultra" is not supported by model "gpt-limited" (supported: low, high)',
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("applies independent leader Codex defaults for orchestrator creation", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: { ...DEFAULT_SESSION_DEFAULTS.codex, model: "worker-model" },
      leaderUsesWorkerDefaults: false,
      leader: {
        codex: {
          ...DEFAULT_SESSION_DEFAULTS.leader.codex,
          model: "leader-model",
          serviceTier: "priority",
          reasoningEffort: "ultra",
          internetAccess: true,
          maxContextLength: 600_000,
        },
        claude: DEFAULT_SESSION_DEFAULTS.leader.claude,
      },
    });

    try {
      const res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "codex", cwd: "/test", role: "orchestrator" }),
      });
      expect(res.status).toBe(200);
    } finally {
      restoreSettings();
    }

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "leader-model",
        codexServiceTier: "priority",
        codexReasoningEffort: "ultra",
        codexInternetAccess: true,
        codexMaxContextLength: 600_000,
        isOrchestrator: true,
      }),
    );
  });

  it("dynamically uses current worker defaults for shared leader creation", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: { ...DEFAULT_SESSION_DEFAULTS.codex, model: "current-worker-model", reasoningEffort: "high" },
      leaderUsesWorkerDefaults: true,
      leader: {
        codex: { ...DEFAULT_SESSION_DEFAULTS.leader.codex, model: "retained-independent-model" },
        claude: DEFAULT_SESSION_DEFAULTS.leader.claude,
      },
    });

    try {
      const res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "codex", cwd: "/test", role: "orchestrator" }),
      });
      expect(res.status).toBe(200);
    } finally {
      restoreSettings();
    }

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "current-worker-model", codexReasoningEffort: "high" }),
    );
    expect(launcher.launch).not.toHaveBeenCalledWith(expect.objectContaining({ model: "retained-independent-model" }));
  });

  it("keeps explicit create fields ahead of centralized Codex defaults", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: {
        ...DEFAULT_SESSION_DEFAULTS.codex,
        model: "gpt-5.4",
        serviceTier: "priority",
        reasoningEffort: "high",
        internetAccess: true,
        maxContextLength: 240_000,
      },
      claude: DEFAULT_SESSION_DEFAULTS.claude,
    });

    let res: Response;
    try {
      res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend: "codex",
          cwd: "/test",
          role: "orchestrator",
          model: "gpt-5",
          codexServiceTier: null,
          codexReasoningEffort: "ultra",
          codexInternetAccess: false,
          codexMaxContextLength: 180_000,
        }),
      });
    } finally {
      restoreSettings();
    }

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5",
        codexServiceTier: null,
        codexReasoningEffort: "ultra",
        codexInternetAccess: false,
        codexMaxContextLength: 180_000,
      }),
    );
  });

  it("applies centralized Claude session defaults when create fields are omitted", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: DEFAULT_SESSION_DEFAULTS.codex,
      claude: {
        ...DEFAULT_SESSION_DEFAULTS.claude,
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "acceptEdits",
        reasoningEffort: "max",
        maxContextLength: 1_000_000,
      },
    });

    let res: Response;
    try {
      res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "claude", cwd: "/test" }),
      });
    } finally {
      restoreSettings();
    }

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "claude",
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "acceptEdits",
        claudeReasoningEffort: "max",
        claudeMaxContextLength: 1_000_000,
      }),
    );
  });

  it("applies independent leader Claude defaults for orchestrator creation", async () => {
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      leaderUsesWorkerDefaults: false,
      leader: {
        codex: DEFAULT_SESSION_DEFAULTS.leader.codex,
        claude: {
          ...DEFAULT_SESSION_DEFAULTS.leader.claude,
          model: "claude-opus-4-6",
          permissionMode: "bypassPermissions",
          reasoningEffort: "high",
          maxContextLength: 1_000_000,
        },
      },
    });

    try {
      const res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "claude", cwd: "/test", role: "orchestrator" }),
      });
      expect(res.status).toBe(200);
    } finally {
      restoreSettings();
    }

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-6",
        permissionMode: "bypassPermissions",
        claudeReasoningEffort: "high",
        claudeMaxContextLength: 1_000_000,
        isOrchestrator: true,
      }),
    );
  });

  it("rejects unsupported Claude max context overrides during session creation", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "claude", cwd: "/test", claudeMaxContextLength: 200_000 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "claudeMaxContextLength currently supports only 1000000 or empty",
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("persists explicit default tree group metadata during session creation", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.applyInitialSessionState).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ treeGroupId: "default" }),
    );
    expect(await treeGroupStore.getGroupForSession("session-1")).toBe("default");
  });

  it("persists tree group assignment during session creation", async () => {
    // The server must persist group membership as part of creation so a restart
    // cannot drop a newly-created grouped session back into Default.
    const group = await treeGroupStore.createGroup("Takode");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", treeGroupId: group.id }),
    });

    expect(res.status).toBe(200);
    expect(bridge.applyInitialSessionState).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ treeGroupId: group.id }),
    );
    expect(await treeGroupStore.getGroupForSession("session-1")).toBe(group.id);
    await treeGroupStore._flushForTest();

    treeGroupStore._resetForTest(join(treeGroupTempDir, "tree-groups.json"));
    expect(await treeGroupStore.getGroupForSession("session-1")).toBe(group.id);
  });

  it("uses the requested tree group name as the default memory session-space for Codex leaders", async () => {
    const group = await treeGroupStore.createGroup("MSI");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "codex",
        role: "orchestrator",
        cwd: "/test",
        treeGroupId: group.id,
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        memorySessionSpaceSlug: "MSI",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
        }),
      }),
    );
    expect(bridge.applyInitialSessionState).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        treeGroupId: group.id,
        memorySessionSpaceSlug: "MSI",
      }),
    );
  });

  it("keeps an explicit memory session-space slug when creating inside a different tree group", async () => {
    const group = await treeGroupStore.createGroup("MSI");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        treeGroupId: group.id,
        memorySessionSpaceSlug: "ExplicitSpace",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySessionSpaceSlug: "ExplicitSpace",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "ExplicitSpace",
        }),
      }),
    );
  });

  it("uses the creator tree group as the default memory session-space for spawned sessions", async () => {
    const group = await treeGroupStore.createGroup("MSI");
    ensureBridgeSession(bridge, "leader-msi", { state: { treeGroupId: group.id } });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        createdBy: "leader-msi",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySessionSpaceSlug: "MSI",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
        }),
      }),
    );
    expect(bridge.applyInitialSessionState).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        treeGroupId: group.id,
        memorySessionSpaceSlug: "MSI",
      }),
    );
  });

  it("keeps an explicit requested tree group visually authoritative when also spawned by a leader", async () => {
    // A create request can be both a leader spawn and an explicit placement into
    // another session space. The requested tree group must stay authoritative so
    // the visible group and default memory repo cannot diverge after launch.
    const leaderGroup = await treeGroupStore.createGroup("Takode");
    const requestedGroup = await treeGroupStore.createGroup("MSI");
    ensureBridgeSession(bridge, "leader-takode", { state: { treeGroupId: leaderGroup.id } });
    launcher.getSession.mockImplementation((id: string) =>
      id === "leader-takode" ? { sessionId: id, isOrchestrator: true } : undefined,
    );

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        createdBy: "leader-takode",
        treeGroupId: requestedGroup.id,
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySessionSpaceSlug: "MSI",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
        }),
      }),
    );
    expect(launcher.herdSessions).toHaveBeenCalledWith("leader-takode", ["session-1"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.applyInitialSessionState).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        treeGroupId: requestedGroup.id,
        memorySessionSpaceSlug: "MSI",
      }),
    );
    expect(await treeGroupStore.getGroupForSession("session-1")).toBe(requestedGroup.id);
    expect(await treeGroupStore.getGroupForSession("session-1")).not.toBe(leaderGroup.id);
  });

  it("syncs session metadata and assignment index on manual reassignment", async () => {
    const group = await treeGroupStore.createGroup("Reassigned");
    ensureBridgeSession(bridge, "s1", { state: { treeGroupId: "default" } });
    await treeGroupStore.assignSession("s1", "default");
    const streamStore = await import("./stream-store.js");
    const defaultScope = streamStore.streamScopeForSessionGroup("default", "test-server-id");
    const destinationScope = streamStore.streamScopeForSessionGroup(group.id, "test-server-id");
    await streamStore.createStream({ title: "Shared memory", scope: defaultScope, summary: "Source stream" });
    await streamStore.createStream({ title: "Shared memory", scope: destinationScope, summary: "Collision target" });

    const res = await app.request("/api/tree-groups/assign", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", groupId: group.id }),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["s1"].state.treeGroupId).toBe(group.id);
    expect(bridge._sessions["s1"].state.memorySessionSpaceSlug).toBe("Reassigned");
    expect(launcher.setMemorySessionSpaceSlug).toHaveBeenCalledWith("s1", "Reassigned");
    expect(bridge.persistSessionById).toHaveBeenCalledWith("s1");
    expect(await treeGroupStore.getGroupForSession("s1")).toBe(group.id);
    expect(await streamStore.listStreams({ scope: defaultScope, includeArchived: true })).toEqual([]);
    expect(
      (await streamStore.listStreams({ scope: destinationScope, includeArchived: true }))
        .map((stream) => stream.title)
        .sort(),
    ).toEqual(["Default-Shared memory", "Shared memory"]);
  });

  it("syncs session metadata and assignment index on bulk reassignment", async () => {
    const group = await treeGroupStore.createGroup("Bulk Reassigned");
    ensureBridgeSession(bridge, "s1", { state: { treeGroupId: "default" } });
    ensureBridgeSession(bridge, "s2", { state: { treeGroupId: "default" } });
    await treeGroupStore.assignSession("s1", "default");
    await treeGroupStore.assignSession("s2", "default");

    const res = await app.request("/api/tree-groups/assign", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: ["s1", "s2"], groupId: group.id }),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["s1"].state.treeGroupId).toBe(group.id);
    expect(bridge._sessions["s2"].state.treeGroupId).toBe(group.id);
    expect(bridge.persistSessionById).toHaveBeenCalledWith("s1");
    expect(bridge.persistSessionById).toHaveBeenCalledWith("s2");
    expect(await treeGroupStore.getGroupForSession("s1")).toBe(group.id);
    expect(await treeGroupStore.getGroupForSession("s2")).toBe(group.id);
    await treeGroupStore._flushForTest();

    treeGroupStore._resetForTest(join(treeGroupTempDir, "tree-groups.json"));
    expect(await treeGroupStore.getGroupForSession("s1")).toBe(group.id);
    expect(await treeGroupStore.getGroupForSession("s2")).toBe(group.id);
  });

  it("keeps existing shared-group streams in the source group when another session remains", async () => {
    const group = await treeGroupStore.createGroup("Reassigned");
    ensureBridgeSession(bridge, "s1", { state: { treeGroupId: "default" } });
    ensureBridgeSession(bridge, "s2", { state: { treeGroupId: "default" } });
    await treeGroupStore.assignSession("s1", "default");
    await treeGroupStore.assignSession("s2", "default");
    const streamStore = await import("./stream-store.js");
    const defaultScope = streamStore.streamScopeForSessionGroup("default", "test-server-id");
    const destinationScope = streamStore.streamScopeForSessionGroup(group.id, "test-server-id");
    await streamStore.createStream({ title: "Shared memory", scope: defaultScope, summary: "Shared source stream" });

    const res = await app.request("/api/tree-groups/assign", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", groupId: group.id }),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["s1"].state.treeGroupId).toBe(group.id);
    expect(await treeGroupStore.getGroupForSession("s1")).toBe(group.id);
    expect(await treeGroupStore.getGroupForSession("s2")).toBe("default");
    expect(
      (await streamStore.listStreams({ scope: defaultScope, includeArchived: true })).map((stream) => stream.title),
    ).toEqual(["Shared memory"]);
    expect(await streamStore.listStreams({ scope: destinationScope, includeArchived: true })).toEqual([]);
    expect(await streamStore.defaultStreamScope("/tmp/moved-session", "test-server-id", "s1")).toBe(destinationScope);
  });

  it("reassigns affected sessions to explicit default when deleting a group", async () => {
    const group = await treeGroupStore.createGroup("To Delete");
    ensureBridgeSession(bridge, "s1", { state: { treeGroupId: group.id } });
    launcher.listSessions.mockReturnValue([{ sessionId: "s1" }]);
    await treeGroupStore.assignSession("s1", group.id);
    const streamStore = await import("./stream-store.js");
    const sourceScope = streamStore.streamScopeForSessionGroup(group.id, "test-server-id");
    const defaultScope = streamStore.streamScopeForSessionGroup("default", "test-server-id");
    await streamStore.createStream({ title: "Keep me", scope: sourceScope, summary: "Migrated on delete" });

    const res = await app.request(`/api/tree-groups/groups/${group.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["s1"].state.treeGroupId).toBe("default");
    expect(await treeGroupStore.getGroupForSession("s1")).toBe("default");
    expect(await streamStore.listStreams({ scope: sourceScope, includeArchived: true })).toEqual([]);
    expect(
      (await streamStore.listStreams({ scope: defaultScope, includeArchived: true })).map((stream) => stream.title),
    ).toEqual(["Keep me"]);
  });

  it("injects environment variables when envSlug is provided", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Production",
      slug: "production",
      variables: { API_KEY: "secret123", DB_HOST: "db.example.com" },
      createdAt: 1000,
      updatedAt: 1000,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "production" }),
    });

    expect(res.status).toBe(200);
    expect(envManager.getEnv).toHaveBeenCalledWith("production");
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ API_KEY: "secret123", DB_HOST: "db.example.com" }),
      }),
    );
  });

  it("ignores branch for non-worktree create without syncing or mutating the checkout", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).not.toHaveBeenCalled();
    expect(gitUtils.getRepoInfoAsync).not.toHaveBeenCalled();
    expect(gitUtils.gitFetch).not.toHaveBeenCalled();
    expect(gitUtils.gitPull).not.toHaveBeenCalled();
    expect(gitUtils.checkoutBranch).not.toHaveBeenCalled();
    expect(gitUtils.gitFetchAsync).not.toHaveBeenCalled();
    expect(gitUtils.checkoutBranchAsync).not.toHaveBeenCalled();
    expect(gitUtils.gitPullAsync).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo" }));
  });

  it("sets up a worktree for orchestrator create when requested", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "project",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/project/main-wt-1001",
      branch: "main",
      actualBranch: "main-wt-1001",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main", useWorktree: true, role: "orchestrator" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfoAsync).toHaveBeenCalledWith("/repo");
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(gitUtils.gitFetchAsync).not.toHaveBeenCalled();
    expect(gitUtils.checkoutBranchAsync).not.toHaveBeenCalled();
    expect(gitUtils.gitPullAsync).not.toHaveBeenCalled();
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/home/.companion/worktrees/project/main-wt-1001",
        worktreeInfo: expect.objectContaining({
          branch: "main",
          actualBranch: "main-wt-1001",
          portTarget: expect.objectContaining({ repoRoot: "/repo", branch: "main-wt-1001" }),
        }),
      }),
    );
  });

  it("returns 500 when launch throws an error", async () => {
    launcher.launch.mockImplementation(() => {
      throw new Error("CLI binary not found");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "CLI binary not found" });
  });

  it("returns 400 for invalid backend values", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "invalid-backend" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid backend");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("injects COMPANION_PORT for resumed sessions", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "claude",
        cwd: "/test",
        resumeCliSessionId: "cli-resume-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "cli-resume-1",
        env: expect.objectContaining({
          COMPANION_PORT: "3456",
        }),
      }),
    );
  });

  it("applies Worker Defaults to external Codex resume launch settings", async () => {
    // External resume uses the same server-owned role defaults as normal and
    // replacement creation, while the app-server response remains effective authority.
    const restoreSettings = overrideSettingsForTest({
      ...DEFAULT_SESSION_DEFAULTS,
      codex: {
        ...DEFAULT_SESSION_DEFAULTS.codex,
        model: "gpt-5.6-sol",
        serviceTier: "priority",
        reasoningEffort: "ultra",
        internetAccess: true,
        maxContextLength: 760_000,
      },
    });
    try {
      const res = await app.request("/api/sessions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend: "codex",
          cwd: "/test",
          resumeCliSessionId: "codex-resume-with-defaults",
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      restoreSettings();
    }

    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "codex-resume-with-defaults",
        model: "gpt-5.6-sol",
        codexReasoningEffort: "ultra",
        codexServiceTier: "priority",
        codexInternetAccess: true,
        codexMaxContextLength: 760_000,
      }),
    );
  });

  it("always resolves an explicit managed model for resumed Codex sessions", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "codex",
        cwd: "/test",
        resumeCliSessionId: "codex-resume-model-authority",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "codex-resume-model-authority",
        model: "gpt-5.6-sol",
        modelAuthority: expect.objectContaining({
          model: "gpt-5.6-sol",
          source: "managed_fallback",
        }),
        modelProvenanceMigrationCreated: true,
        modelProvenanceMigration: expect.objectContaining({
          source: "external_resume",
          selectedModel: "gpt-5.6-sol",
          warning: expect.stringContaining("Original model provenance was unavailable"),
        }),
      }),
    );
  });

  it("preserves an explicit external-resume model without a migration warning", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "codex",
        cwd: "/test",
        model: "gpt-5.6-terra",
        resumeCliSessionId: "codex-resume-explicit-authority",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        modelAuthority: expect.objectContaining({ source: "explicit_request" }),
      }),
    );
    expect(launcher.launch.mock.calls[0][0]).not.toHaveProperty("modelProvenanceMigration");
  });

  it("sets up a worktree when useWorktree and branch are specified", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      branch: "feat-branch",
      actualBranch: "feat-branch",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "feat-branch", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).not.toHaveBeenCalled();
    expect(gitUtils.ensureWorktree).not.toHaveBeenCalled();
    // ensureWorktree should be called with forceNew: true
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "feat-branch", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    // launcher should receive the worktree path as cwd
    expect(launcher.launch).toHaveBeenCalled();
    const launchOpts = launcher.launch.mock.calls[0][0];
    expect(launchOpts.cwd).toBe("/home/.companion/worktrees/my-repo/feat-branch");
    // Worktree mapping should be tracked
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        repoRoot: "/repo",
        branch: "feat-branch",
        actualBranch: "feat-branch",
        worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      }),
    );
  });

  it("falls back to current branch when useWorktree is enabled but branch is omitted", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/my-repo/main",
      branch: "main",
      actualBranch: "main",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/.companion/worktrees/my-repo/main" }),
    );
  });

  it("creates worker worktrees from the leader worktree branch when cwd is already a worktree", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "companion",
      currentBranch: "jiayi-wt-2775",
      defaultBranch: "jiayi",
      isWorktree: true,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-9326",
      branch: "jiayi-wt-2775",
      actualBranch: "jiayi-wt-9326",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/home/.companion/worktrees/companion/jiayi-wt-2775",
        useWorktree: true,
        worktreePortTarget: {
          repoRoot: "/repo",
          branch: "jiayi-wt-2775",
          worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-2775",
          sourceSessionId: "leader-1",
          sourceSessionNum: 7,
          sourceLabel: "#7 Leader WT",
        },
      }),
    });

    expect(res.status).toBe(200);
    // When CWD is already a worktree, create the new isolated worktree from
    // the main repo root but keep the current worktree branch as the target.
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "jiayi-wt-2775", {
      baseBranch: "jiayi",
      createBranch: undefined,
      forceNew: true,
    });
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-9326",
      }),
    );
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeInfo: expect.objectContaining({
          portTarget: {
            repoRoot: "/repo",
            branch: "jiayi-wt-2775",
            worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-2775",
            sourceSessionId: "leader-1",
            sourceSessionNum: 7,
            sourceLabel: "#7 Leader WT",
          },
        }),
      }),
    );
  });

  it("returns 400 when useWorktree is enabled without cwd", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useWorktree: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Worktree mode requires a cwd" });
    expect(gitUtils.ensureWorktreeAsync).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when useWorktree is enabled outside a git repository", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce(null);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/not-a-repo", useWorktree: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Worktree mode requires a git repository" });
    expect(gitUtils.ensureWorktreeAsync).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 503 when env has Docker image but container startup fails", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "companion-dev:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("companion-dev:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockImplementationOnce(() => {
      throw new Error("docker daemon timeout");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Docker is required");
    expect(json.error).toContain("container startup failed");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when containerized Codex session lacks auth", async () => {
    // Codex in containers needs OPENAI_API_KEY or ~/.codex/auth.json.
    // existsSync must return true for the cwd check but false for auth file checks
    vi.mocked(existsSync).mockImplementation((p) => !String(p).includes(".codex"));
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: {},
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Containerized Codex requires auth");
    expect(json.error).toContain("OPENAI_API_KEY");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("allows containerized Codex when OPENAI_API_KEY is provided", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: { OPENAI_API_KEY: "sk-test" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-codex",
      name: "companion-codex",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ backendType: "codex", containerId: "cid-codex" }),
    );
  });

  it("auto-builds companion base image when missing locally", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "companion-dev:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("companion-dev:latest");
    vi.mocked(existsSync).mockReturnValueOnce(true);
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(false);
    const buildSpy = vi
      .spyOn(containerManager, "buildImageFromDockerfileAsync")
      .mockResolvedValue({ success: true, log: "ok" });
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-1",
      name: "companion-temp",
      image: "companion-dev:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(200);
    expect(buildSpy).toHaveBeenCalledWith(expect.stringContaining("Dockerfile.companion-dev"), "companion-dev:latest");
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("runs init script before launching CLI when env has initScript", async () => {
    // Environment with initScript and Docker image
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "WithInit",
      slug: "with-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "bun install && pip install -r requirements.txt",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-init",
      name: "companion-init",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});
    const execAsyncSpy = vi
      .spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 0, output: "installed!" });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    // Init script should have been executed
    expect(execAsyncSpy).toHaveBeenCalledWith(
      "cid-init",
      ["sh", "-lc", "bun install && pip install -r requirements.txt"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    // CLI should have been launched after init script
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("returns 503 and cleans up container when init script fails", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "FailInit",
      slug: "fail-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "exit 1",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-fail",
      name: "companion-fail",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    const removeSpy = vi.spyOn(containerManager, "removeContainer").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync").mockResolvedValueOnce({
      exitCode: 1,
      output: "npm ERR! missing script",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "fail-init" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Init script failed");
    // Container should be cleaned up
    expect(removeSpy).toHaveBeenCalled();
    // CLI should NOT have been launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("stores reviewerOf on the session when provided in request body", async () => {
    // When the CLI sends reviewerOf in the create payload, the server should
    // store it on the session object so it's visible in API responses.
    const launchedSession = {
      sessionId: "reviewer-session",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    };
    launcher.launch.mockReturnValue(launchedSession);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(200);
    // applySessionPostLaunch mutates the session object in-place,
    // so reviewerOf should be on the returned JSON
    const json = await res.json();
    expect(json.reviewerOf).toBe(42);
  });

  it("passes an authoritative memory session-space slug into launch options and env", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        memorySessionSpaceSlug: "Other",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySessionSpaceSlug: "Other",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "Other",
        }),
      }),
    );
  });

  it("uses the server memory session-space default for create when the request omits an explicit slug", async () => {
    launcher.getMemorySessionSpaceSlug.mockReturnValue("Other");
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Stale Memory Space",
      slug: "stale-memory-space",
      variables: { COMPANION_MEMORY_SPACE_SLUG: "Takode", API_KEY: "secret123" },
      createdAt: 1000,
      updatedAt: 1000,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "stale-memory-space" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        memorySessionSpaceSlug: "Other",
        env: expect.objectContaining({
          API_KEY: "secret123",
          COMPANION_MEMORY_SPACE_SLUG: "Other",
        }),
      }),
    );
  });

  it("uses the server memory session-space default for resume when the request omits an explicit slug", async () => {
    launcher.getMemorySessionSpaceSlug.mockReturnValue("Other");
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Stale Memory Space",
      slug: "stale-memory-space",
      variables: { COMPANION_MEMORY_SPACE_SLUG: "Takode", API_KEY: "secret123" },
      createdAt: 1000,
      updatedAt: 1000,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "claude",
        cwd: "/test",
        envSlug: "stale-memory-space",
        resumeCliSessionId: "cli-resume-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "cli-resume-1",
        memorySessionSpaceSlug: "Other",
        env: expect.objectContaining({
          API_KEY: "secret123",
          COMPANION_MEMORY_SPACE_SLUG: "Other",
        }),
      }),
    );
  });

  it("uses the requested tree group name as the memory session-space when resuming Codex sessions", async () => {
    const group = await treeGroupStore.createGroup("MSI");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "codex",
        cwd: "/test",
        treeGroupId: group.id,
        resumeCliSessionId: "codex-resume-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        resumeCliSessionId: "codex-resume-1",
        memorySessionSpaceSlug: "MSI",
        env: expect.objectContaining({
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
        }),
      }),
    );
  });

  it("rejects creation when an active reviewer already exists for the same parent (409)", async () => {
    // Server-side enforcement of one-reviewer-per-parent prevents TOCTOU races
    // where two concurrent CLI spawn commands both pass the client-side check.
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "existing-reviewer",
        state: "connected",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        archived: false,
      },
    ]);
    launcher.getSessionNum.mockReturnValue(99);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already has an active reviewer");
    // Session should NOT have been launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("allows reviewer creation when existing reviewer for same parent is archived", async () => {
    // Archived reviewers should not block new reviewer creation
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "old-reviewer",
        state: "exited",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        archived: true, // archived -- should not block
      },
    ]);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalled();
  });
});
