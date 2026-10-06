import { vi } from "vitest";

// Claude sessions launch through the Agent SDK adapter; capture what the
// launcher hands it instead of starting a real Claude process.
const sdkAdapterLaunches = vi.hoisted(() => [] as Array<{ sessionId: string; options: any }>);
const sdkAdapterStartFailure = vi.hoisted(() => ({ next: null as Error | null }));
// Whether the next adapter's Claude process spawns (the adapter's `started` result).
const sdkAdapterSpawns = vi.hoisted(() => ({ next: true }));
vi.mock("./claude-sdk-adapter.js", () => ({
  ClaudeSdkAdapter: class {
    started: Promise<boolean>;
    constructor(sessionId: string, options: any) {
      const failure = sdkAdapterStartFailure.next;
      sdkAdapterStartFailure.next = null;
      if (failure) throw failure;
      this.started = Promise.resolve(sdkAdapterSpawns.next);
      sdkAdapterSpawns.next = true;
      sdkAdapterLaunches.push({ sessionId, options });
    }
  },
}));

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

// Mock randomUUID and randomBytes so session IDs and auth tokens are deterministic
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    randomUUID: () => "test-session-id",
    randomBytes: (n: number) => ({ toString: () => "a".repeat(n * 2) }),
  };
});

// Mock child_process.exec to prevent actual git commands from running in tests
const mockExec = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: any, cb: any) => {
    if (_cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
      const err = Object.assign(new Error("Command failed: git ls-files"), {
        code: 1,
        stderr: "error: pathspec '.claude/settings.json' did not match any file(s) known to git",
      });
      if (typeof _opts === "function") {
        _opts(err, "", "");
        return;
      }
      if (cb) cb(err, "", "");
      return;
    }
    // Simulate immediate success (exec callback signature: err, stdout, stderr)
    if (typeof _opts === "function") {
      _opts(null, "", "");
      return;
    }
    if (cb) cb(null, "", "");
  }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock path-resolver for binary resolution
const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/usr/bin/claude"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
const mockCaptureUserShellPath = vi.hoisted(() => vi.fn(() => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
  captureUserShellPath: mockCaptureUserShellPath,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

// Mock container-manager for container validation in relaunch
const mockIsContainerAlive = vi.hoisted(() => vi.fn((): "running" | "stopped" | "missing" => "running"));
const mockHasBinaryInContainer = vi.hoisted(() => vi.fn((): boolean => true));
const mockStartContainer = vi.hoisted(() => vi.fn());
vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: mockIsContainerAlive,
    hasBinaryInContainer: mockHasBinaryInContainer,
    startContainer: mockStartContainer,
  },
}));

