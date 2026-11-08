import type { Hono } from "hono";
import { listQuests } from "../quest-store.js";
import { applyQuestListFilters } from "../quest-list-filters.js";
import { summarizeQuestForList } from "../quest-text-limits.js";
import { grepQuests, type QuestGrepResponse } from "../quest-grep.js";
import type { QuestmasterTask } from "../quest-types.js";
import { getQuestOwner, sameQuestOwner, type QuestOwnerRef } from "../../shared/quest-owner.js";

/**
 * Whole-store reads for the `quest` CLI (`list`, `mine`, `grep`, `tags`). The
 * server answers them from its cached store, so a CLI on a machine without the
 * quest store gets the same results and only the matching quests travel.
 */
export function registerQuestCliReadRoutes(api: Hono): void {
  api.get("/quests/_list", async (c) => {
    const query = (name: string) => c.req.query(name) || undefined;
    const ownerKind = query("ownerKind");
    const ownerSession = query("ownerSession");
    const owner = ownerKind && ownerSession ? ({ kind: ownerKind, sessionId: ownerSession } as QuestOwnerRef) : null;
    const quests = applyQuestListFilters(await listQuests(), {
      status: query("status"),
      tags: query("tags"),
      tag: query("tag"),
      session: query("session"),
      text: query("text"),
      verification: query("verification"),
    });
    const listed = owner ? quests.filter((quest) => sameQuestOwner(getQuestOwner(quest), owner)) : quests;
    // Note summaries, not full note bodies: one quest holding a huge note must not make every list huge.
    return c.json(listed.map((quest) => summarizeQuestForList(quest)));
  });

  api.get("/quests/_grep", async (c) => {
    const limit = Number(c.req.query("count"));
    try {
      return c.json(grepQuestsForCli(await listQuests(), c.req.query("q") ?? "", Number.isInteger(limit) ? limit : 50));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  api.get("/quests/_tag-counts", async (c) => {
    const counts: Record<string, number> = {};
    for (const quest of await listQuests()) {
      for (const tag of quest.tags ?? []) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return c.json(counts);
  });
}

/** A `quest grep` result plus the time of each matched feedback entry, which the text output shows. */
export interface QuestCliGrep {
  grep: QuestGrepResponse;
  /** Feedback entry times keyed by `<questId>:<feedbackIndex>`. */
  feedbackTimes: Record<string, number>;
}

export function grepQuestsForCli(quests: QuestmasterTask[], query: string, limit: number): QuestCliGrep {
  const grep = grepQuests(quests, query, { limit });
  const byId = new Map(quests.map((quest) => [quest.questId, quest]));
  const feedbackTimes: Record<string, number> = {};
  for (const match of grep.matches) {
    if (match.feedbackIndex === undefined) continue;
    const quest = byId.get(match.questId);
    const ts = quest && "feedback" in quest ? quest.feedback?.[match.feedbackIndex]?.ts : undefined;
    if (ts) feedbackTimes[`${match.questId}:${match.feedbackIndex}`] = ts;
  }
  return { grep, feedbackTimes };
}
