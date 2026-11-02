import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN_USAGE_CARRYOVER_FILE } from "../workspace-token-usage-carryover.js";
import { registerWorkspaceTokenUsageRoute } from "./workspace-token-usage-route.js";

// After a coordinator handoff, archived sessions from the previous coordinator
// exist only as carried-over token fields in the sessions folder. The route
// must add them to its own sessions' totals, without counting a session twice
// when it is also one of this coordinator's sessions.

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = await mkdtemp(join(tmpdir(), "token-usage-route-"));
});

afterEach(async () => {
  await rm(sessionsDir, { recursive: true, force: true });
});

function codexState(totalTokens: number) {
  return {
    backend_type: "codex",
    model: "gpt-5.5",
    codex_token_details: {
      totalTokens,
      inputTokens: totalTokens,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      modelContextWindow: 200_000,
    },
  };
}

function buildApp(directory: string | undefined) {
  const api = new Hono();
  const own = { "own-session": { state: codexState(100), messageHistory: [] } };
  registerWorkspaceTokenUsageRoute(api, {
    launcher: { listSessions: () => [{ sessionId: "own-session" }] } as never,
    wsBridge: { getSession: (id: string) => own[id as keyof typeof own] } as never,
    sessionStore: { directory } as never,
  });
  return api;
}

describe("workspace token usage route", () => {
  it("adds sessions carried over from a previous coordinator once", async () => {
    await mkdir(join(sessionsDir, "token-usage"), { recursive: true });
    await writeFile(
      join(sessionsDir, TOKEN_USAGE_CARRYOVER_FILE),
      JSON.stringify({
        version: 1,
        sessions: [
          { sessionId: "archived-elsewhere", state: codexState(1_000) },
          // Also this coordinator's own session: its live state wins.
          { sessionId: "own-session", state: codexState(5_000) },
        ],
      }),
    );

    const res = await buildApp(sessionsDir).request("/sessions/token-usage-by-model");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalTokens).toBe(1_100);
    expect(json.models).toMatchObject([{ model: "gpt-5.5", totalTokens: 1_100, sessionCount: 2 }]);
  });

  it("counts only its own sessions when nothing was carried over", async () => {
    const res = await buildApp(sessionsDir).request("/sessions/token-usage-by-model");

    expect((await res.json()).totalTokens).toBe(100);
  });
});