// Mock fs operations for worktree guardrails (CLAUDE.md in .claude dirs)
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: any[]) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: any[]) => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
const mockSymlinkSync = vi.hoisted(() => vi.fn());
const mockLstatSync = vi.hoisted(() =>
  vi.fn((_path?: string): any => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const isMockedPath = vi.hoisted(() => (path: string): boolean => {
  return (
    path.includes(".claude") ||
    path.includes(".codex") ||
    path.includes(".companion") ||
    path.startsWith("/tmp/worktrees/") ||
    path.startsWith("/tmp/main-repo")
  );
});

// Async mock functions for node:fs/promises — delegate to sync mocks so test
// setups (mockExistsSync.mockImplementation, mockReadFileSync.mockImplementation, etc.)
// and assertions (expect(mockSymlinkSync).toHaveBeenCalledWith, etc.) still work.
const mockMkdir = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockMkdirSync(...args);
  }),
);
const mockAccess = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    if (!mockExistsSync(args[0])) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const mockReadFile = vi.hoisted(() => vi.fn(async (...args: any[]) => mockReadFileSync(...args)));
const mockCopyFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockCp = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockReaddir = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any[]> => []));
const mockStat = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => ({
    isFile: () => true,
    mtimeMs: 1,
  })),
);
const mockRealpath = vi.hoisted(() => vi.fn(async (...args: any[]) => args[0]));
const mockWriteFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockWriteFileSync(...args);
  }),
);
const mockUnlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockUnlinkSync(...args);
  }),
);
const mockSymlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockSymlinkSync(...args);
  }),
);
const mockLstat = vi.hoisted(() => vi.fn(async (...args: any[]) => mockLstatSync(...args)));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdirSync(...args);
      }
      return actual.mkdirSync(...args);
    },
    existsSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockExistsSync(...args);
      }
      return actual.existsSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFileSync(...args);
      }
      return actual.writeFileSync(...args);
    },
    unlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlinkSync(...args);
      }
      return actual.unlinkSync(...args);
    },
    symlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlinkSync(...args);
      }
      return actual.symlinkSync(...args);
    },
    lstatSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstatSync(...args);
      }
      return actual.lstatSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdir(...args);
      }
      return actual.mkdir(...args);
    },
    access: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockAccess(...args);
      }
      return actual.access(...args);
    },
    readFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFile(...args);
      }
      return actual.readFile(...args);
    },
    copyFile: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCopyFile(...args);
      }
      return actual.copyFile(...args);
    },
    cp: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCp(...args);
      }
      return actual.cp(...args);
    },
    readdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReaddir(...args);
      }
      return actual.readdir(...args);
    },
    stat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockStat(...args);
      }
      return actual.stat(...args);
    },
    writeFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFile(...args);
      }
      return actual.writeFile(...args);
    },
    unlink: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlink(...args);
      }
      return actual.unlink(...args);
    },
    symlink: async (...args: any[]) => {
      // symlink(target, path) — route by target path
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlink(...args);
      }
      return actual.symlink(...args);
    },
    lstat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstat(...args);
      }
      return actual.lstat(...args);
    },
    realpath: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockRealpath(...args);
      }
      return actual.realpath(...args);
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { createLauncherHerdChangeHandler } from "./herd-change-handler.js";
import type { TakodeEvent, TakodeHerdReassignedEventData } from "./session-types.js";

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────

let exitResolve: (code: number) => void;

function createMockProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdout: null,
    stderr: null,
  };
}

