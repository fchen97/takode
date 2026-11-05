import type { Hono } from "hono";
import { WorkspaceTokenUsageSummaryCache, type WorkspaceTokenUsageSession } from "../workspace-token-usage.js";
import { WorkspaceTokenUsageRetainedStore } from "../workspace-token-usage-carryover.js";
import type { RouteContext } from "./context.js";

export function registerWorkspaceTokenUsageRoute(
  api: Hono,
  { launcher, wsBridge, sessionStore }: Pick<RouteContext, "launcher" | "wsBridge" | "sessionStore">,
  retained = new WorkspaceTokenUsageRetainedStore(
    typeof sessionStore?.directory === "string" ? sessionStore.directory : undefined,
  ),
): void {
  const cache = new WorkspaceTokenUsageSummaryCache();
  api.get("/sessions/token-usage-by-model", async (c) => {
    const backfill = await retained.backfillSessions();
    const sessions: WorkspaceTokenUsageSession[] = launcher.listSessions().map((session) => ({
      sessionId: session.sessionId,
      source: wsBridge.getSession(session.sessionId),
      backfill: backfill.get(session.sessionId),
    }));
    // Sessions this coordinator no longer has: archived on a previous coordinator, or deleted.
    const ownIds = new Set(sessions.map((session) => session.sessionId));
    for (const session of await retained.carriedOverSessions()) {
      if (!ownIds.has(session.sessionId)) sessions.push({ ...session, backfill: backfill.get(session.sessionId) });
    }
    return c.json(cache.getSummary(sessions));
  });
}
