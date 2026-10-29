import { FakeHostLink } from "../test-fixtures/fake-host-link.js";
import { HostAgent } from "./host-agent.js";
import { HostLinkManager } from "./host-link-manager.js";
import { remoteSubprocess } from "./remote-subprocess.js";

/** Stands in for `codex app-server`: echoes each stdin line back with the env value it was started with. */
const FAKE_CODEX = [
  "process.stdin.on('data', (chunk) => process.stdout.write(process.env.PREPARED_BY + ':' + String(chunk)));",
  "process.stdin.on('end', () => process.exit(0));",
].join("\n");

describe("Codex on a remote host", () => {
  const hostId = "host-1";
  let agent: HostAgent;

  afterEach(() => agent?.stop());

  // The host prepares the launch with its own installation; the coordinator gets
  // only the adapter settings and starts the prepared command by id. The process
  // then looks like a Bun subprocess with no local pid.
  it("prepares on the host, starts the prepared command and exposes it as a subprocess", async () => {
    const manager = new HostLinkManager();
    const prepareCalls: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
    agent = new HostAgent({
      coordinatorUrl: "http://coordinator.test",
      token: "token",
      apiProxyPort: 45_678,
      commands: { codex: "/opt/host/codex" },
      log: () => {},
      connect: () => new FakeHostLink(manager, hostId).agentSide,
      prepareCodexLaunch: async (sessionId, _info, options) => {
        prepareCalls.push({ sessionId, options });
        return {
          spawnCmd: [process.execPath, "-e", FAKE_CODEX],
          spawnEnv: { PREPARED_BY: "host" },
          spawnCwd: undefined,
          sandboxMode: "workspace-write",
        };
      },
    });
    agent.start();
    while (!manager.status(hostId).online) await new Promise((resolve) => setTimeout(resolve, 10));

    const prepared = await manager.request(
      hostId,
      {
        kind: "prepare_codex",
        sessionId: "s-1",
        info: { cwd: "/srv" },
        options: { codexBinary: "/coordinator/codex" },
      },
      5_000,
    );
    // The host's own Codex replaces the coordinator's binary path, and the launch
    // names TAKODE_REMOTE_HOST so the session's Codex config passes it to commands.
    expect(prepareCalls).toEqual([
      {
        sessionId: "s-1",
        options: { codexBinary: "/opt/host/codex", codexHome: undefined, env: { TAKODE_REMOTE_HOST: "1" } },
      },
    ]);
    expect(prepared.adapterSettings).toEqual({ sandboxMode: "workspace-write" });

    const proc = remoteSubprocess(
      manager.spawn(hostId, { command: "codex", args: [], env: {}, preparedLaunchId: prepared.launchId }),
    );
    expect(proc.pid).toBeUndefined();
    const stdin = proc.stdin as unknown as { write(data: Uint8Array): number; end(): void };
    expect(stdin.write(new TextEncoder().encode("ping\n"))).toBe(5);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("host:ping\n");
    stdin.end();
    expect(await proc.exited).toBe(0);
  });

  // A prepared launch keeps its environment on the host and its spawn command
  // carries none, so the API port rewrite must read the prepared environment:
  // a leader's TAKODE_API_PORT, like COMPANION_PORT, moves from the coordinator's
  // port to this host's API proxy, and a worker still gets no TAKODE_API_PORT.
  it("points a prepared leader's TAKODE_API_PORT at the host's API proxy and gives workers none", async () => {
    const manager = new HostLinkManager();
    const printPorts =
      "process.stdout.write(JSON.stringify({ companion: process.env.COMPANION_PORT ?? null, api: process.env.TAKODE_API_PORT ?? null }));";
    agent = new HostAgent({
      coordinatorUrl: "http://coordinator.test",
      token: "token",
      apiProxyPort: 45_678,
      commands: { codex: "/opt/host/codex" },
      log: () => {},
      connect: () => new FakeHostLink(manager, hostId).agentSide,
      prepareCodexLaunch: async (_sessionId, _info, options) => ({
        spawnCmd: [process.execPath, "-e", printPorts],
        spawnEnv: options.env as Record<string, string>,
        spawnCwd: undefined,
      }),
    });
    agent.start();
    while (!manager.status(hostId).online) await new Promise((resolve) => setTimeout(resolve, 10));

    const portsSeenBy = async (env: Record<string, string>) => {
      const prepared = await manager.request(
        hostId,
        { kind: "prepare_codex", sessionId: "s-1", info: { cwd: "/srv" }, options: { env } },
        5_000,
      );
      const proc = remoteSubprocess(
        manager.spawn(hostId, { command: "codex", args: [], env: {}, preparedLaunchId: prepared.launchId }),
      );
      const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      expect(await proc.exited).toBe(0);
      return JSON.parse(output);
    };

    const leaderEnv = { COMPANION_PORT: "3456", TAKODE_API_PORT: "3456", TAKODE_ROLE: "orchestrator" };
    expect(await portsSeenBy(leaderEnv)).toEqual({ companion: "45678", api: "45678" });
    expect(await portsSeenBy({ COMPANION_PORT: "3456" })).toEqual({ companion: "45678", api: null });
  });
});
