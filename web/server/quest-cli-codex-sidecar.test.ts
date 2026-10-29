import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

const questPath = fileURLToPath(new URL("../bin/quest.ts", import.meta.url));
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Quest CLI Codex sidecar execution", () => {
  it("proxies mutations with hook identity and preserves the server command streams", async () => {
    // A normal Codex process must not become a second QuestStore writer. The
    // live server receives argv plus provenance and owns the mutation result.
    const root = await temporaryRoot("quest-codex-rpc-");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({ url: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/integrations/codex/bind") {
        response.end(JSON.stringify({ binding: { id: "binding-1" } }));
        return;
      }
      response.end(JSON.stringify({ exitCode: 7, stdout: "canonical stdout\n", stderr: "canonical stderr\n" }));
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const integrations = join(root, ".companion", "integrations");
    await mkdir(integrations, { recursive: true });
    await writeFile(
      join(integrations, `codex-sidecar-${port}.json`),
      JSON.stringify({
        version: 1,
        baseUrl: `http://127.0.0.1:${port}/api/integrations/codex`,
        capability: "capability",
      }),
    );

    try {
      const result = await runQuest(["delete", "q-12"], {
        HOME: root,
        TAKODE_API_PORT: String(port),
        TAKODE_CODEX_SESSION_ID: "codex-task",
        TAKODE_CODEX_TURN_ID: "turn-1",
        TAKODE_CODEX_TOOL_USE_ID: "tool-1",
        TAKODE_CODEX_CWD: root,
      });

      expect(result).toEqual({ status: 7, stdout: "canonical stdout\n", stderr: "canonical stderr\n" });
      expect(requests[1]).toEqual({
        url: "/api/integrations/codex/quest-command",
        body: {
          args: ["delete", "q-12"],
          actor: {
            kind: "codex_session",
            sessionId: "codex-task",
            turnId: "turn-1",
            toolUseId: "tool-1",
            cwd: root,
          },
        },
      });
    } finally {
      server.close();
    }
  });

  it("executes server-spawned mutations locally with Codex ownership and flat provenance", async () => {
    // Every store path is isolated under a temporary HOME. This covers the
    // non-recursive writer used after the live route has authenticated actor context.
    const root = await temporaryRoot("quest-codex-direct-");
    const env = directEnvironment(root);
    const created = await runQuest(["create", "Direct record", "--desc", "Direct documentation", "--json"], env);
    expect(created.status).toBe(0);
    const createdQuest = JSON.parse(created.stdout);
    expect(createdQuest.createdBy).toMatchObject({
      owner: { kind: "codex", sessionId: "codex-task" },
      turnId: "turn-1",
      toolUseId: "tool-1",
      cwd: root,
    });

    const claimed = await runQuest(["claim", "--json", createdQuest.questId], env);
    expect(claimed.status).toBe(0);
    expect(JSON.parse(claimed.stdout)).toMatchObject({
      status: "in_progress",
      ownerKind: "codex",
      sessionId: "codex-task",
    });

    const feedback = await runQuest(
      ["feedback", "--text-file", "-", "--kind", "artifact", "--json", "add", createdQuest.questId],
      env,
      "Recorded artifact",
    );
    expect(feedback.status).toBe(0);
    expect(JSON.parse(feedback.stdout).feedback[0]).toMatchObject({
      author: "agent",
      kind: "artifact",
      text: "Recorded artifact",
      provenance: { owner: { kind: "codex", sessionId: "codex-task" } },
    });
    expect(JSON.parse(feedback.stdout).feedback[0].phaseId).toBeUndefined();

    const edited = await runQuest(
      ["feedback", "--text", "Updated artifact", "--json", "edit", createdQuest.questId, "0"],
      env,
    );
    expect(edited.status).toBe(0);
    expect(JSON.parse(edited.stdout).feedback[0].text).toBe("Updated artifact");

    const addressed = await runQuest(["address", createdQuest.questId, "0", "--json"], env);
    expect(addressed.status).toBe(0);
    expect(JSON.parse(addressed.stdout).feedback[0].addressed).toBe(true);

    const imagePath = join(root, "evidence.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3r8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const imaged = await runQuest(
      ["feedback", "add", createdQuest.questId, "--text", "Image evidence", "--image", imagePath, "--json"],
      env,
    );
    expect(imaged.status).toBe(0);
    expect(JSON.parse(imaged.stdout).feedback[1].images).toEqual([
      expect.objectContaining({ filename: "evidence.png", mimeType: "image/png" }),
    ]);

    const scoped = await runQuest(
      ["feedback", "add", createdQuest.questId, "--text", "Wrong scope", "--phase", "work"],
      env,
    );
    expect(scoped.status).toBe(1);
    expect(scoped.stderr).toContain("Direct Codex quest feedback is flat");
  });

  it("keeps reads local without resolving ambiguous Companion auth files", async () => {
    // Codex reads need no write provenance and should not fail merely because
    // the cwd has stale auth files for more than one Takode server.
    const root = await temporaryRoot("quest-codex-read-");
    const authDir = getSessionAuthDir(root);
    await mkdir(authDir, { recursive: true });
    for (const [serverId, sessionId] of [
      ["server-a", "worker-a"],
      ["server-b", "worker-b"],
    ]) {
      await writeFile(
        getSessionAuthPath(root, serverId, root),
        JSON.stringify({ sessionId, authToken: `token-${sessionId}`, port: 3456, serverId }),
      );
    }

    // This machine's (empty) store answers the read; without one the CLI would refuse.
    await mkdir(join(root, ".companion", "questmaster-live"), { recursive: true });
    await writeFile(
      join(root, ".companion", "questmaster-live", "store.json"),
      JSON.stringify({ format: "mutable_current_record", version: 1, nextQuestNumber: 1, quests: [] }),
    );

    const result = await runQuest(["list"], {
      HOME: root,
      TAKODE_CODEX_SESSION_ID: "codex-task",
      TAKODE_CODEX_CWD: root,
    });
    expect(result).toEqual({ status: 0, stdout: "No quests found.\n", stderr: "" });
  });

  it("requires claim instead of a direct in-progress transition", async () => {
    // Claim enforces one active quest per provider-aware owner; the generic
    // transition primitive must not bypass that invariant for direct Codex tasks.
    const root = await temporaryRoot("quest-codex-transition-");
    const env = directEnvironment(root);
    const created = JSON.parse(
      (await runQuest(["create", "Claim first", "--desc", "Description", "--status", "refined", "--json"], env)).stdout,
    );
    const result = await runQuest(["transition", created.questId, "--status", "in_progress"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use `quest claim <questId>`");
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function directEnvironment(root: string): Record<string, string> {
  return {
    HOME: root,
    TAKODE_QUEST_SERVER_EXECUTION: "1",
    TAKODE_CODEX_SESSION_ID: "codex-task",
    TAKODE_CODEX_TURN_ID: "turn-1",
    TAKODE_CODEX_TOOL_USE_ID: "tool-1",
    TAKODE_CODEX_CWD: root,
  };
}

async function runQuest(
  args: string[],
  environment: Record<string, string>,
  stdin?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [questPath, ...args], {
    cwd: environment.TAKODE_CODEX_CWD ?? environment.HOME,
    env: {
      ...process.env,
      COMPANION_SESSION_ID: undefined,
      COMPANION_AUTH_TOKEN: undefined,
      COMPANION_PORT: undefined,
      COMPANION_SERVER_ID: undefined,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  if (stdin !== undefined) child.stdin.write(stdin);
  child.stdin.end();
  const [status] = await once(child, "close");
  return { status: status as number | null, stdout, stderr };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
