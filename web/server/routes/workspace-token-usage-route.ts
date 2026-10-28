import type { Hono } from "hono";
import { WorkspaceTokenUsageSummaryCache, type WorkspaceTokenUsageSession } from "../workspace-token-usage.js";
import { loadCarriedOverTokenUsage } from "../workspace-token-usage-carryover.js";
import type { RouteContext } from "./context.js";

export function registerWorkspaceTokenUsageRoute(
  api: Hono,
  { launcher, wsBridge, sessionStore }: Pick<RouteContext, "launcher" | "wsBridge" | "sessionStore">,
): void {
  const cache = new WorkspaceTokenUsageSummaryCache();
  // Written only by a coordinator handoff while the server is stopped, so read once.
  let carriedOver: Promise<WorkspaceTokenUsageSession[]> | undefined;
  api.get("/sessions/token-usage-by-model", async (c) => {
    carriedOver ??=
      typeof sessionStore?.directory === "string"
        ? loadCarriedOverTokenUsage(sessionStore.directory)
        : Promise.resolve([]);
    const sessions: WorkspaceTokenUsageSession[] = launcher.listSessions().map((session) => ({
      sessionId: session.sessionId,
      source: wsBridge.getSession(session.sessionId),
    }));
    const ownIds = new Set(sessions.map((session) => session.sessionId));
    for (const session of await carriedOver) {
      if (!ownIds.has(session.sessionId)) sessions.push(session);
    }
    return c.json(cache.getSummary(sessions));
  });
}
