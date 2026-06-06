import type { Hono } from "hono";
import { WorkspaceTokenUsageSummaryCache } from "../workspace-token-usage.js";
import type { RouteContext } from "./context.js";

export function registerWorkspaceTokenUsageRoute(
  api: Hono,
  { launcher, wsBridge }: Pick<RouteContext, "launcher" | "wsBridge">,
): void {
  const cache = new WorkspaceTokenUsageSummaryCache();
  api.get("/sessions/token-usage-by-model", (c) => {
    const sessions = launcher.listSessions().map((session) => ({
      sessionId: session.sessionId,
      source: wsBridge.getSession(session.sessionId),
    }));
    return c.json(cache.getSummary(sessions));
  });
}
