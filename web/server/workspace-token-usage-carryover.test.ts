import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeCarriedOverTokenUsage,
  parseCarriedOverTokenUsage,
  parseTokenUsageBackfill,
  pickCarriedOverTokenUsageState,
  TOKEN_USAGE_BACKFILL_FILE,
  TOKEN_USAGE_CARRYOVER_FILE,
  WorkspaceTokenUsageRetainedStore,
} from "./workspace-token-usage-carryover.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function localDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

describe("token usage carry-over", () => {
  it("carries a session's ledger, derived from its old samples when needed, with only the days still kept", () => {
    // Days older than the kept window can never reach the 30-day chart again,
    // and the all-time totals do not depend on them.
    const now = new Date(2026, 10, 5, 12).getTime();
    const picked = pickCarriedOverTokenUsageState(
      {
        backend_type: "codex",
        model: "gpt-5.5",
        cwd: "/repo",
        codex_token_details: {
          totalTokens: 900,
          inputTokens: 900,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          modelContextWindow: 1,
        },
        token_usage_samples: [
          { timestamp: now - 90 * DAY_MS, backend: "codex", model: "gpt-5.5", totalTokens: 100 },
          { timestamp: now - 60 * DAY_MS, backend: "codex", model: "gpt-5.5", totalTokens: 500 },
          { timestamp: now - 2 * DAY_MS, backend: "codex", model: "gpt-5.5", totalTokens: 900 },
        ],
      },
      now,
    );

    expect(Object.keys(picked!).sort()).toEqual(["backend_type", "model", "token_usage_ledger"]);
    expect(picked!.token_usage_ledger!.totals["gpt-5.5"].totalTokens).toBe(900);
    expect(picked!.token_usage_ledger!.convertedDays).toEqual({
      [localDateString(now - 2 * DAY_MS)]: { "gpt-5.5": 400 },
    });
  });

  it("skips sessions without usage", () => {
    const now = 200 * DAY_MS;
    expect(pickCarriedOverTokenUsageState({ backend_type: "codex", model: "gpt-5.5" }, now)).toBeNull();
    expect(pickCarriedOverTokenUsageState(undefined, now)).toBeNull();
  });

  it("merges a new handoff's sessions into earlier carry-overs and ignores malformed files", () => {
    const earlier = parseCarriedOverTokenUsage({
      version: 1,
      sessions: [{ sessionId: "a", state: { model: "old" } }, { sessionId: 3 }, "junk"],
    });
    expect(earlier).toEqual([{ sessionId: "a", state: { model: "old" } }]);
    expect(parseCarriedOverTokenUsage({ version: 2, sessions: [] })).toEqual([]);

    expect(
      mergeCarriedOverTokenUsage(earlier, [
        { sessionId: "a", state: { model: "new" } as never },
        { sessionId: "b", state: { model: "b" } as never },
      ]),
    ).toEqual({
      version: 1,
      sessions: [
        { sessionId: "a", state: { model: "new" } },
        { sessionId: "b", state: { model: "b" } },
      ],
    });
  });

  it("reads only well-formed backfill entries", () => {
    expect(
      parseTokenUsageBackfill({
        version: 1,
        sessions: [
          { sessionId: "a", cutoff: 5, days: { "2026-11-04": { "gpt-6": 10 } } },
          { sessionId: "b", cutoff: 5, days: { "2026-11-04": { "gpt-6": "10" } } },
          { sessionId: "c", days: {} },
        ],
      }),
    ).toEqual([{ sessionId: "a", cutoff: 5, days: { "2026-11-04": { "gpt-6": 10 } } }]);
  });
});

describe("retained token usage store", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "token-usage-retained-"));
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("keeps a deleted session next to the sessions carried over earlier", async () => {
    // Deleted sessions join the carried-over file, so they keep counting here
    // and a later coordinator move carries them forward too.
    await mkdir(join(sessionsDir, "token-usage"), { recursive: true });
    await writeFile(
      join(sessionsDir, TOKEN_USAGE_CARRYOVER_FILE),
      JSON.stringify({ version: 1, sessions: [{ sessionId: "carried", state: { model: "old" } }] }),
    );
    const store = new WorkspaceTokenUsageRetainedStore(sessionsDir);
    const first = await store.carriedOverSessions();
    expect(await store.carriedOverSessions()).toBe(first);

    await store.retain({ sessionId: "deleted", sessionNum: 7, state: { model: "new" } });

    expect((await store.carriedOverSessions()).map((session) => session.sessionId)).toEqual(["carried", "deleted"]);
    const onDisk = JSON.parse(await readFile(join(sessionsDir, TOKEN_USAGE_CARRYOVER_FILE), "utf-8"));
    expect(onDisk.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(["carried", "deleted"]);
  });

  it("rereads the backfill when its file changes, and has none without it", async () => {
    const store = new WorkspaceTokenUsageRetainedStore(sessionsDir);
    expect((await store.backfillSessions()).size).toBe(0);

    await mkdir(join(sessionsDir, "token-usage"), { recursive: true });
    const path = join(sessionsDir, TOKEN_USAGE_BACKFILL_FILE);
    await writeFile(path, JSON.stringify({ version: 1, sessions: [{ sessionId: "a", cutoff: 1, days: {} }] }));
    await utimes(path, new Date(1_000_000), new Date(1_000_000));
    expect([...(await store.backfillSessions()).keys()]).toEqual(["a"]);

    await writeFile(path, JSON.stringify({ version: 1, sessions: [{ sessionId: "b", cutoff: 1, days: {} }] }));
    await utimes(path, new Date(2_000_000), new Date(2_000_000));
    expect([...(await store.backfillSessions()).keys()]).toEqual(["b"]);

    await rm(path);
    expect((await store.backfillSessions()).size).toBe(0);
  });
});
