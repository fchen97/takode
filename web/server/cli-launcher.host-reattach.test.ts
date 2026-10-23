import { vi } from "vitest";

// Capture what the launcher hands the Claude adapter instead of running Claude;
// the test drives the spawn hook itself.
const sdkAdapterLaunches = vi.hoisted(() => [] as Array<{ sessionId: string; options: any }>);
vi.mock("./claude-sdk-adapter.js", () => ({
  ClaudeSdkAdapter: class {
    started = Promise.resolve(true);
    disconnect = async () => {};
    constructor(sessionId: string, options: any) {
      sdkAdapterLaunches.push({ sessionId, options });
    }
  },
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliLauncher } from "./cli-launcher.js";
import { SessionStore } from "./session-store.js";
import { HostAgent } from "./remote-host/host-agent.js";
import { HostLinkManager, type RemoteProcess } from "./remote-host/host-link-manager.js";
import { LOCAL_HOST_ID, type HostRegistry } from "./remote-host/host-registry.js";
import { FakeHostLink } from "./test-fixtures/fake-host-link.js";

/** Stands in for a session's backend process: echoes stdin in upper case. */
const ECHO_PROGRAM = "process.stdin.on('data', (chunk) => process.stdout.write(String(chunk).toUpperCase()));";
const hostId = "host-1";

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readLine(proc: RemoteProcess): Promise<string> {
  return new Promise((resolve) => proc.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf-8"))));
}

describe("taking over host processes after a coordinator restart", () => {
  let tempDir: string;
  let store: SessionStore;
  let manager: HostLinkManager;
  let agent: HostAgent;
  let link: FakeHostLink | null;

  beforeEach(() => {
    sdkAdapterLaunches.length = 0;
    tempDir = mkdtempSync(join(tmpdir(), "host-reattach-test-"));
    store = new SessionStore(tempDir);
    manager = new HostLinkManager();
    link = null;
    agent = new HostAgent({
      coordinatorUrl: "http://coordinator.test",
      token: "token",
      apiProxyPort: 45_678,
      reconnectDelayMs: 20,
      log: () => {},
      connect: () => {
        link = new FakeHostLink(manager, hostId);
        return link.agentSide;
      },
    });
    agent.start();
  });

  afterEach(() => {
    agent.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** The state a coordinator saved for a Claude session running `procId` on the host, then a new coordinator. */
  async function restartCoordinator(procId: string): Promise<CliLauncher> {
    store.saveLauncher([
      {
        sessionId: "s-1",
        hostId,
        hostProcId: procId,
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "claude-conversation",
        cwd: "/srv/project",
        createdAt: Date.now(),
      },
    ]);
    await store.flushAll();
    manager = new HostLinkManager();
    const launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    launcher.setStore(store);
    launcher.setRemoteHosts({ registry: {} as HostRegistry, links: manager });
    await launcher.restoreFromDisk();
    return launcher;
  }

  // The process keeps running on the host while the coordinator restarts. The
  // restored session waits for the host (it is not relaunched by the reconnect
  // watchdog meanwhile) and, once the host connects, its new adapter is handed
  // the same process, which still answers.
  it("hands the running process to the restored session when its host connects", async () => {
    const original = manager.spawn(hostId, { command: process.execPath, args: ["-e", ECHO_PROGRAM], env: {} });
    await waitFor(() => original.started);

    const launcher = await restartCoordinator(original.procId);
    expect(launcher.getSession("s-1")?.state).toBe("starting");
    expect(launcher.hostTakeovers.isAwaiting("s-1")).toBe(true);
    expect(launcher.getStartingSessions()).toEqual([]);

    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.reattach).toBe(true);
    expect(options.cliSessionId).toBe("claude-conversation");
    expect(launcher.hostTakeovers.isAwaiting("s-1")).toBe(false);

    const proc = options.spawnProcess({ command: "claude", args: [], env: {}, signal: new AbortController().signal });
    expect(proc.procId).toBe(original.procId);
    const spawned = new Promise((resolve) => proc.once("spawn", resolve));
    const line = readLine(proc);
    proc.stdin.write("still running\n");
    expect(await line).toBe("STILL RUNNING\n");
    await spawned;
    await waitFor(() => launcher.getSession("s-1")?.state === "connected");
  });

  // The process can end while the takeover is under way, as when the node restarts onto
  // the coordinator's new build moments after the coordinator did. The Agent SDK only
  // spawns once the adapter starts, so the hook must not hand it the dead process: the
  // SDK would wait on it forever and every message would go nowhere. It starts a new
  // process instead (resuming the conversation through the SDK's arguments).
  it("starts a new process when the one being taken over ends before the SDK spawns it", async () => {
    const original = manager.spawn(hostId, { command: process.execPath, args: ["-e", ECHO_PROGRAM], env: {} });
    await waitFor(() => original.started && original.pid !== undefined);
    const launcher = await restartCoordinator(original.procId);
    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.reattach).toBe(true);

    // The host's process ends before the SDK asks for it.
    process.kill(original.pid!, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(original.pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const proc = options.spawnProcess({
      command: process.execPath,
      args: ["-e", ECHO_PROGRAM],
      env: {},
      signal: new AbortController().signal,
    });
    expect(proc.procId).not.toBe(original.procId);
    expect(launcher.getSession("s-1")?.hostProcId).toBe(proc.procId);
    const line = readLine(proc);
    proc.stdin.write("fresh again\n");
    expect(await line).toBe("FRESH AGAIN\n");
    proc.kill("SIGTERM");
  });

  // If the host lost the process (for example its node restarted too), the
  // session is stopped like an idle one, and the server is told so it can
  // continue a cut turn or deliver waiting input. Its next launch starts a new
  // process and saves the new process id.
  it("starts a new process when the host no longer runs the old one", async () => {
    const launcher = await restartCoordinator("proc-the-host-lost");
    const ended: string[] = [];
    launcher.hostTakeovers.onLeftoverProcessEnded = (sessionId) => ended.push(sessionId);
    link!.drop();
    await waitFor(() => launcher.getSession("s-1")?.state === "exited");
    expect(ended).toEqual(["s-1"]);
    expect(launcher.hostTakeovers.isAwaiting("s-1")).toBe(false);
    expect(sdkAdapterLaunches).toHaveLength(0);

    await launcher.relaunch("s-1");
    expect(sdkAdapterLaunches).toHaveLength(1);
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.reattach).toBe(false);

    const proc = options.spawnProcess({
      command: process.execPath,
      args: ["-e", ECHO_PROGRAM],
      env: {},
      signal: new AbortController().signal,
    });
    expect(launcher.getSession("s-1")?.hostProcId).toBe(proc.procId);
    const line = readLine(proc);
    proc.stdin.write("fresh\n");
    expect(await line).toBe("FRESH\n");
  });
});

// Sessions without a remote host run their processes under this machine's own
// node when it is turned on and connected, so they outlive a server restart the
// same way; otherwise they start here as before.
describe("sessions on this machine's own node", () => {
  let tempDir: string;
  let store: SessionStore;
  let manager: HostLinkManager;
  let agent: HostAgent;
  let link: FakeHostLink | null;

  beforeEach(() => {
    sdkAdapterLaunches.length = 0;
    tempDir = mkdtempSync(join(tmpdir(), "local-node-launch-test-"));
    store = new SessionStore(tempDir);
    manager = new HostLinkManager();
    link = null;
    agent = new HostAgent({
      coordinatorUrl: "http://127.0.0.1:3456",
      token: "token",
      apiProxyPort: 45_678,
      reconnectDelayMs: 20,
      log: () => {},
      connect: () => {
        link = new FakeHostLink(manager, LOCAL_HOST_ID);
        return link.agentSide;
      },
    });
    agent.start();
  });

  afterEach(() => {
    agent.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A coordinator that restored one Claude session without a host, saved with `saved`. */
  async function coordinatorWith(
    saved: { hostProcId?: string; hostClaudeRequests?: string[]; injectedSystemPrompt?: string },
    useLocalNode: () => boolean,
  ): Promise<CliLauncher> {
    store.saveLauncher([
      {
        sessionId: "s-1",
        sessionNum: 7,
        ...saved,
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "claude-conversation",
        cwd: tempDir,
        createdAt: Date.now(),
      },
    ]);
    await store.flushAll();
    const launcher = new CliLauncher(3456, { serverId: "test-server-id" });
    launcher.setStore(store);
    launcher.setRemoteHosts({
      registry: {} as HostRegistry,
      links: manager,
      useLocalNode,
    });
    await launcher.restoreFromDisk();
    return launcher;
  }

  it("starts a session's process under the node and saves its id for the next server", async () => {
    await waitFor(() => manager.status(LOCAL_HOST_ID).online);
    const launcher = await coordinatorWith({}, () => true);
    await launcher.relaunch("s-1");
    await waitFor(() => sdkAdapterLaunches.length === 1);
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.reattach).toBe(false);

    const proc = options.spawnProcess({
      command: process.execPath,
      args: ["-e", ECHO_PROGRAM],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    const info = launcher.getSession("s-1")!;
    expect(info.hostId).toBeUndefined();
    expect(info.hostProcId).toBe(proc.procId);
    const line = readLine(proc);
    proc.stdin.write("on the node\n");
    expect(await line).toBe("ON THE NODE\n");
    proc.kill("SIGTERM");
  });

  // Turned off (or not connected): the process starts here, and the session
  // forgets the node process it had, so the next server does not wait for it.
  it("starts the process here when the node is not ready", async () => {
    const launcher = await coordinatorWith({ hostProcId: "proc-from-before" }, () => false);
    await launcher.relaunch("s-1");
    await waitFor(() => sdkAdapterLaunches.length === 1);
    expect(sdkAdapterLaunches[0]!.options.spawnProcess).toBeUndefined();
    expect(launcher.getSession("s-1")?.hostProcId).toBeUndefined();
  });

  // After a server restart, a session the node runs waits for the node and
  // takes over the same process when it connects. Claude does not ask its
  // open permission requests again, so the saved ones reach the new reader first.
  it("takes over the node's process after a server restart", async () => {
    const original = manager.spawn(LOCAL_HOST_ID, {
      command: process.execPath,
      args: ["-e", ECHO_PROGRAM],
      env: {},
    });
    await waitFor(() => original.started);

    manager = new HostLinkManager();
    const openRequest = JSON.stringify({
      type: "control_request",
      request_id: "r-1",
      request: { subtype: "can_use_tool", tool_name: "Write" },
    });
    const launcher = await coordinatorWith(
      { hostProcId: original.procId, hostClaudeRequests: [openRequest] },
      () => false,
    );
    expect(launcher.hostTakeovers.isAwaiting("s-1")).toBe(true);
    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    const { options } = sdkAdapterLaunches[0]!;
    expect(options.reattach).toBe(true);

    const proc = options.spawnProcess({
      command: "claude",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    expect(proc.procId).toBe(original.procId);
    expect(await readLine(proc)).toBe(`${openRequest}\n`);
    const line = readLine(proc);
    proc.stdin.write("still running\n");
    expect(await line).toBe("STILL RUNNING\n");
    proc.kill("SIGTERM");
  });

  /** The instructions this server builds for the saved session, from a fresh launch of it. */
  async function currentInstructions(): Promise<string> {
    const builder = await coordinatorWith({}, () => false);
    await builder.relaunch("s-1");
    sdkAdapterLaunches.length = 0;
    return builder.getSession("s-1")!.injectedSystemPrompt!;
  }

  /** A process under the node that a previous server started with `instructions`, and the restored server. */
  async function restartWithProcessRunning(instructions: string) {
    const original = manager.spawn(LOCAL_HOST_ID, { command: process.execPath, args: ["-e", ECHO_PROGRAM], env: {} });
    await waitFor(() => original.started);
    manager = new HostLinkManager();
    const launcher = await coordinatorWith(
      { hostProcId: original.procId, injectedSystemPrompt: instructions },
      () => false,
    );
    expect(launcher.hostTakeovers.isAwaiting("s-1")).toBe(true);
    return launcher;
  }

  // Unchanged instructions: the session keeps its running process.
  it("takes over a process that runs the current instructions", async () => {
    const current = await currentInstructions();
    expect(current).toContain("You are Takode session #7.");
    const launcher = await restartWithProcessRunning(current);

    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    expect(sdkAdapterLaunches[0]!.options.reattach).toBe(true);
    expect(launcher.getSession("s-1")?.injectedSystemPrompt).toBe(current);
  });

  // Launches add the user's private default instructions (from the private docs
  // folder) to Takode's. A process started with them runs the current
  // instructions, so the restarted server must include them when it compares,
  // or it would count every such process as outdated and restart its session
  // at the first idle moment.
  it("takes over a process whose current instructions include private defaults", async () => {
    const privateDocsDir = join(tempDir, "private-docs");
    mkdirSync(privateDocsDir);
    writeFileSync(join(privateDocsDir, "default-agent-guidance.md"), "Private default guidance for this machine.\n");
    vi.stubEnv("TAKODE_PRIVATE_DOCS_DIR", privateDocsDir);
    try {
      const current = await currentInstructions();
      expect(current).toContain("Private default guidance for this machine.");
      const launcher = await restartWithProcessRunning(current);
      const tookOver: string[] = [];
      launcher.hostTakeovers.onOutdatedTakeover = (sessionId) => tookOver.push(sessionId);

      link!.drop();
      await waitFor(() => sdkAdapterLaunches.length === 1);
      expect(sdkAdapterLaunches[0]!.options.reattach).toBe(true);
      expect(launcher.getSession("s-1")?.injectedSystemPrompt).toBe(current);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(launcher.hostTakeovers.runsOutdatedInstructions("s-1")).toBe(false);
      expect(tookOver).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A process keeps the instructions it started with (Claude no longer records
  // them, but a running process cannot change them). When the server now
  // builds other ones, the process is still taken over, so a turn under way is
  // not cut off; Session Info keeps showing the instructions it runs, and the
  // server is told so it can restart the session once it is idle.
  it("takes over a process with outdated instructions and reports it for a restart when idle", async () => {
    const launcher = await restartWithProcessRunning("instructions from before the restart");
    const tookOver: string[] = [];
    launcher.hostTakeovers.onOutdatedTakeover = (sessionId) => tookOver.push(sessionId);

    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    expect(sdkAdapterLaunches[0]!.options.reattach).toBe(true);
    expect(tookOver).toEqual(["s-1"]);
    expect(launcher.hostTakeovers.runsOutdatedInstructions("s-1")).toBe(true);
    expect(launcher.getSession("s-1")?.injectedSystemPrompt).toBe("instructions from before the restart");
  });

  // The idle restart stops the session; its next launch is a fresh process with the new instructions.
  it("gives the next fresh launch the current instructions", async () => {
    const current = await currentInstructions();
    const launcher = await restartWithProcessRunning("instructions from before the restart");
    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    sdkAdapterLaunches.length = 0;

    await launcher.kill("s-1");
    expect(launcher.hostTakeovers.runsOutdatedInstructions("s-1")).toBe(false);
    await launcher.relaunch("s-1");
    expect(sdkAdapterLaunches[0]!.options.reattach).toBeFalsy();
    expect(launcher.getSession("s-1")?.injectedSystemPrompt).toBe(current);
  });

  // When the process to take over has ended by the time the SDK spawns (its node
  // restarted), the session starts afresh, so it runs the current instructions.
  it("records the current instructions when the takeover falls back to a fresh process", async () => {
    const current = await currentInstructions();
    const original = manager.spawn(LOCAL_HOST_ID, { command: process.execPath, args: ["-e", ECHO_PROGRAM], env: {} });
    await waitFor(() => original.started && original.pid !== undefined);
    manager = new HostLinkManager();
    const launcher = await coordinatorWith(
      { hostProcId: original.procId, injectedSystemPrompt: "instructions from before the restart" },
      () => false,
    );
    link!.drop();
    await waitFor(() => sdkAdapterLaunches.length === 1);
    expect(launcher.hostTakeovers.runsOutdatedInstructions("s-1")).toBe(true);

    process.kill(original.pid!, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(original.pid!, 0);
        return false;
      } catch {
        return true;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const proc = sdkAdapterLaunches[0]!.options.spawnProcess({
      command: process.execPath,
      args: ["-e", ECHO_PROGRAM],
      env: {},
      signal: new AbortController().signal,
    });
    expect(proc.procId).not.toBe(original.procId);
    expect(launcher.hostTakeovers.runsOutdatedInstructions("s-1")).toBe(false);
    expect(launcher.getSession("s-1")?.injectedSystemPrompt).toBe(current);
    proc.kill("SIGTERM");
  });
});
