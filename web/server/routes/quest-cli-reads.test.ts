import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { QuestmasterTask } from "../quest-types.js";
import { QUEST_LIST_TEXT_CHARS } from "../quest-text-limits.js";

// `GET /quests/_list` (behind `quest list` and `quest mine`) returns note
// summaries, so one quest holding a huge note cannot make every list huge.

const quests = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("../quest-store.js", () => ({
  listQuests: async () => quests.current,
}));

const { registerQuestCliReadRoutes } = await import("./quest-cli-reads.js");

function app() {
  const api = new Hono();
  registerQuestCliReadRoutes(api);
  return api;
}

describe("GET /quests/_list", () => {
  it("returns note summaries instead of full note bodies", async () => {
    const hugeNote = "ledger ".repeat(100_000);
    quests.current = [
      {
        id: "q-1",
        questId: "q-1",
        version: 1,
        title: "Tracing",
        status: "in_progress",
        createdAt: 1,
        description: "Trace things",
        feedback: [{ author: "agent", text: hugeNote, tldr: "Ledger of traced calls", ts: 2, kind: "phase_summary" }],
      },
    ];

    const response = await app().request("/quests/_list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as (QuestmasterTask & {
      feedback: { text: string; tldr?: string; kind?: string }[];
    })[];

    const note = body[0]!.feedback[0]!;
    // Only the start of the note travels, with a pointer to the full text.
    expect(note.text.length).toBeLessThan(QUEST_LIST_TEXT_CHARS + 100);
    expect(note.text).toContain("quest show q-1 has the full text");
    // What list output shows is kept as is.
    expect(note).toMatchObject({ tldr: "Ledger of traced calls", kind: "phase_summary" });
    expect(body[0]).toMatchObject({ questId: "q-1", title: "Tracing", description: "Trace things" });
  });
});