/** Codex spawns after launch() returns; wait so later mocks are not consumed by the initial spawn. */
async function waitForCodexSpawns(count: number) {
  const deadline = Date.now() + 2000;
  while (mockSpawn.mock.calls.length < count) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Codex spawn");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function createMockCodexProc(pid = 12345) {
  let resolve: (code: number) => void;
  let exited = false;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  const resolveExit = (code: number) => {
    if (exited) return;
    exited = true;
    resolve(code);
  };
  exitResolve = resolveExit;
  return {
    pid,
    kill: vi.fn((signal?: string) => {
      resolveExit(signal === "SIGKILL" ? 137 : 0);
    }),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

const mockSpawn = vi.fn();
const bunGlobal = globalThis as typeof globalThis & { Bun?: any };
const hadBunGlobal = typeof bunGlobal.Bun !== "undefined";
const originalBunSpawn = hadBunGlobal ? bunGlobal.Bun!.spawn : undefined;
if (hadBunGlobal) {
  // In Bun runtime, globalThis.Bun is non-configurable; patch spawn directly.
  (bunGlobal.Bun as { spawn?: unknown }).spawn = mockSpawn;
} else {
  bunGlobal.Bun = { spawn: mockSpawn };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let store: SessionStore;
let launcher: CliLauncher;

beforeEach(() => {
  vi.clearAllMocks();
  sdkAdapterLaunches.length = 0;
  sdkAdapterStartFailure.next = null;
  sdkAdapterSpawns.next = true;
  // Re-apply default: lstatSync throws ENOENT (file doesn't exist), matching real behavior
  mockLstatSync.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  delete process.env.COMPANION_CONTAINER_SDK_HOST;
  delete process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER;
  delete process.env.TAKODE_PRIVATE_DOCS_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "launcher-test-"));
  store = new SessionStore(tempDir);
  launcher = new CliLauncher(3456, { serverId: "test-server-id", memorySessionSpaceSlug: "Takode" });
  launcher.setStore(store);
  mockSpawn.mockReturnValue(createMockProc());
  mockResolveBinary.mockReturnValue("/usr/bin/claude");
  mockGetEnrichedPath.mockReturnValue("/usr/bin:/usr/local/bin");
  mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  mockCaptureUserShellEnv.mockReturnValue({});
  mockCopyFile.mockReset();
  mockReaddir.mockReset();
  mockStat.mockReset();
  mockReaddir.mockResolvedValue([]);
  mockStat.mockResolvedValue({
    isFile: () => true,
    mtimeMs: 1,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (hadBunGlobal) {
    (bunGlobal.Bun as { spawn?: unknown }).spawn = originalBunSpawn;
  } else {
    delete bunGlobal.Bun;
  }
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe("relaunch", () => {
  it("relaunch resumes the Claude conversation through a new SDK adapter", async () => {
    await launcher.launch({ cwd: "/tmp/project", model: "claude-sonnet-4-5-20250929" });
    launcher.setCLISessionId("test-session-id", "cli-resume-id");

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // The replacement adapter resumes the same Claude session with the same model.
    expect(sdkAdapterLaunches).toHaveLength(2);
    expect(sdkAdapterLaunches[1]!.options.cliSessionId).toBe("cli-resume-id");
    expect(sdkAdapterLaunches[1]!.options.model).toBe("claude-sonnet-4-5-20250929");
    expect(launcher.getSession("test-session-id")?.state).toBe("connected");
  });

  it("relaunch forwards a Revert point to the resumed Claude session once", async () => {
    // Revert relaunches at an assistant message; Claude must truncate its own
    // context there, and later relaunches must resume the full conversation.
    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-revert-id");

    expect(await launcher.relaunchWithResumeAt("test-session-id", "assistant-uuid-3")).toEqual({ ok: true });
    expect(await launcher.relaunch("test-session-id")).toEqual({ ok: true });

    expect(sdkAdapterLaunches[1]!.options).toMatchObject({
      cliSessionId: "cli-revert-id",
      resumeSessionAt: "assistant-uuid-3",
    });
    expect(sdkAdapterLaunches[2]!.options.resumeSessionAt).toBeUndefined();
  });

  it("reports a Claude launch whose process never spawns as exited and resumes it on relaunch", async () => {
    // Cron's connection wait, liveness checks and the sidebar read launcher
    // state, so a failed start must not look connected. The saved conversation
    // ID survives so the bridge's bounded relaunch resumes the same conversation.
    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-kept");
    sdkAdapterSpawns.next = false;
    const failed = await launcher.relaunch("test-session-id");
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("Failed to spawn process");

    const info = launcher.getSession("test-session-id")!;
    expect(info).toMatchObject({ state: "exited", exitCode: 1, cliSessionId: "cli-kept" });
    expect(launcher.isAlive("test-session-id")).toBe(false);

    expect(await launcher.relaunch("test-session-id")).toEqual({ ok: true });
    expect(sdkAdapterLaunches.at(-1)!.options.cliSessionId).toBe("cli-kept");
    expect(launcher.getSession("test-session-id")?.state).toBe("connected");
  });

  it("marks a Claude session exited when its current process ends, ignoring replaced adapters", async () => {
    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-kept");
    const first = sdkAdapterLaunches[0]!.options;
    expect(await launcher.relaunch("test-session-id")).toEqual({ ok: true });
    const second = sdkAdapterLaunches[1]!.options;

    // A late failure from the replaced adapter must not mark the new one exited.
    first.onBackendExit("old process closed");
    expect(launcher.getSession("test-session-id")?.state).toBe("connected");

    second.onBackendExit("Claude process ended");
    expect(launcher.getSession("test-session-id")).toMatchObject({
      state: "exited",
      exitCode: 1,
      cliSessionId: "cli-kept",
    });
  });

  it("refuses to resume a saved Claude container session without running it on the host", async () => {
    // Only the retired WebSocket backend ran Claude in containers. A saved
    // record keeps its history and conversation ID but is not relaunched.
    store.saveLauncher([
      {
        sessionId: "claude-container",
        state: "exited" as const,
        backendType: "claude" as any,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "container-cli-session",
        containerId: "abc123def456",
        containerName: "companion-old",
      },
    ]);
    await store.flushAll();
    await launcher.restoreFromDisk();

    const result = await launcher.relaunch("claude-container");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ran in a container");
    expect(sdkAdapterLaunches).toHaveLength(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(launcher.getSession("claude-container")).toMatchObject({
      state: "exited",
      cliSessionId: "container-cli-session",
      containerId: "abc123def456",
    });
  });

  it("reuses launch env variables during relaunch", async () => {
    await launcher.launch({
      cwd: "/tmp/project",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-test" },
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    const relaunchEnv = sdkAdapterLaunches[1]!.options.env;
    expect(relaunchEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-test");
    expect(relaunchEnv.COMPANION_SERVER_ID).toBe("test-server-id");
    expect(relaunchEnv.COMPANION_SERVER_SLUG).toBe("local");
    expect(relaunchEnv.COMPANION_MEMORY_SPACE_SLUG).toBe("Takode");
    expect(relaunchEnv.COMPANION_AUTH_TOKEN).toBeTruthy();
  });

  it("preserves the persisted memory session-space slug during relaunch", async () => {
    await launcher.launch({
      cwd: "/tmp/project",
      memorySessionSpaceSlug: "Other",
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    expect(sdkAdapterLaunches[1]!.options.env.COMPANION_MEMORY_SPACE_SLUG).toBe("Other");
    expect(launcher.getSession("test-session-id")?.memorySessionSpaceSlug).toBe("Other");
  });

  it("keeps the persisted memory session-space authoritative over env profile relaunch vars", async () => {
    store.saveLauncher([
      {
        sessionId: "profile-relaunch",
        state: "exited" as const,
        // Saved by the retired WebSocket backend; it relaunches through the SDK.
        backendType: "claude" as any,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        envSlug: "profile-with-stale-space",
        memorySessionSpaceSlug: "PersistedSpace",
      },
    ]);
    await store.flushAll();
    launcher.setEnvResolver(async () => ({
      COMPANION_MEMORY_SPACE_SLUG: "StaleProfileSpace",
      PROFILE_ONLY: "kept",
    }));
    await launcher.restoreFromDisk();

    const result = await launcher.relaunch("profile-relaunch");

    expect(result).toEqual({ ok: true });
    expect(launcher.getSession("profile-relaunch")?.backendType).toBe("claude-sdk");
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.env.PROFILE_ONLY).toBe("kept");
    expect(options.env.COMPANION_MEMORY_SPACE_SLUG).toBe("PersistedSpace");
  });

  it("resolves env profiles during direct launch before first spawn", async () => {
    launcher.setEnvResolver(async (slug) =>
      slug === "codex-profile" ? { LITELLM_API_KEY: "profile-key", PROFILE_ONLY: "kept" } : null,
    );

    await launcher.launch({
      backendType: "claude-sdk",
      cwd: "/tmp/project",
      envSlug: "codex-profile",
      env: { INLINE_ONLY: "also-kept" },
    });

    const { options } = sdkAdapterLaunches[0]!;
    expect(options.env.LITELLM_API_KEY).toBe("profile-key");
    expect(options.env.PROFILE_ONLY).toBe("kept");
    expect(options.env.INLINE_ONLY).toBe("also-kept");
    expect(options.env.COMPANION_SESSION_ID).toBe("test-session-id");
    expect(launcher.getSession("test-session-id")?.envSlug).toBe("codex-profile");
  });

  it("blocks selected env keys after profile resolution during direct launch", async () => {
    launcher.setEnvResolver(async (slug) =>
      slug === "codex-profile"
        ? { LITELLM_API_KEY: "profile-key", TAKODE_ROLE: "orchestrator", TAKODE_API_PORT: "9999" }
        : null,
    );

    await launcher.launch({
      backendType: "claude-sdk",
      cwd: "/tmp/project",
      envSlug: "codex-profile",
      env: { INLINE_ONLY: "kept", TAKODE_ROLE: "worker" },
      blockedEnvKeys: ["TAKODE_ROLE", "TAKODE_API_PORT"],
    });

    const { options } = sdkAdapterLaunches[0]!;
    expect(options.env.LITELLM_API_KEY).toBe("profile-key");
    expect(options.env.INLINE_ONLY).toBe("kept");
    expect(options.env.TAKODE_ROLE).toBeUndefined();
    expect(options.env.TAKODE_API_PORT).toBeUndefined();
    expect(options.env.COMPANION_SESSION_ID).toBe("test-session-id");
  });

  it("blocks selected profile env keys when relaunch reconstructs a hidden thread child env", async () => {
    store.saveLauncher([
      {
        sessionId: "hidden-child",
        state: "exited" as const,
        backendType: "codex" as const,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        envSlug: "codex-profile",
        hidden: true,
        parentSessionId: "root",
        slackThreadId: "st-1",
        slackThreadReadOnly: true,
        blockedEnvKeys: [
          "COMPANION_AUTH_TOKEN",
          "COMPANION_SESSION_ID",
          "COMPANION_SESSION_NUMBER",
          "TAKODE_ROLE",
          "TAKODE_API_PORT",
        ],
      },
    ]);
    await store.flushAll();
    launcher.setEnvResolver(async (slug) =>
      slug === "codex-profile"
        ? {
            LITELLM_API_KEY: "profile-key",
            PROFILE_ONLY: "kept",
            COMPANION_AUTH_TOKEN: "stale-root-auth",
            COMPANION_SESSION_ID: "root",
            COMPANION_SESSION_NUMBER: "99",
            TAKODE_ROLE: "orchestrator",
            TAKODE_API_PORT: "9999",
          }
        : null,
    );
    await launcher.restoreFromDisk();

    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    const result = await launcher.relaunch("hidden-child");

    expect(result).toEqual({ ok: true });
    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.LITELLM_API_KEY).toBe("profile-key");
    expect(options.env.PROFILE_ONLY).toBe("kept");
    expect(options.env.COMPANION_AUTH_TOKEN).not.toBe("stale-root-auth");
    expect(options.env.COMPANION_SESSION_ID).toBe("hidden-child");
    expect(options.env.COMPANION_SESSION_NUMBER).not.toBe("99");
    expect(options.env.TAKODE_ROLE).toBeUndefined();
    expect(options.env.TAKODE_API_PORT).toBeUndefined();
  });

  it("returns error for unknown session", async () => {
    const result = await launcher.relaunch("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("returns error when container was removed externally", async () => {
    // Container preflight applies to Codex, the only backend that runs in containers.
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-gone",
      codexSandbox: "workspace-write",
    });
    await waitForCodexSpawns(1);

    // Simulate container being removed
    mockIsContainerAlive.mockReturnValueOnce("missing");
    const pidBefore = launcher.getSession("test-session-id")?.pid;

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-gone");
    expect(result.error).toContain("removed externally");

    // Session should be marked as exited
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);

    // Should NOT have started a new backend
    expect(launcher.getSession("test-session-id")?.pid).toBe(pidBefore);
  });

  it("restarts stopped container before relaunching", async () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-stopped",
      codexSandbox: "workspace-write",
    });
    await waitForCodexSpawns(1);

    // Container is stopped but can be restarted
    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockHasBinaryInContainer.mockReturnValueOnce(true);

    // Let the original process exit before creating the replacement mock,
    // which takes over exitResolve.
    exitResolve(0);
    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });
    expect(mockStartContainer).toHaveBeenCalledWith("abc123def456");
    expect(launcher.getSession("test-session-id")?.pid).toBe(54321);
  });

  it("returns error when stopped container cannot be restarted", async () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-dead",
      codexSandbox: "workspace-write",
    });
    await waitForCodexSpawns(1);

    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockStartContainer.mockImplementationOnce(() => {
      throw new Error("container start failed");
    });

    // This test is about the container restart failure, not launcher process
    // termination latency.
    exitResolve(0);
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-dead");
    expect(result.error).toContain("stopped");
    expect(result.error).toContain("container start failed");
  });

  it("returns error when CLI binary not found in container", async () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-nobin",
      codexSandbox: "workspace-write",
    });
    await waitForCodexSpawns(1);

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    // Resolve the old proc so this assertion measures binary validation only.
    exitResolve(0);
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("codex");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("companion-nobin");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(127);
  });

  it("refuses a saved Claude container session before any container preflight", async () => {
    // Claude no longer runs in containers, so relaunch refuses before restarting
    // the container or looking for a configured Claude binary inside it.
    launcher.setSettingsGetter(() => ({
      claudeBinary: "/opt/custom/claude-enterprise",
      codexBinary: "",
    }));

    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-custom-claude",
    });

    mockIsContainerAlive.mockReturnValueOnce("stopped");
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ran in a container");
    expect(mockIsContainerAlive).not.toHaveBeenCalled();
    expect(mockStartContainer).not.toHaveBeenCalled();
    expect(mockHasBinaryInContainer).not.toHaveBeenCalled();
    expect(sdkAdapterLaunches).toHaveLength(1); // only the initial launch
  });

  it("validates configured Codex binary name in container during relaunch", async () => {
    launcher.setSettingsGetter(() => ({
      claudeBinary: "",
      codexBinary: "/opt/custom/codex-enterprise --app-server",
    }));

    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-custom-codex",
      codexSandbox: "workspace-write",
    });

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    // Resolve mock process exit so relaunch doesn't wait the 2s kill timeout
    exitResolve(0);
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("codex-enterprise");
    expect(mockHasBinaryInContainer).toHaveBeenCalledWith("abc123def456", "/opt/custom/codex-enterprise");
  });

  it("skips container validation for non-containerized sessions", async () => {
    await launcher.launch({ cwd: "/tmp/project" });

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Container validation methods should NOT have been called
    expect(mockIsContainerAlive).not.toHaveBeenCalled();
    expect(mockHasBinaryInContainer).not.toHaveBeenCalled();
  });

  // Regression: starting the backend can throw when the binary path is stale
  // (e.g. nvm version changed). The server must not crash.
  it("returns error gracefully when the Claude SDK adapter cannot start on relaunch", async () => {
    await launcher.launch({ cwd: "/tmp/project" });

    sdkAdapterStartFailure.next = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'claude'"), {
      code: "ENOENT",
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to spawn process");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);
  });

  it("uses the persisted multi-agent selection when relaunching Codex", async () => {
    // Existing-worker rollout updates launcher state before relaunch. The replacement
    // process must use that retained selection rather than falling back to V1.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    const info = await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    const deadline = Date.now() + 2_000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const updated = launcher.updateSessionLaunchConfig(info.sessionId, { codexMultiAgentVersion: "v2" });
    expect(updated?.codexMultiAgentVersion).toBe("v2");
    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));

    expect(await launcher.relaunch(info.sessionId)).toEqual({ ok: true });
    const [relaunchCommand] = mockSpawn.mock.calls[1];
    const enableIndex = relaunchCommand.indexOf("--enable");
    expect(enableIndex).toBeGreaterThan(0);
    expect(relaunchCommand[enableIndex + 1]).toBe("multi_agent_v2");
  });

  it("returns error gracefully when Bun.spawn throws ENOENT on Codex relaunch", async () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    // Codex spawn is async; ensure the initial launch consumed the first spawn call
    // before swapping to the throwing implementation for relaunch.
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // On relaunch, Bun.spawn throws ENOENT (node binary path gone).
    // Use persistent implementation (not once) to keep this deterministic.
    mockSpawn.mockImplementation(() => {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, posix_spawn '/home/user/.nvm/versions/node/v22/bin/node'"),
        { code: "ENOENT" },
      );
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to spawn process");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);
  });

  it("kills a persisted stale pid during Codex relaunch even when no subprocess is tracked", async () => {
    // Simulates session-140-style launcher drift where the persisted launcher
    // state still points at an old Codex pid but this server instance has no
    // Subprocess handle for it.
    store.saveLauncher([
      {
        sessionId: "stale-codex",
        pid: 33333,
        state: "connected" as const,
        backendType: "codex" as const,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "thread-stale",
        codexSandbox: "workspace-write" as const,
      },
    ]);
    await store.flushAll();

    let pidAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid !== 33333) return true;
      if (signal === 0) {
        if (pidAlive) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        pidAlive = false;
        return true;
      }
      return true;
    }) as any);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(44444));
    const recovered = await launcher.restoreFromDisk();
    expect(recovered).toBe(1);

    const result = await launcher.relaunch("stale-codex");
    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    killSpy.mockRestore();
  });

  it("stops a live process saved by the retired Claude WebSocket backend before resuming through the SDK", async () => {
    // A record saved before the WebSocket retirement can still point at a live
    // CLI process. It can never reconnect, so the reconnect watchdog relaunches
    // it. The pid is untracked, so relaunch sends best-effort SIGTERM without
    // polling or SIGKILL, then resumes the same conversation through the SDK.
    store.saveLauncher([
      {
        sessionId: "legacy-claude",
        pid: 66666,
        state: "connected" as const,
        backendType: "claude" as any,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "legacy-cli-session",
      },
    ]);
    await store.flushAll();

    let pidAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid !== 66666) return true;
      if (signal === 0) {
        if (pidAlive) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") pidAlive = false;
      return true;
    }) as any);

    try {
      expect(await launcher.restoreFromDisk()).toBe(1);
      expect(launcher.getSession("legacy-claude")).toMatchObject({ state: "starting", backendType: "claude-sdk" });
      // Only the restore-time liveness probe may check the pid; relaunch must not poll it.
      killSpy.mockClear();

      expect(await launcher.relaunch("legacy-claude")).toEqual({ ok: true });
      expect(killSpy).toHaveBeenCalledWith(66666, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(66666, 0);
      expect(killSpy).not.toHaveBeenCalledWith(66666, "SIGKILL");
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(sdkAdapterLaunches.at(-1)!.options.cliSessionId).toBe("legacy-cli-session");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("does not escalate persisted stale pids to SIGKILL without a tracked subprocess", async () => {
    // Persisted PIDs can be recycled by the OS. We still send SIGTERM for
    // cleanup, but SIGKILL is reserved for live Subprocess handles that we
    // know belong to this launcher instance.
    store.saveLauncher([
      {
        sessionId: "stubborn-codex",
        pid: 44444,
        state: "connected" as const,
        backendType: "codex" as const,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "thread-stubborn",
        codexSandbox: "workspace-write" as const,
      },
    ]);
    await store.flushAll();

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid !== 44444) return true;
      if (signal === 0) return true;
      return true;
    }) as any);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(55555));
    await launcher.restoreFromDisk();
    killSpy.mockClear();

    try {
      const result = await launcher.relaunch("stubborn-codex");
      expect(result).toEqual({ ok: true });
      expect(killSpy).toHaveBeenCalledWith(44444, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(44444, 0);
      expect(killSpy).not.toHaveBeenCalledWith(44444, "SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
  });

  // Regression: q-16 — old Codex process exit handler stomps new process state.
  // When relaunch kills the old process and spawns a new one, the old process's
  // proc.exited handler must not overwrite the new session state to "exited" or
  // delete the new process entry. This caused zombie sessions that appeared
  // running in the UI but rejected messages via takode send.
  it("ignores stale Codex proc.exited after relaunch spawns a new process", async () => {
    // Create a Codex process with controllable exit
    let resolveFirstExit: (code: number) => void;
    const firstProc = {
      pid: 11111,
      kill: vi.fn(),
      exited: new Promise<number>((r) => {
        resolveFirstExit = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    // Wait for initial spawn to be consumed
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Prepare second proc for relaunch
    const secondProc = createMockCodexProc(22222);
    mockSpawn.mockReturnValueOnce(secondProc);

    // Start relaunch (kills first proc, spawns second)
    // Resolve the first proc's exit during terminateKnownProcess
    firstProc.kill.mockImplementation(() => {
      resolveFirstExit(143);
    });
    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // At this point, the new process should be tracked
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("connected");
    expect(session?.pid).toBe(22222);

    // Now simulate the OLD process's stale exit handler firing late
    // (this happens if the exit promise resolves after relaunch completes).
    // The old handler MUST be guarded — it should NOT stomp state.
    resolveFirstExit!(143);
    await new Promise<void>((r) => setTimeout(r, 50)); // flush microtasks

    // Session should STILL be connected with the new process
    const afterStaleExit = launcher.getSession("test-session-id");
    expect(afterStaleExit?.state).toBe("connected");
    expect(afterStaleExit?.pid).toBe(22222);
    expect(launcher.isAlive("test-session-id")).toBe(true);
  });

  // Regression: q-16 — relaunch should notify ws-bridge before killing old
  // Codex process so the disconnect handler knows it's intentional.
  it("calls onBeforeRelaunch callback before killing old process", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    // Wait for initial spawn
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Register the onBeforeRelaunch callback
    const beforeRelaunchCb = vi.fn();
    launcher.onBeforeRelaunchCallback(beforeRelaunchCb);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    await launcher.relaunch("test-session-id");

    // Callback should have been called with session ID and backend type
    expect(beforeRelaunchCb).toHaveBeenCalledWith("test-session-id", "codex");
    // And it should have been called BEFORE kill (verify kill was called after)
    expect(firstProc.kill).toHaveBeenCalled();
  });

  it("relaunches host Codex sessions without hot-path shell capture", async () => {
    mockCaptureUserShellPath.mockImplementation(() => {
      throw new Error("host Codex relaunch should not re-capture shell PATH");
    });
    mockCaptureUserShellEnv.mockReturnValue({ LITELLM_PROXY_URL: "https://shell-proxy.example" });
    mockGetEnrichedPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    process.env.LITELLM_PROXY_URL = "https://stale-daemon-proxy.example";

    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    const result = await launcher.relaunch("test-session-id");

    expect(result).toEqual({ ok: true });
    const [, relaunchOptions] = mockSpawn.mock.calls[1];
    expect(relaunchOptions.env.LITELLM_PROXY_URL).toBe("https://shell-proxy.example");
    expect(mockCaptureUserShellEnv).toHaveBeenCalledWith(["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"], {
      allowShellSpawn: false,
    });
    expect(mockCaptureUserShellPath).not.toHaveBeenCalled();
  });

  // Regression: q-110 — without orchestrator guardrails, relaunched leaders
  // lose Quest Journey stages, worker selection rules, and skeptic review
  // workflows, breaking all orchestration coordination.
  it("re-injects orchestrator guardrails into system prompt on relaunch", async () => {
    // Launch as an orchestrator — pass extraInstructions via launch options
    const orchestratorGuardrails = launcher.getOrchestratorGuardrails("claude-sdk");
    const session = await launcher.launch({
      cwd: "/tmp/project",
      extraInstructions: orchestratorGuardrails,
    });
    session.isOrchestrator = true;
    launcher.setCLISessionId("test-session-id", "cli-orch-id");

    // The initial launch hands Claude the Takode system prompt
    expect(sdkAdapterLaunches[0]!.options.instructions).toContain("Takode");

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // The relaunched Claude session must also receive the guardrails
    const relaunchSysPrompt = sdkAdapterLaunches[1]!.options.instructions as string;
    expect(relaunchSysPrompt).toContain("Takode");
    expect(relaunchSysPrompt).toContain("Quest Journey");
    expect(relaunchSysPrompt).toContain("Work");
    expect(relaunchSysPrompt).toContain("Memory");
  });

  it("does not inject orchestrator guardrails for non-orchestrator sessions on relaunch", async () => {
    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-worker-id");

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // The system prompt should still exist (link syntax etc.) but NOT contain
    // orchestrator guardrails -- assert unconditionally to catch regressions
    // where the prompt disappears entirely.
    const sysPrompt = sdkAdapterLaunches[1]!.options.instructions as string;
    expect(sysPrompt).toBeTruthy();
    expect(sysPrompt).not.toContain("Quest Journey");
    expect(sysPrompt).not.toContain("Code Review");
  });

  it("re-injects private default instructions on relaunch", async () => {
    // Relaunch reconstructs launch options, so private defaults must be reloaded instead of relying on persisted extras.
    process.env.TAKODE_PRIVATE_DOCS_DIR = "/tmp/.companion/private-docs";
    mockExistsSync.mockImplementation((path) =>
      [
        "/tmp/.companion/private-docs/default-instructions.json",
        "/tmp/.companion/private-docs/dangerous-operation-safeguard.md",
      ].includes(String(path)),
    );
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("default-instructions.json")) {
        return JSON.stringify({ include: ["dangerous-operation-safeguard.md"] });
      }
      return "PRIVATE_RELAUNCH_DANGEROUS_OPERATION_MARKER";
    });

    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-worker-id");

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Observe the SDK relaunch boundary, preserving the private-default content
    // checks while the retired WebSocket command line remains removed.
    const sysPrompt = sdkAdapterLaunches[1]!.options.instructions as string;
    expect(sysPrompt).toBeTruthy();
    expect(sysPrompt).toContain("## Private Default Instructions");
    expect(sysPrompt).toContain("PRIVATE_RELAUNCH_DANGEROUS_OPERATION_MARKER");
  });
});
