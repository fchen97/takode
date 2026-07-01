import type { Hono } from "hono";
import { buildWorkspaceTokenUsageByModel } from "../workspace-token-usage.js";
import type { RouteContext } from "./context.js";

export function registerWorkspaceTokenUsageRoute(
  api: Hono,
  { launcher, wsBridge }: Pick<RouteContext, "launcher" | "wsBridge">,
): void {
  api.get("/sessions/token-usage-by-model", (c) => {
    const sessions = launcher.listSessions().map((session) => ({
      sessionId: session.sessionId,
      source: wsBridge.getSession(session.sessionId),
    }));
    return c.json(buildWorkspaceTokenUsageByModel(sessions));
  });
}
