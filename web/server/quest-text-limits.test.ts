import { describe, expect, it } from "vitest";
import type { QuestmasterTask } from "./quest-types.js";
import {
  MAX_QUEST_TEXT_BYTES,
  QuestTextTooLargeError,
  assertQuestTextWithinLimit,
  shortenQuestListText,
  summarizeQuestForList,
} from "./quest-text-limits.js";

// Pure checks of the quest text limit and list summaries. A small limit keeps
// the inputs tiny; the store test (quest-store-text-limit.test.ts) uses the real one.
const LIMIT = 100;

function quest(fields: Record<string, unknown>): QuestmasterTask {
  return { id: "q-1", questId: "q-1", version: 1, title: "Quest", status: "idea", createdAt: 1, ...fields } as never;
}

describe("assertQuestTextWithinLimit", () => {
  it("refuses a new note over the limit and names where it is", () => {
    const before = quest({ feedback: [{ author: "agent", text: "short", ts: 1 }] });
    const after = quest({
      feedback: [
        { author: "agent", text: "short", ts: 1 },
        { author: "agent", text: "x".repeat(LIMIT + 1), ts: 2 },
      ],
    });
    expect(() => assertQuestTextWithinLimit([before], [after], LIMIT)).toThrow(QuestTextTooLargeError);
    expect(() => assertQuestTextWithinLimit([before], [after], LIMIT)).toThrow(/q-1 feedback #1 text is .* MB/);
    // The message tells the writer where large content belongs.
    expect(() => assertQuestTextWithinLimit([before], [after], LIMIT)).toThrow(/file or a Library artifact/);
  });

  it("refuses an oversized description on a new quest", () => {
    const created = quest({ description: "d".repeat(LIMIT + 1) });
    expect(() => assertQuestTextWithinLimit([], [created], LIMIT)).toThrow(/q-1 description/);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 40 three-byte characters are 120 bytes, over a 100-byte limit.
    const created = quest({ tldr: "語".repeat(40) });
    expect(() => assertQuestTextWithinLimit([], [created], LIMIT)).toThrow(QuestTextTooLargeError);
    expect(() => assertQuestTextWithinLimit([], [quest({ tldr: "語".repeat(33) })], LIMIT)).not.toThrow();
  });

  it("allows an edit to a quest that already holds an oversized note", () => {
    // Notes written before the limit existed stay; the quest can still change around them.
    const huge = "y".repeat(LIMIT * 5);
    const before = quest({ feedback: [{ author: "agent", text: huge, ts: 1 }] });
    const after = quest({
      status: "done",
      cancelled: true,
      feedback: [
        { author: "agent", text: huge, ts: 1 },
        { author: "agent", text: "pointer to the ledger file", ts: 2 },
      ],
    });
    expect(() => assertQuestTextWithinLimit([before], [after], LIMIT)).not.toThrow();
  });

  it("refuses replacing an oversized note with a different oversized one, but allows shrinking it", () => {
    const before = quest({ feedback: [{ author: "agent", text: "y".repeat(LIMIT * 5), ts: 1 }] });
    const grown = quest({ feedback: [{ author: "agent", text: "z".repeat(LIMIT * 5), ts: 1 }] });
    const shrunk = quest({ feedback: [{ author: "agent", text: "see ledger.json", ts: 1 }] });
    expect(() => assertQuestTextWithinLimit([before], [grown], LIMIT)).toThrow(QuestTextTooLargeError);
    expect(() => assertQuestTextWithinLimit([before], [shrunk], LIMIT)).not.toThrow();
  });

  it("does not inspect quests the change left untouched", () => {
    const untouched = quest({ description: "u".repeat(LIMIT * 5) });
    expect(() => assertQuestTextWithinLimit([untouched], [untouched], LIMIT)).not.toThrow();
  });

  it("defaults to a 1 MB limit", () => {
    expect(MAX_QUEST_TEXT_BYTES).toBe(1024 * 1024);
  });
});

describe("summarizeQuestForList", () => {
  it("shortens long note bodies and descriptions and keeps everything else", () => {
    const original = quest({
      description: "d".repeat(50),
      feedback: [
        { author: "agent", text: "n".repeat(50), tldr: "short tldr", ts: 7, kind: "phase_summary" },
        { author: "human", text: "ok", ts: 8 },
      ],
    });
    const listed = summarizeQuestForList(original, 10) as QuestmasterTask & {
      description: string;
      feedback: { text: string; tldr?: string; ts: number; kind?: string }[];
    };
    expect(listed.description).toBe(`${"d".repeat(10)}… [40 more characters; quest show q-1 has the full text]`);
    expect(listed.feedback[0]!.text.startsWith("n".repeat(10) + "…")).toBe(true);
    expect(listed.feedback[0]).toMatchObject({ tldr: "short tldr", ts: 7, kind: "phase_summary" });
    expect(listed.feedback[1]!.text).toBe("ok");
    expect(listed.title).toBe("Quest");
    // The stored quest is not modified.
    expect((original as { description?: string }).description).toBe("d".repeat(50));
  });

  it("returns the same quest when nothing is long", () => {
    const original = quest({ description: "short", feedback: [{ author: "agent", text: "hi", ts: 1 }] });
    expect(summarizeQuestForList(original, 10)).toBe(original);
  });

  it("does not split a surrogate pair", () => {
    // "😀" is two UTF-16 code units; cutting after 3 units would leave half of one.
    const shortened = shortenQuestListText("ab😀cd", 3, "q-1");
    expect(shortened.startsWith("ab…")).toBe(true);
  });
});
