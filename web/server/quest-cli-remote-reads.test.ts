import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCliWriteServer, type CliWriteServer } from "./test-fixtures/cli-write-server-harness.js";

async function runQuest(
  args: string[],
  home: string,
  port: number,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const questPath = fileURLToPath(new URL("../bin/quest.ts", import.meta.url));
  const child = spawn(process.execPath, [questPath, ...args], {
    env: {
      ...process.env,
      HOME: home,
      COMPANION_PORT: String(port),
      COMPANION_SESSION_ID: undefined,
      TAKODE_REMOTE_HOST: undefined,
      BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR || join(process.env.HOME || "", ".bun/install/cache"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

// A session on another machine runs the quest CLI over a HOME with no quest
// store. Whole-store reads must come from the server, not from that empty store.
describe("quest CLI on a machine without the quest store", () => {
  let serverHome: string;
  let hostHome: string;
  let server: CliWriteServer;

  beforeEach(async () => {
    serverHome = await mkdtemp(join(tmpdir(), "quest-cli-server-"));
    hostHome = await mkdtemp(join(tmpdir(), "quest-cli-host-"));
    server = await startCliWriteServer(serverHome);
  });

  afterEach(async () => {
    await server.stop();
    await rm(serverHome, { recursive: true, force: true });
    await rm(hostHome, { recursive: true, force: true });
  });

  it("lists, greps and counts tags through the server", async () => {
    const run = (args: string[]) => runQuest(args, hostHome, server.port);
    expect((await run(["create", "Alpha task", "--tags", "ui,bug"])).status).toBe(0);
    expect((await run(["create", "Beta task", "--tags", "ui"])).status).toBe(0);

    const listed = JSON.parse((await run(["list", "--tags", "bug", "--json"])).stdout);
    expect(listed.map((quest: { questId: string }) => quest.questId)).toEqual(["q-1"]);

    const grep = JSON.parse((await run(["grep", "Beta", "--json"])).stdout);
    expect(grep.matches.map((match: { questId: string }) => match.questId)).toEqual(["q-2"]);

    expect(JSON.parse((await run(["tags", "--json"])).stdout)).toEqual({ ui: 2, bug: 1 });
  });

  // A server that answers is authoritative: when it has no such quest, the CLI
  // reports that instead of showing a same-numbered quest from a store that
  // happens to exist on this machine (for example an old copy on a host).
  it("trusts the server's not-found over a local store", async () => {
    expect((await runQuest(["create", "Only in the local store"], serverHome, server.port)).status).toBe(0);
    const emptyHome = await mkdtemp(join(tmpdir(), "quest-cli-empty-server-"));
    const emptyServer = await startCliWriteServer(emptyHome);
    try {
      const shown = await runQuest(["show", "q-1"], serverHome, emptyServer.port);
      expect(shown.status).toBe(1);
      expect(shown.stderr).toContain("Quest q-1 not found");
      expect(shown.stdout).not.toContain("Only in the local store");
    } finally {
      await emptyServer.stop();
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  // An older server without a read route answers with its frontend page. That
  // is no answer from the route: on the server's own machine the CLI reads the
  // local store as before, while on a remote host it says the server is too old.
  it("treats a missing read route as no answer, and fails clearly on a remote host", async () => {
    expect((await runQuest(["create", "Read before restart"], serverHome, server.port)).status).toBe(0);
    const older: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html></html>");
    });
    older.listen(0, "127.0.0.1");
    await once(older, "listening");
    const olderPort = (older.address() as AddressInfo).port;
    try {
      const local = await runQuest(["show", "q-1"], serverHome, olderPort);
      expect(local.status).toBe(0);
      expect(local.stdout).toContain("Read before restart");

      const onHost = await runQuest(["show", "q-1"], serverHome, olderPort, { TAKODE_REMOTE_HOST: "1" });
      expect(onHost.status).toBe(1);
      expect(onHost.stderr).toContain("does not support this read yet");
    } finally {
      older.close();
    }
  });

  // On a remote host the coordinator holds the only quest store. When it cannot
  // be reached, reads fail clearly instead of answering from this machine's files.
  it("never reads a local store on a remote host", async () => {
    expect((await runQuest(["create", "Stale host copy"], serverHome, server.port)).status).toBe(0);
    const port = server.port;
    await server.stop();
    const onHost = { TAKODE_REMOTE_HOST: "1" };

    const shown = await runQuest(["show", "q-1"], serverHome, port, onHost);
    expect(shown.status).toBe(1);
    expect(shown.stderr).toContain("keeps no copy of the quest store");
    expect(shown.stdout).not.toContain("Stale host copy");

    const listed = await runQuest(["list"], serverHome, port, onHost);
    expect(listed.status).toBe(1);
    expect(listed.stdout).not.toContain("Stale host copy");
  });

  // A host session whose Takode variables did not reach it (its Codex config
  // dropped them) looks like a CLI on any machine with no server named. With no
  // store of its own to read, it must fail clearly instead of creating an empty
  // store and answering "not found".
  it("fails clearly and creates no store when no server answers and this machine has none", async () => {
    const port = server.port;
    await server.stop();
    const unnamed = await runQuest(["show", "q-1"], hostHome, port, { COMPANION_PORT: undefined });
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain("No Takode server is configured");
    expect(unnamed.stderr).toContain("no quest store of its own");

    const unreachable = await runQuest(["list"], hostHome, port);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain("Cannot reach");
    expect(unreachable.stderr).toContain("no quest store of its own");

    const companionEntries = await readdir(join(hostHome, ".companion")).catch(() => [] as string[]);
    expect(companionEntries).not.toContain("questmaster");
    expect(companionEntries).not.toContain("questmaster-live");
  });
});
