import type { Hono } from "hono";
import type { RouteContext } from "./context.js";
import type { AuxiliaryWorktreeLifecycle } from "../auxiliary-worktrees.js";
import { containerManager } from "../container-manager.js";
import * as gitUtils from "../git-utils.js";
import * as treeGroupStore from "../tree-group-store.js";
import { getActorSessionId, getArchiveSource } from "./sessions-helpers.js";
import { broadcastSessionDeletedAndClose } from "./session-lifecycle-broadcast.js";
import { cleanupWorktree } from "./worktree-cleanup.js";
import {
  pickCarriedOverTokenUsageState,
  type WorkspaceTokenUsageRetainedStore,
} from "../workspace-token-usage-carryover.js";
import type { BrowserIncomingMessage } from "../session-types.js";

/**
 * A deleted session still counts toward the workspace's all-time and daily
 * token usage, so its usage is kept before its files go. A failure here only
 * loses that session's usage; it does not stop the deletion.
 */
async function retainDeletedSessionTokenUsage(
  retained: WorkspaceTokenUsageRetainedStore | undefined,
  sessionId: string,
  session: { state?: unknown; messageHistory?: BrowserIncomingMessage[] } | null | undefined,
  sessionNum: number | undefined,
): Promise<void> {
  if (!retained || !session) return;
  const state = pickCarriedOverTokenUsageState(session.state, Date.now(), session.messageHistory);
  if (!state) return;
  await retained
    .retain({ sessionId, ...(Number.isInteger(sessionNum) ? { sessionNum } : {}), state })
    .catch((error) => console.warn(`[token-usage] Could not keep deleted session ${sessionId}'s usage:`, error));
}

export function registerSessionDeleteRoute(
  api: Hono,
  ctx: RouteContext,
  pendingWorktreeCleanups: Map<string, Promise<void>>,
  auxiliary?: AuxiliaryWorktreeLifecycle,
  tokenUsageRetained?: WorkspaceTokenUsageRetainedStore,
) {
  const { resolveId, launcher, authenticateCompanionCallerOptional, wsBridge, worktreeTracker, prPoller, imageStore } =
    ctx;
  api.delete("/sessions/:id", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (pendingWorktreeCleanups.has(id) || auxiliary?.isCleaning(id)) {
      return c.json({ error: "Worktree cleanup is still running" }, 409);
    }

    const registrations = await auxiliary?.registry.list(id);
    if (registrations?.some((record) => record.retention === "temporary" && record.cleanupStatus !== "done")) {
      return c.json(
        {
          error:
            "Archive and resolve temporary worktree cleanup before deleting this session; retained registrations survive deletion",
        },
        409,
      );
    }

    // If not already archived, emit session_archived so the leader gets a
    // herd notification through the same proven path as explicit archiving.
    // Must happen BEFORE kill -- after removal the session info is gone.
    const sessionInfo = launcher.getSession(id);
    if (sessionInfo?.herdedBy && !sessionInfo.archived) {
      const actorId = getActorSessionId(authenticateCompanionCallerOptional(c));
      wsBridge.emitTakodeEvent(id, "session_archived", { archive_source: getArchiveSource(actorId) }, actorId);
    }

    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    const mapping = worktreeTracker.getBySession(id);
    const worktreeResult = mapping ? await cleanupWorktree(mapping, worktreeTracker, true) : undefined;
    // Clean up any stale archived ref from a previous archive cycle. Only
    // checkouts on this machine can have one; never touch a same-named repo
    // here for a session on a remote host.
    if (sessionInfo?.isWorktree && sessionInfo.repoRoot && sessionInfo.actualBranch && !sessionInfo.hostId) {
      await gitUtils.deleteArchivedRefAsync(sessionInfo.repoRoot, sessionInfo.actualBranch);
    }
    prPoller?.unwatch(id);
    await retainDeletedSessionTokenUsage(tokenUsageRetained, id, wsBridge.getSession(id), sessionInfo?.sessionNum);
    launcher.removeSession(id);
    // Broadcast deletion to all browsers BEFORE closing the session sockets.
    // This ensures every browser tab (not just the one that triggered delete)
    // removes the session from the sidebar immediately.
    broadcastSessionDeletedAndClose(wsBridge, id, sessionInfo ?? undefined);
    await imageStore?.removeSession(id);
    // Clean up tree group assignment (fire-and-forget)
    treeGroupStore.removeSession(id).catch((err) => {
      console.warn("[tree-group] cleanup failed for session:", id, err);
    });
    return c.json({ ok: true, worktree: worktreeResult });
  });
}
