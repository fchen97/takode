import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readQuestFixture, writeQuestStoreFixture } from "./test-fixtures/quest-store-fixture.js";

// The quest text limit as the store applies it, on an isolated temporary
// `~/.companion`: every store change is checked before anything is written,
// and quests that already hold oversized notes keep loading and changing.

let tempDir: string;
let questStore: typeof import("./quest-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (next: string) => {
      dir = next;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

const OVER_LIMIT = "x".repeat(1024 * 1024 + 1);
// A note written before the limit existed.
const EXISTING_HUGE_NOTE = "ledger ".repeat(300_000);

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quest-store-text-limit-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
  writeQuestStoreFixture(companionDir(), {
    quests: [
      {
        id: "q-1",
        questId: "q-1",
        version: 1,
        title: "Tracing",
        status: "in_progress",
        sessionId: "worker-1",
        claimedAt: 1,
        createdAt: 1,
        description: "Trace things",
        feedback: [{ author: "agent", text: EXISTING_HUGE_NOTE, ts: 2 }],
      },
    ],
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function companionDir(): string {
  return join(tempDir, ".companion");
}

function storedFeedback(questId: string): { text: string }[] {
  return (readQuestFixture(companionDir(), questId)?.feedback ?? []) as { text: string }[];
}

describe("quest text limit in the store", () => {
  it("still lists and shows a quest holding an oversized note", async () => {
    const quest = await questStore.getQuest("q-1");
    expect(quest && "feedback" in quest ? quest.feedback?.[0]?.text : undefined).toBe(EXISTING_HUGE_NOTE);
    expect((await questStore.listQuests()).map((q) => q.questId)).toEqual(["q-1"]);
  });

  it("refuses a new oversized note and leaves the stored quest unchanged", async () => {
    const current = await questStore.getQuest("q-1");
    const feedback = current && "feedback" in current ? (current.feedback ?? []) : [];
    await expect(
      questStore.patchQuest("q-1", { feedback: [...feedback, { author: "agent", text: OVER_LIMIT, ts: 3 }] }),
    ).rejects.toThrow(/q-1 feedback #1 text is 1\.0 MB, over the 1 MB limit for quest text/);
    expect(storedFeedback("q-1")).toHaveLength(1);
  });

  it("refuses creating a quest with an oversized description", async () => {
    await expect(questStore.createQuest({ title: "Big", description: OVER_LIMIT })).rejects.toThrow(
      /description is .* over the 1 MB limit/,
    );
    expect(readQuestFixture(companionDir(), "q-2")).toBeUndefined();
  });

  it("lets a quest holding an oversized note take a small note and be cancelled", async () => {
    const current = await questStore.getQuest("q-1");
    const feedback = current && "feedback" in current ? (current.feedback ?? []) : [];
    await questStore.patchQuest("q-1", {
      feedback: [...feedback, { author: "agent", text: "Ledger moved to ledger.json", ts: 3 }],
    });
    expect(storedFeedback("q-1").map((entry) => entry.text.length)).toEqual([
      EXISTING_HUGE_NOTE.length,
      "Ledger moved to ledger.json".length,
    ]);

    const cancelled = await questStore.cancelQuest("q-1", "Superseded");
    expect(cancelled?.status).toBe("done");
    expect(storedFeedback("q-1")[0]?.text).toBe(EXISTING_HUGE_NOTE);
  });
});
