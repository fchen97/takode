import { describe, expect, it } from "vitest";
import { reconcileRestoredBoardRows } from "./restored-board-state.js";

function sessionWithRows(questIds: string[]) {
  return {
    board: new Map<string, unknown>(questIds.map((id) => [id, { questId: id }])),
    boardStallStates: new Map<string, unknown>(questIds.map((id) => [id, { stalled: false }])),
  };
}

describe("reconcileRestoredBoardRows", () => {
  // Restore drops only rows whose quest is definitely finished (done) or gone (null),
  // together with their stall state; active, queued and review-stage rows stay.
  it("drops done and missing quests and keeps the rest", async () => {
    const session = sessionWithRows(["q-1", "q-2", "q-3", "q-4"]);
    const statuses: Record<string, string | null> = {
      "q-1": "done",
      "q-2": null,
      "q-3": "in_progress",
      "q-4": "idea",
    };

    await reconcileRestoredBoardRows(session, async (questId) => statuses[questId] ?? null);

    expect([...session.board.keys()]).toEqual(["q-3", "q-4"]);
    expect([...session.boardStallStates.keys()]).toEqual(["q-3", "q-4"]);
  });

  // A status lookup that fails must not lose the row: normal runtime paths decide later.
  it("keeps a row whose quest status cannot be resolved", async () => {
    const session = sessionWithRows(["q-1", "q-2"]);

    await reconcileRestoredBoardRows(session, async (questId) => {
      if (questId === "q-1") throw new Error("quest store unavailable");
      return "done";
    });

    expect([...session.board.keys()]).toEqual(["q-1"]);
  });

  // Without a quest status resolver (early startup or tests) restore leaves the board alone.
  it("leaves the board unchanged without a status resolver", async () => {
    const session = sessionWithRows(["q-1"]);

    await reconcileRestoredBoardRows(session, null);

    expect([...session.board.keys()]).toEqual(["q-1"]);
  });
});
