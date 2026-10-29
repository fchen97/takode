import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";
import { QUEST_LEADER_RECOVERY_WARNING_HEADER } from "./quest-recovery.js";
import { startCliWriteServer } from "./test-fixtures/cli-write-server-harness.js";

type JsonObject = Record<string, unknown>;

/** Every quest store file under HOME with its contents, for detecting any write. */
function snapshotQuestStore(home: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const dir of ["questmaster", "questmaster-live"]) {
    const root = join(home, ".companion", dir);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      snapshot[path] = readFileSync(path, "utf-8");
    }
  }
  return snapshot;
}

function centralAuthPath(cwd: string, home?: string, serverId = "test-server-id"): string {
  return getSessionAuthPath(cwd, serverId, home);
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      resolve(body ? (JSON.parse(body) as JsonObject) : {});
    });
  });
}

async function runQuest(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const questPath = fileURLToPath(new URL("../bin/quest.ts", import.meta.url));
  const child = spawn(process.execPath, [questPath, ...args], {
    env: {
      ...env,
      BUN_INSTALL_CACHE_DIR:
        env.BUN_INSTALL_CACHE_DIR ||
        process.env.BUN_INSTALL_CACHE_DIR ||
        join(process.env.HOME || "", ".bun/install/cache"),
    },
    cwd,
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

describe("quest CLI status safety", () => {
  it("documents create-refined and status override flags", async () => {
    const result = await runQuest(["--help"], { ...process.env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("quest create --title-file title.txt --desc-file body.md --status refined");
    expect(result.stdout).toContain("complete <id>");
    expect(result.stdout).toContain("[--force --reason <text>]");
    expect(result.stdout).toContain("transition <id> --status <s>");
  });

  it("creates a refined quest directly with --status refined", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-status-refined-"));
    const server = await startCliWriteServer(tmp);

    try {
      const result = await runQuest(
        ["create", "Ready quest", "--desc", "Approved scope", "--status", "refined"],
        {
          ...process.env,
          COMPANION_PORT: String(server.port),
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('Created q-1: "Ready quest" (refined)');
      expect(result.stdout).toContain("Use this exact quest ID for follow-up commands: q-1");
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defaults local quest creation session-space metadata from the session environment", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-create-session-space-env-"));
    const server = await startCliWriteServer(tmp);

    try {
      const result = await runQuest(
        ["create", "Space quest", "--json"],
        {
          ...process.env,
          COMPANION_PORT: String(server.port),
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ questId: "q-1", sessionSpaceSlug: "MSI" });
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets quest create and edit override session-space metadata explicitly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-session-space-override-"));
    const server = await startCliWriteServer(tmp);

    try {
      const createResult = await runQuest(
        ["create", "Override quest", "--session-space", "Research", "--json"],
        {
          ...process.env,
          COMPANION_PORT: String(server.port),
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_MEMORY_SPACE_SLUG: "MSI",
          HOME: tmp,
        },
        tmp,
      );
      expect(createResult.status).toBe(0);
      expect(JSON.parse(createResult.stdout)).toMatchObject({ questId: "q-1", sessionSpaceSlug: "Research" });

      const editResult = await runQuest(
        ["edit", "q-1", "--session-space", "Other", "--json"],
        {
          ...process.env,
          COMPANION_PORT: String(server.port),
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );
      expect(editResult.status).toBe(0);
      expect(editResult.stderr).toBe("");
      expect(JSON.parse(editResult.stdout)).toMatchObject({ questId: "q-1", sessionSpaceSlug: "Other" });
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sends transition force reasons to the status endpoint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-transition-force-http-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);
    const seenBodies: JsonObject[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/quests/q-1/transition") {
        seenBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ questId: "q-1", title: "Quest", status: "done", description: "Ready" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "session-file", authToken: "file-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runQuest(
        [
          "transition",
          "q-1",
          "--status",
          "done",
          "--desc",
          "Ready",
          "--force",
          "--reason",
          "leader approved recovery",
          "--json",
        ],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(seenBodies[0]).toMatchObject({
        status: "done",
        description: "Ready",
        sessionId: "session-file",
        force: true,
        reason: "leader approved recovery",
      });
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints compact server leader-recovery warnings for forced completion", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-force-warning-http-"));
    const authDir = getSessionAuthDir(tmp);
    mkdirSync(authDir, { recursive: true });
    const authPath = centralAuthPath(tmp, tmp);
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/quests/q-1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ questId: "q-1", title: "Quest", status: "in_progress", sessionId: "worker-1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/quests/q-1/complete") {
        await readJson(req);
        res.writeHead(200, {
          "content-type": "application/json",
          [QUEST_LEADER_RECOVERY_WARNING_HEADER]: "Leader recovery used by leader-1; audit recorded 2 checks.",
        });
        res.end(JSON.stringify({ questId: "q-1", title: "Quest", status: "done", verificationItems: [] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    writeFileSync(
      authPath,
      JSON.stringify({ sessionId: "leader-1", authToken: "file-token", port, serverId: "test-server-id" }),
      "utf-8",
    );

    try {
      const result = await runQuest(
        ["complete", "q-1", "--force", "--reason", "worker unavailable"],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          COMPANION_PORT: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Warning: Leader recovery used by leader-1");
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Forced recovery, like every quest write, never falls back to writing the local store.
  it("refuses local filesystem fallback for forced completion recovery", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-complete-force-local-refuse-"));

    try {
      const result = await runQuest(
        ["complete", "q-1", "--force", "--reason", "worker unavailable"],
        {
          ...process.env,
          COMPANION_PORT: undefined,
          COMPANION_SESSION_ID: "leader-1",
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      // The command's read of the quest already finds no server and no local store to ask.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No Takode server is configured");
      expect(existsSync(join(tmp, ".companion", "questmaster-live", "store.json"))).toBe(false);
      expect(existsSync(join(tmp, ".companion", "questmaster", "_quest_counter.json"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The server is the only writer of quest data. When it cannot be reached, every write
  // command fails with a clear error and leaves an existing local store untouched.
  it("fails writes clearly and never touches the local store when the server is unreachable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "quest-writes-server-unreachable-"));
    const server = await startCliWriteServer(tmp);
    const env = (port: number) => ({
      ...process.env,
      COMPANION_PORT: String(port),
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      HOME: tmp,
    });

    try {
      const seeded = await runQuest(["create", "Seeded quest", "--desc", "Exists before"], env(server.port), tmp);
      expect(seeded.status).toBe(0);
      const deadPort = server.port;
      await server.stop();
      const storeBefore = snapshotQuestStore(tmp);
      expect(Object.keys(storeBefore).length).toBeGreaterThan(0);

      const writes = [
        ["create", "Second quest"],
        ["edit", "q-1", "--title", "Renamed"],
        ["transition", "q-1", "--status", "refined"],
        ["claim", "q-1", "--session", "worker-1"],
        ["feedback", "q-1", "--text", "Note", "--author", "human"],
        ["check", "q-1", "0"],
        ["later", "q-1"],
        ["cancel", "q-1"],
        ["delete", "q-1"],
      ];
      for (const args of writes) {
        const result = await runQuest(args, env(deadPort), tmp);
        expect({ args, status: result.status }).toEqual({ args, status: 1 });
        // `check` reads the quest first and stops before writing because it has no review checks.
        if (args[0] !== "check") {
          expect(result.stderr).toContain(`Cannot reach the Takode server at http://localhost:${deadPort}`);
        }
      }

      expect(snapshotQuestStore(tmp)).toEqual(storeBefore);
      const reads = await runQuest(["show", "q-1"], env(deadPort), tmp);
      expect(reads.status).toBe(0);
      expect(reads.stdout).toContain("Seeded quest");
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
