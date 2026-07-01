import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

type JsonObject = Record<string, unknown>;

function centralAuthPath(cwd: string, home: string, serverId = "test-server-id"): string {
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

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
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

function seedAuthFile(home: string, cwd: string, port: number, sessionId: string, authToken: string): string {
  const authPath = centralAuthPath(cwd, home);
  mkdirSync(getSessionAuthDir(home), { recursive: true });
  writeFileSync(
    authPath,
    JSON.stringify({
      sessionId,
      authToken,
      port,
      serverId: "test-server-id",
    }),
    "utf-8",
  );
  return authPath;
}

describe("takode spawn auth stability", () => {
  it("keeps the leader auth context for reviewer initial message when session-auth is overwritten mid-command", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-spawn-auth-cache-"));
    const createBodies: JsonObject[] = [];
    const messageCalls: Array<{
      headers: Record<string, string | string[] | undefined>;
      body: JsonObject;
    }> = [];
    let port = 0;
    let authPath = "";

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-file", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-file") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-file",
            sessionNum: 7,
            name: "Leader File",
            permissionMode: "plan",
            backendType: "claude",
            cwd: tmp,
          }),
        );
        return;
      }
      if (method === "GET" && url === "/api/takode/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ sessionId: "parent-worker", sessionNum: 42, archived: false, cwd: tmp }]));
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        writeFileSync(
          authPath,
          JSON.stringify({
            sessionId: "reviewer-file",
            authToken: "reviewer-token",
            port,
            serverId: "test-server-id",
          }),
          "utf-8",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "reviewer-file" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/reviewer-file/message") {
        messageCalls.push({ headers: req.headers, body: await readJson(req) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/reviewer-file/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "reviewer-file",
            sessionNum: 52,
            name: "Reviewer File",
            state: "running",
            backendType: "claude",
            cwd: tmp,
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: false,
            reviewerOf: 42,
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
    authPath = seedAuthFile(tmp, tmp, port, "leader-file", "leader-token");

    try {
      const result = await runTakode(
        ["spawn", "--reviewer", "42", "--message", "review this", "--json", "--port", String(port)],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(createBodies).toHaveLength(1);
      expect(createBodies[0]).toEqual(
        expect.objectContaining({
          reviewerOf: 42,
          cwd: tmp,
          useWorktree: false,
          createdBy: "leader-file",
        }),
      );
      expect(messageCalls).toEqual([
        {
          headers: expect.objectContaining({
            "x-companion-session-id": "leader-file",
            "x-companion-auth-token": "leader-token",
          }),
          body: {
            content: "review this",
            agentSource: { sessionId: "leader-file", sessionLabel: "#7 Leader File" },
          },
        },
      ]);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the leader auth context for no-worktree worker initial message when session-auth is overwritten mid-command", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "takode-spawn-worker-auth-cache-"));
    const createBodies: JsonObject[] = [];
    const messageHeaders: Record<string, string | string[] | undefined>[] = [];
    let port = 0;
    let authPath = "";

    const server = createServer(async (req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-file", isOrchestrator: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/leader-file") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "leader-file",
            sessionNum: 7,
            name: "Leader File",
            permissionMode: "plan",
            backendType: "claude",
            cwd: tmp,
          }),
        );
        return;
      }
      if (method === "POST" && url === "/api/sessions/create") {
        createBodies.push(await readJson(req));
        writeFileSync(
          authPath,
          JSON.stringify({
            sessionId: "worker-file",
            authToken: "worker-token",
            port,
            serverId: "test-server-id",
          }),
          "utf-8",
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-file" }));
        return;
      }
      if (method === "POST" && url === "/api/sessions/worker-file/message") {
        messageHeaders.push(req.headers);
        await readJson(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (method === "GET" && url === "/api/sessions/worker-file/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-file",
            sessionNum: 53,
            name: "Worker File",
            state: "running",
            backendType: "claude",
            cwd: tmp,
            createdAt: Date.now(),
            cliConnected: true,
            isGenerating: false,
            isWorktree: false,
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
    authPath = seedAuthFile(tmp, tmp, port, "leader-file", "leader-token");

    try {
      const result = await runTakode(
        ["spawn", "--no-worktree", "--message", "do this", "--json", "--port", String(port)],
        {
          ...process.env,
          COMPANION_SESSION_ID: undefined,
          COMPANION_AUTH_TOKEN: undefined,
          HOME: tmp,
        },
        tmp,
      );

      expect(result.status).toBe(0);
      expect(createBodies).toEqual([
        expect.objectContaining({
          cwd: expect.stringContaining("takode-spawn-worker-auth-cache-"),
          useWorktree: false,
          createdBy: "leader-file",
        }),
      ]);
      expect(messageHeaders).toEqual([
        expect.objectContaining({
          "x-companion-session-id": "leader-file",
          "x-companion-auth-token": "leader-token",
        }),
      ]);
    } finally {
      server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
