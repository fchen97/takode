import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimCoordinatorEpoch,
  coordinatorLockPath,
  readCoordinatorMove,
  coordinatorMovePath,
} from "./coordinator-lock.js";
import {
  exportCoordinatorHandoff,
  importCoordinatorHandoff,
  REHEARSAL_DISABLED_BINARY,
} from "./coordinator-handoff.js";
import { loadCarriedOverTokenUsage } from "./workspace-token-usage-carryover.js";
import { buildWorkspaceTokenUsageByModel } from "./workspace-token-usage.js";

// Fixture: a laptop coordinator ("laptop") with one laptop session running
// under its own node, one session on the DevBox host, one archived session,
// and the coordinator state a handoff must carry. Everything lives under
// throwaway HOME folders; nothing touches the real ~/.companion.

const SERVER_ID = "server-1";
const DEVBOX_HOST_ID = "devbox-host-id";
const LAPTOP_SESSION = "11111111-1111-4111-8111-111111111111";
const DEVBOX_SESSION = "22222222-2222-4222-8222-222222222222";
const ARCHIVED_SESSION = "33333333-3333-4333-8333-333333333333";

let root: string;
let laptopHome: string;
let devboxHome: string;
let packageDir: string;

async function put(home: string, path: string, content: unknown): Promise<void> {
  const file = join(home, ".companion", path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

async function readJsonAt(home: string, path: string): Promise<any> {
  return JSON.parse(await readFile(join(home, ".companion", path), "utf-8"));
}

async function buildLaptop(): Promise<void> {
  await put(laptopHome, "machine.json", { name: "laptop" });
  await put(laptopHome, "settings-3456.json", {
    serverId: SERVER_ID,
    serverSlug: "prod",
    pushoverEnabled: true,
    pushoverUserKey: "user-key",
  });
  await put(laptopHome, "settings-secrets-3456.json", {
    transcriptionApiKey: "secret",
  });
  await put(laptopHome, `web-push/${SERVER_ID}.json`, {
    vapidPublicKey: "pub",
    subscriptions: [],
  });
  await put(laptopHome, `hosts/${SERVER_ID}.json`, {
    hosts: [
      {
        id: DEVBOX_HOST_ID,
        name: "devbox",
        createdAt: 1,
        tokenSha256: "devbox-hash",
        settings: {
          claudeBinary: "/devbox/claude",
          codexBinary: "/devbox/codex",
        },
      },
    ],
    local: {
      settings: {
        claudeBinary: "/laptop/claude",
        codexBinary: "/laptop/codex",
      },
      nodeEnabled: true,
      nodeTokenSha256: "local-node-hash",
    },
  });
  // A stopped server: its last holder's pid is not alive.
  await put(laptopHome, `coordinator/${SERVER_ID}.json`, {
    epoch: 6,
    pid: 2_000_000_000,
    hostname: hostname(),
  });
  await put(laptopHome, "sessions/3456/launcher.json", [
    {
      sessionId: LAPTOP_SESSION,
      sessionNum: 10,
      state: "connected",
      hostProcId: "proc-1",
      cwd: "/laptop/repo",
      worktreePortTarget: { repoRoot: "/laptop/repo", branch: "main" },
    },
    {
      sessionId: DEVBOX_SESSION,
      sessionNum: 11,
      state: "connected",
      hostId: DEVBOX_HOST_ID,
      pid: 123,
    },
    {
      sessionId: ARCHIVED_SESSION,
      sessionNum: 12,
      state: "exited",
      archived: true,
    },
  ]);
  await put(laptopHome, `sessions/3456/${LAPTOP_SESSION}.json`, {
    id: LAPTOP_SESSION,
    state: { cwd: "/laptop/repo" },
  });
  await put(laptopHome, `sessions/3456/${LAPTOP_SESSION}.history.jsonl`, '{"v":1}\n');
  await put(laptopHome, `sessions/3456/${DEVBOX_SESSION}.json`, {
    id: DEVBOX_SESSION,
    state: { host_id: DEVBOX_HOST_ID },
    board: [{ questId: "q-1" }],
  });
  await put(laptopHome, `sessions/3456/${ARCHIVED_SESSION}.json`, {
    id: ARCHIVED_SESSION,
    archived: true,
  });
  await put(laptopHome, `timers/${LAPTOP_SESSION}.json`, {
    sessionId: LAPTOP_SESSION,
    nextId: 2,
    timers: [],
  });
  await put(laptopHome, `timers/${ARCHIVED_SESSION}.json`, {
    sessionId: ARCHIVED_SESSION,
    nextId: 1,
    timers: [],
  });
  await put(laptopHome, `images/${LAPTOP_SESSION}/a.png`, "png");
  await put(laptopHome, "questmaster-live/store.json", {
    quests: [{ id: "q-1" }],
  });
  await put(laptopHome, "questmaster-live/_store.lock/owner", "stale lock");
  // The server has already stamped older notes with this machine's name.
  await put(laptopHome, "questmaster-live/machine-stamps.json", { coordinatorMachine: "laptop" });
  await put(laptopHome, "todos/todo-list.json", { items: [] });
  await put(laptopHome, `landing-gates/${SERVER_ID}.json`, { gates: [] });
  await put(laptopHome, `landing-queue/${SERVER_ID}.json`, { version: 1, entries: [{ state: "landed" }], runs: [] });
  await put(laptopHome, "worktrees.json", [
    { sessionId: LAPTOP_SESSION, worktreePath: "/laptop/wt" },
    { sessionId: ARCHIVED_SESSION, worktreePath: "/laptop/old" },
  ]);
  const repo = join(laptopHome, ".companion", "memory", "prod", "Takode");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "note.md"), "note\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"], { cwd: repo });
  execFileSync("git", ["config", "credential.helper", `!${repo}/.git/helper.sh`], { cwd: repo });
  await writeFile(join(repo, ".git", "takode-machine-stamps.json"), JSON.stringify({ machine: "laptop" }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "coordinator-handoff-"));
  laptopHome = join(root, "laptop");
  devboxHome = join(root, "devbox");
  packageDir = join(root, "package");
  await buildLaptop();
  await put(devboxHome, "machine.json", { name: "devbox" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function exportReal() {
  return exportCoordinatorHandoff({
    home: laptopHome,
    packageDir,
    toMachine: "devbox",
    toAddress: "http://127.0.0.1:3456",
    now: new Date(1_800_000_000_000),
  });
}

describe("coordinator handoff", () => {
  // The whole path: export fences the laptop and relabels sessions to their
  // machines; import verifies, moves stale data aside and lands the state.
  it("moves unarchived sessions and coordinator state, relabeling sessions to their machines", async () => {
    // Stale data from an earlier server on the DevBox must not mix with the moved store.
    await put(devboxHome, "questmaster-live/store.json", {
      quests: [{ id: "old" }],
    });

    const exported = await exportReal();
    const { manifest } = exported;
    expect(manifest.summary.sessions).toEqual({
      moved: 2,
      toFromHost: 1,
      toCoordinator: 1,
      onOtherHosts: 0,
      archivedLeft: 1,
    });
    expect(manifest.summary.nextSessionNumber).toBe(13);
    expect(manifest.files.map((file) => file.path)).not.toContain("questmaster-live/_store.lock/owner");
    expect(manifest.files.some((file) => file.path.includes(ARCHIVED_SESSION))).toBe(false);

    // The laptop is fenced and holds its node's token; only the token's hash travels.
    expect(await readCoordinatorMove(coordinatorMovePath(SERVER_ID, laptopHome))).toMatchObject({
      machine: "devbox",
      address: "http://127.0.0.1:3456",
    });
    const token = await readFile(exported.nodeTokenFile!, "utf-8");
    expect((await stat(exported.nodeTokenFile!)).mode & 0o777).toBe(0o600);

    await expect(importCoordinatorHandoff({ home: devboxHome, packageDir })).rejects.toThrow(/questmaster-live/);
    const imported = await importCoordinatorHandoff({
      home: devboxHome,
      packageDir,
      replaceExisting: true,
    });
    expect(imported.replaced).toEqual(["questmaster-live"]);
    expect(JSON.parse(await readFile(join(imported.backupDir!, "questmaster-live", "store.json"), "utf-8"))).toEqual({
      quests: [{ id: "old" }],
    });
    expect(await readJsonAt(devboxHome, "questmaster-live/store.json")).toEqual({ quests: [{ id: "q-1" }] });

    // Hosts: the DevBox entry is gone (it is the coordinator now), the laptop is a host with its old settings.
    const registry = await readJsonAt(devboxHome, `hosts/${SERVER_ID}.json`);
    expect(registry.hosts).toEqual([
      {
        id: manifest.fromHostId,
        name: "laptop",
        createdAt: 1_800_000_000_000,
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        settings: {
          claudeBinary: "/laptop/claude",
          codexBinary: "/laptop/codex",
        },
      },
    ]);
    expect(registry.local).toEqual({
      settings: {
        claudeBinary: "/devbox/claude",
        codexBinary: "/devbox/codex",
      },
    });

    // Sessions: laptop session on the laptop host, DevBox session now the coordinator's own; all processes ended.
    const launcher = await readJsonAt(devboxHome, "sessions/3456/launcher.json");
    expect(launcher).toEqual([
      {
        sessionId: LAPTOP_SESSION,
        sessionNum: 10,
        state: "exited",
        cwd: "/laptop/repo",
        hostId: manifest.fromHostId,
        worktreePortTarget: {
          repoRoot: "/laptop/repo",
          branch: "main",
          hostId: manifest.fromHostId,
        },
      },
      { sessionId: DEVBOX_SESSION, sessionNum: 11, state: "exited" },
    ]);
    expect((await readJsonAt(devboxHome, `sessions/3456/${LAPTOP_SESSION}.json`)).state.host_id).toBe(
      manifest.fromHostId,
    );
    const devboxHot = await readJsonAt(devboxHome, `sessions/3456/${DEVBOX_SESSION}.json`);
    expect(devboxHot.state).toEqual({});
    expect(devboxHot.board).toEqual([{ questId: "q-1" }]);
    expect(await readJsonAt(devboxHome, "sessions/3456/session-numbers.json")).toEqual({ next: 13 });
    expect(await readdir(join(devboxHome, ".companion", "timers"))).toEqual([`${LAPTOP_SESSION}.json`]);
    expect(await readJsonAt(devboxHome, "worktrees.json")).toEqual([
      {
        sessionId: LAPTOP_SESSION,
        worktreePath: "/laptop/wt",
        hostId: manifest.fromHostId,
      },
    ]);
    expect(await readJsonAt(devboxHome, "settings-secrets-3456.json")).toEqual({
      transcriptionApiKey: "secret",
    });
    expect(await readJsonAt(devboxHome, `landing-gates/${SERVER_ID}.json`)).toEqual({ gates: [] });

    // Memory repos arrive whole, with helper paths pointing into this machine's home.
    const repo = join(devboxHome, ".companion", "memory", "prod", "Takode");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim()).toBe(
      manifest.summary.memoryRepos[0].head,
    );
    expect(execFileSync("git", ["config", "credential.helper"], { cwd: repo }).toString().trim()).toBe(
      `!${repo}/.git/helper.sh`,
    );

    // The next start takes an epoch above the laptop's, which hosts have already seen.
    const lock = await claimCoordinatorEpoch({
      path: coordinatorLockPath(SERVER_ID, devboxHome),
      onSuperseded: () => {},
    });
    lock.stop();
    expect(lock.epoch).toBe(7);

    // A fenced machine cannot export the same coordinator again.
    await expect(exportReal()).rejects.toThrow(/already handed off/);
  });

  it("refuses to import on a machine other than the one the package names", async () => {
    await exportReal();
    await put(devboxHome, "machine.json", { name: "desktop" });

    await expect(importCoordinatorHandoff({ home: devboxHome, packageDir })).rejects.toThrow(
      /to devbox, but this machine is desktop/,
    );
  });

  // Notes written before machine stamps existed are stamped once by the server
  // with its own machine's name; after a move that would be the wrong machine.
  it("refuses to export memory whose older notes are not stamped yet", async () => {
    await rm(join(laptopHome, ".companion", "memory", "prod", "Takode", ".git", "takode-machine-stamps.json"));

    await expect(exportReal()).rejects.toThrow(/not stamped with laptop's name yet \(memory Takode\)/);
    expect(await readCoordinatorMove(coordinatorMovePath(SERVER_ID, laptopHome))).toBeNull();
  });

  it("refuses a damaged package before writing anything", async () => {
    await exportReal();
    await writeFile(join(packageDir, "files", "todos", "todo-list.json"), "{}");

    await expect(importCoordinatorHandoff({ home: devboxHome, packageDir })).rejects.toThrow(/todos\/todo-list.json/);
    expect(await readdir(join(devboxHome, ".companion"))).toEqual(["machine.json"]);
  });

  // A landing run uses a checkout on the departing machine, so it must finish there.
  it("refuses to export during a landing run", async () => {
    await put(laptopHome, `landing-queue/${SERVER_ID}.json`, { version: 1, entries: [{ state: "running" }], runs: [] });

    await expect(exportReal()).rejects.toThrow(/landing run is in progress/);
  });

  it("refuses to export while the server runs", async () => {
    // The parent process stands in for a running server on this machine.
    await put(laptopHome, `coordinator/${SERVER_ID}.json`, {
      epoch: 6,
      pid: process.ppid,
      hostname: hostname(),
    });

    await expect(exportReal()).rejects.toThrow(/stop it first/);
    expect(await readCoordinatorMove(coordinatorMovePath(SERVER_ID, laptopHome))).toBeNull();
  });

  // A rehearsal copies live data next to the running coordinator, so the copy
  // must not start agents or alert a phone, and the laptop stays unfenced.
  it("packages a rehearsal copy that runs no agents and alerts no phone", async () => {
    await put(laptopHome, `coordinator/${SERVER_ID}.json`, {
      epoch: 6,
      pid: process.ppid,
      hostname: hostname(),
    });

    const { manifest, nodeTokenFile } = await exportCoordinatorHandoff({
      home: laptopHome,
      packageDir,
      toMachine: "devbox",
      toAddress: "http://127.0.0.1:3471",
      rehearsal: true,
    });
    expect(nodeTokenFile).toBeUndefined();
    expect(manifest.summary.notes).toEqual([]);
    expect(await readCoordinatorMove(coordinatorMovePath(SERVER_ID, laptopHome))).toBeNull();

    await importCoordinatorHandoff({
      home: devboxHome,
      packageDir,
      port: 3471,
    });
    expect(manifest.rehearsal).toBe(true);
    expect((await readJsonAt(devboxHome, `hosts/${SERVER_ID}.json`)).local).toEqual({
      settings: {
        claudeBinary: REHEARSAL_DISABLED_BINARY,
        codexBinary: REHEARSAL_DISABLED_BINARY,
      },
    });
    expect(await readJsonAt(devboxHome, "settings-3471.json")).toMatchObject({
      serverId: SERVER_ID,
      pushoverEnabled: false,
      pushoverUserKey: "",
    });
    const names = await readdir(join(devboxHome, ".companion"));
    expect(names).not.toContain("settings-secrets-3471.json");
    expect(names).not.toContain("web-push");
    expect(await readdir(join(devboxHome, ".companion", "sessions"))).toEqual(["3471"]);
  });

  // Archived sessions stay on the old machine but hold most of the all-time
  // token usage, so their token fields move in a carry-over file, merged with
  // what earlier moves carried, and the new coordinator counts them.
  it("carries archived sessions' token usage to the new coordinator", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 1_800_000_000_000;
    await put(laptopHome, `sessions/3456/${ARCHIVED_SESSION}.json`, {
      id: ARCHIVED_SESSION,
      archived: true,
      state: {
        backend_type: "codex",
        model: "gpt-5.5",
        cwd: "/laptop/old",
        codex_token_details: {
          totalTokens: 900,
          inputTokens: 800,
          outputTokens: 100,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 200_000,
        },
        token_usage_samples: [
          { timestamp: now - 90 * day, backend: "codex", model: "gpt-5.5", totalTokens: 100 },
          { timestamp: now - 60 * day, backend: "codex", model: "gpt-5.5", totalTokens: 500 },
          { timestamp: now - 2 * day, backend: "codex", model: "gpt-5.5", totalTokens: 900 },
        ],
      },
    });
    // Carried over by an earlier move: its session is not in this launcher.
    await put(laptopHome, "sessions/3456/token-usage/carried-over.json", {
      version: 1,
      sessions: [
        {
          sessionId: "earlier-move",
          state: {
            backend_type: "claude-sdk",
            model: "claude-opus",
            claude_model_usage: { "claude-opus": { inputTokens: 50, outputTokens: 0, cachedInputTokens: 0 } },
          },
        },
      ],
    });

    await exportReal();
    await importCoordinatorHandoff({ home: devboxHome, packageDir });

    const carried = await readJsonAt(devboxHome, "sessions/3456/token-usage/carried-over.json");
    expect(carried.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual([
      "earlier-move",
      ARCHIVED_SESSION,
    ]);
    const archived = carried.sessions[1];
    expect(archived.sessionNum).toBe(12);
    // Only token fields travel, and only samples that can still reach a daily
    // bucket plus the baseline right before them.
    expect(Object.keys(archived.state).sort()).toEqual([
      "backend_type",
      "codex_token_details",
      "model",
      "token_usage_samples",
    ]);
    expect(archived.state.token_usage_samples.map((sample: { totalTokens: number }) => sample.totalTokens)).toEqual([
      500, 900,
    ]);

    const summary = buildWorkspaceTokenUsageByModel(
      await loadCarriedOverTokenUsage(join(devboxHome, ".companion", "sessions", "3456")),
      now,
    );
    expect(summary.totalTokens).toBe(950);
    expect(summary.history.ranges.find((range) => range.id === "month")?.totalTokens).toBe(400);
  });
});
