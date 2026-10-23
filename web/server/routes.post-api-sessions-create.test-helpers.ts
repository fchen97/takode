import { vi } from "vitest";

export function createMockLauncher() {
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
    // Pass exact UUIDs through for the route resolveId helper.
    resolveSessionId: vi.fn((id: string) => id),
    getSessionNum: vi.fn(() => undefined),
  } as any;
}

export function createMockStore() {
  return {
    setArchived: vi.fn(async () => true),
    flushAll: vi.fn(async () => {}),
  } as any;
}

export function createMockRecorder() {
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

export function createMockTimerManager() {
  return {
    createTimer: vi.fn(),
    listTimers: vi.fn(() => []),
    cancelTimer: vi.fn(async () => true),
    cancelAllTimers: vi.fn(async () => {}),
  } as any;
}

export function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

export function createMockSettingsManager() {
  return {
    getSettings: vi.fn(() => ({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverBaseUrl: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
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
      maxKeepAlive: patch.maxKeepAlive ?? 0,
      heavyRepoModeEnabled: patch.heavyRepoModeEnabled ?? false,
      namerConfig: patch.namerConfig ?? { backend: "claude" },
      autoNamerEnabled: patch.autoNamerEnabled ?? true,
      transcriptionConfig: patch.transcriptionConfig ?? {
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: patch.editorConfig ?? { editor: "none" },
      sleepInhibitorEnabled: patch.sleepInhibitorEnabled ?? false,
      sleepInhibitorDurationMinutes: patch.sleepInhibitorDurationMinutes ?? 5,
      updatedAt: Date.now(),
    })),
    getServerName: vi.fn(() => ""),
    setServerName: vi.fn(),
    getServerId: vi.fn(() => "test-server-id"),
    getClaudeUserDefaultModel: vi.fn(async () => ""),
  };
}

export function createMockGitUtils() {
  return {
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
  };
}
