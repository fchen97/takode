// The quest store at server startup: moving older stores into one file per
// quest without losing data, what happens when that fails, and rollback.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readQuestStoreFixture, writeQuestStoreFixture } from "./test-fixtures/quest-store-fixture.js";

let tempDir: string;
let questStore: typeof import("./quest-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quest-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

function companionDir(): string {
  return join(tempDir, ".companion");
}

function questDir(): string {
  return join(companionDir(), "questmaster");
}

function latestSnapshotPath(): string {
  return join(questDir(), "_latest_snapshot.json");
}

function liveStoreDir(): string {
  return join(companionDir(), "questmaster-live");
}

function questsDir(): string {
  return join(liveStoreDir(), "quests");
}

function singleFileStorePath(): string {
  return join(liveStoreDir(), "store.json");
}

function coLocatedStorePath(): string {
  return join(questDir(), "store.json");
}

function writeSingleFileStore(path: string, store: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = JSON.stringify(store, null, 2);
  writeFileSync(path, text, "utf-8");
  return text;
}

function writeLegacyVersion(dir: string, quest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(quest.id)}.json`), JSON.stringify(quest, null, 2), "utf-8");
}

function singleFileStore(quests: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return { format: "mutable_current_record", version: 1, nextQuestNumber: 7, updatedAt: 0, quests, ...extra };
}

const LIVE_QUESTS = [
  {
    id: "q-4",
    questId: "q-4",
    version: 3,
    title: "Newest, with a note — café ✓",
    status: "refined",
    description: 'Line one\nline two with "quotes" and q-2.',
    createdAt: 100,
    statusChangedAt: 300,
    feedback: [{ author: "agent", text: "Evidence\n".repeat(50), ts: 250, machine: "devbox" }],
  },
  {
    id: "q-2",
    questId: "q-2",
    version: 1,
    title: "Older",
    status: "idea",
    createdAt: 50,
    statusChangedAt: 50,
    unknownFutureField: { kept: [1, null, { deep: true }] },
  },
];

describe("quest store at startup", () => {
  it("moves a single-file store into one file per quest, verified, keeping the old file and a byte-identical backup", async () => {
    // Every quest must land in its own file exactly as it was stored, the
    // store-wide fields (next number after deleted quests, legacy folder) must
    // carry over, and nothing of the old store may be deleted.
    const text = writeSingleFileStore(
      singleFileStorePath(),
      singleFileStore(LIVE_QUESTS, { legacyBackupDir: "/old/laptop/questmaster" }),
    );
    const log = vi.fn();

    const result = await questStore.bootstrapQuestStore({ log });

    expect(result).toMatchObject({ mode: "migrated_single_file", questsDir: questsDir(), questCount: 2 });
    if (result.mode !== "migrated_single_file") throw new Error("expected a migration");
    expect(readFileSync(result.backupFile, "utf-8")).toBe(text);
    expect(result.retiredFile).toBe(`${singleFileStorePath()}.before-per-quest-files`);
    expect(readFileSync(result.retiredFile, "utf-8")).toBe(text);
    expect(existsSync(singleFileStorePath())).toBe(false);
    for (const quest of LIVE_QUESTS) {
      expect(readFileSync(join(questsDir(), `${quest.questId}.json`), "utf-8")).toBe(
        `${JSON.stringify(quest, null, 2)}\n`,
      );
    }
    expect(JSON.parse(readFileSync(join(questsDir(), "_meta.json"), "utf-8"))).toEqual({
      format: "quest_per_file",
      version: 2,
      nextQuestNumber: 7,
      legacyBackupDir: "/old/laptop/questmaster",
    });
    expect(readdirSync(liveStoreDir()).filter((name) => name.startsWith("quests."))).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toContain("Moved 2 quests");

    // The store reads and writes from the folder now; numbering continues after the deleted quests.
    expect((await questStore.listQuests()).map((quest) => quest.questId)).toEqual(["q-4", "q-2"]);
    expect((await questStore.createQuest({ title: "Next" })).questId).toBe("q-7");
    expect(readQuestStoreFixture(companionDir()).has("q-7")).toBe(true);
  });

  it("reads a store not yet moved read-only and refuses changes until startup moves it", async () => {
    // Between an update and the server restart, CLIs and the old server only
    // read the old file; nothing may write a store that has not been moved.
    const text = writeSingleFileStore(singleFileStorePath(), singleFileStore(LIVE_QUESTS));

    expect((await questStore.getQuest("q-4"))?.title).toBe(LIVE_QUESTS[0]!.title);
    await expect(questStore.createQuest({ title: "Too early" })).rejects.toThrow("restart it");
    await expect(questStore.patchQuest("q-2", { title: "Too early" })).rejects.toThrow("Quest changes are paused");
    expect(readFileSync(singleFileStorePath(), "utf-8")).toBe(text);
    expect(existsSync(questsDir())).toBe(false);

    await questStore.bootstrapQuestStore();
    expect((await questStore.patchQuest("q-2", { title: "Now" }))?.title).toBe("Now");
  });

  it("keeps the old store untouched and readable, and refuses changes with the reason, when the move fails", async () => {
    // A file where the backups folder should be makes the verified backup fail
    // before anything is written.
    const text = writeSingleFileStore(singleFileStorePath(), singleFileStore(LIVE_QUESTS));
    writeFileSync(join(companionDir(), "questmaster-backups"), "not a folder");
    const logError = vi.fn();

    const result = await questStore.bootstrapQuestStore({ logError });

    expect(result).toMatchObject({ mode: "migration_failed" });
    expect(logError.mock.calls.flat().join("\n")).toContain("moving the quest store to one file per quest failed");
    expect(readFileSync(singleFileStorePath(), "utf-8")).toBe(text);
    expect(readdirSync(liveStoreDir())).toEqual(["store.json"]);
    expect((await questStore.listQuests()).map((quest) => quest.questId)).toEqual(["q-4", "q-2"]);
    await expect(questStore.createQuest({ title: "Blocked" })).rejects.toThrow(
      "moving the quest store to one file per quest failed",
    );

    // The next start tries again and succeeds once the cause is gone.
    rmSync(join(companionDir(), "questmaster-backups"));
    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "migrated_single_file" });
    expect((await questStore.createQuest({ title: "Unblocked" })).questId).toBe("q-7");
  });

  it("redoes a migration interrupted before the switch, discarding its staging folder", async () => {
    writeSingleFileStore(singleFileStorePath(), singleFileStore(LIVE_QUESTS));
    mkdirSync(join(liveStoreDir(), "quests.migrating-2026-11-06T00-00-00-000Z"), { recursive: true });
    writeFileSync(join(liveStoreDir(), "quests.migrating-2026-11-06T00-00-00-000Z", "q-4.json"), "{partial");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "migrated_single_file", questCount: 2 });
    expect(readdirSync(liveStoreDir()).filter((name) => name.startsWith("quests."))).toEqual([]);
    expect(readQuestStoreFixture(companionDir()).get("q-4")).toEqual(LIVE_QUESTS[0]);
  });

  it("moves aside an old file left by a migration interrupted after the switch", async () => {
    // The folder is current; the file it came from is older and must not be migrated again.
    writeQuestStoreFixture(companionDir(), { quests: [{ ...LIVE_QUESTS[0]!, title: "Current" }] });
    writeSingleFileStore(singleFileStorePath(), singleFileStore(LIVE_QUESTS));
    const past = new Date(Date.now() - 60_000);
    utimesSync(singleFileStorePath(), past, past);

    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "preferred_live" });
    expect(existsSync(singleFileStorePath())).toBe(false);
    expect(readdirSync(liveStoreDir()).some((name) => name.startsWith("store.json.before-per-quest-files-"))).toBe(
      true,
    );
    expect((await questStore.getQuest("q-4"))?.title).toBe("Current");
  });

  it("migrates a single file an older build wrote after a rollback, keeping the folder it replaces", async () => {
    // A single file newer than the folder is the current data.
    writeQuestStoreFixture(companionDir(), { quests: [{ ...LIVE_QUESTS[0]!, title: "Stale" }] });
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(questsDir(), "_meta.json"), past, past);
    writeSingleFileStore(singleFileStorePath(), singleFileStore(LIVE_QUESTS));

    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "migrated_single_file" });
    expect((await questStore.getQuest("q-4"))?.title).toBe(LIVE_QUESTS[0]!.title);
    const replaced = readdirSync(liveStoreDir()).find((name) => name.startsWith("quests.replaced-"));
    expect(replaced).toBeDefined();
    expect(JSON.parse(readFileSync(join(liveStoreDir(), replaced!, "q-4.json"), "utf-8")).title).toBe("Stale");
  });

  it("uses the quest folder on later starts and ignores pre-July files", async () => {
    writeQuestStoreFixture(companionDir(), { quests: [LIVE_QUESTS[0]!], legacyBackupDir: questDir() });
    writeLegacyVersion(questDir(), { id: "q-1-v1", questId: "q-1", version: 1, title: "Legacy", status: "idea" });

    expect(await questStore.bootstrapQuestStore()).toMatchObject({
      mode: "preferred_live",
      questsDir: questsDir(),
      legacyBackupDir: questDir(),
    });
    expect((await questStore.listQuests()).map((quest) => quest.questId)).toEqual(["q-4"]);
  });

  it("creates an empty store on a fresh install", async () => {
    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "no_data" });
    expect(readdirSync(questsDir())).toEqual(["_meta.json"]);
    expect((await questStore.createQuest({ title: "First" })).questId).toBe("q-1");
  });

  it("moves the old co-located single-file store, recording the legacy folder beside it", async () => {
    const text = writeSingleFileStore(
      coLocatedStorePath(),
      singleFileStore([LIVE_QUESTS[1]!], { legacyBackupDir: join(companionDir(), "questmaster-legacy-cutover-old") }),
    );

    expect(await questStore.bootstrapQuestStore()).toMatchObject({ mode: "migrated_single_file", questCount: 1 });
    expect(JSON.parse(readFileSync(join(questsDir(), "_meta.json"), "utf-8")).legacyBackupDir).toBe(questDir());
    expect(readFileSync(`${coLocatedStorePath()}.before-per-quest-files`, "utf-8")).toBe(text);
  });

  it("fails startup loudly when the single-file store cannot be parsed", async () => {
    mkdirSync(liveStoreDir(), { recursive: true });
    writeFileSync(singleFileStorePath(), "{broken json", "utf-8");

    await expect(questStore.bootstrapQuestStore()).rejects.toThrow();
    expect(readFileSync(singleFileStorePath(), "utf-8")).toBe("{broken json");
    expect(existsSync(questsDir())).toBe(false);
  });

  it("best-effort migrates readable pre-July quests and reports the rest", async () => {
    writeLegacyVersion(questDir(), {
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: "Legacy",
      status: "idea",
      createdAt: 100,
    });
    writeLegacyVersion(questDir(), {
      id: "q-1-v2",
      questId: "q-1",
      version: 2,
      prevId: "q-1-v1",
      title: "Legacy",
      status: "refined",
      description: "Ready to build",
      createdAt: 250,
      updatedAt: 300,
    });
    writeFileSync(join(questDir(), "q-2-v1.json"), "{broken json", "utf-8");
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify({ version: 3, quests: [{ questId: "q-1" }], latestVersionByQuestId: { "q-1": 2 } }),
      "utf-8",
    );

    const result = await questStore.bootstrapQuestStore();

    expect(result).toMatchObject({
      mode: "migrated_legacy",
      legacyBackupDir: questDir(),
      report: {
        legacyQuestCount: 2,
        migratedQuestCount: 1,
        snapshotQuestCount: 1,
        snapshotStatus: "readable",
        snapshotMismatchQuestIds: ["q-2"],
        blockedQuests: [expect.objectContaining({ questId: "q-2", files: ["q-2-v1.json"] })],
        unreadableFiles: [expect.objectContaining({ file: "q-2-v1.json", questId: "q-2" })],
      },
    });
    // The latest readable version, with the first version's creation time.
    expect(readQuestStoreFixture(companionDir()).get("q-1")).toMatchObject({
      id: "q-1",
      version: 2,
      createdAt: 100,
      updatedAt: 300,
      statusChangedAt: 250,
    });
    // The unreadable quest keeps its number, and the legacy files stay as they were.
    expect((await questStore.createQuest({ title: "Next" })).questId).toBe("q-3");
    expect(readFileSync(join(questDir(), "q-2-v1.json"), "utf-8")).toBe("{broken json");
  });

  it("reports a stale pre-July snapshot version as an advisory mismatch", async () => {
    writeLegacyVersion(questDir(), {
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: "Legacy",
      status: "idea",
      createdAt: 100,
    });
    writeLegacyVersion(questDir(), {
      id: "q-1-v2",
      questId: "q-1",
      version: 2,
      title: "Legacy",
      status: "refined",
      description: "Ready",
      createdAt: 250,
    });
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify({ version: 3, quests: [{ questId: "q-1", version: 1 }], latestVersionByQuestId: { "q-1": 1 } }),
      "utf-8",
    );

    const result = await questStore.bootstrapQuestStore();
    if (result.mode !== "migrated_legacy") throw new Error("expected a legacy migration");
    expect(result.report.snapshotMismatchQuestIds).toEqual(["q-1"]);
    expect(result.report.blockedQuests).toEqual([]);
  });

  it("reads history and versions from the preserved pre-July files", async () => {
    const backupDir = join(questDir(), "legacy-backup-manual");
    writeLegacyVersion(backupDir, {
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: "Legacy v1",
      status: "idea",
      createdAt: 100,
    });
    writeLegacyVersion(backupDir, {
      id: "q-1-v2",
      questId: "q-1",
      version: 2,
      prevId: "q-1-v1",
      title: "Legacy v2",
      status: "refined",
      description: "Refined",
      createdAt: 200,
    });
    writeQuestStoreFixture(companionDir(), {
      legacyBackupDir: backupDir,
      quests: [{ ...LIVE_QUESTS[0]!, questId: "q-1", id: "q-1", title: "Live current" }],
    });

    const history = await questStore.getQuestHistoryView("q-1");
    expect(history).toMatchObject({ mode: "legacy_backup", backupDir });
    expect(history.entries.map((entry) => entry.id)).toEqual(["q-1-v1", "q-1-v2"]);
    expect(await questStore.getQuestVersion("q-1-v2")).toMatchObject({ id: "q-1-v2", title: "Legacy v2" });
  });
});

// A quest CLI with no server to ask reads this machine's store only when there
// is one. Importing the store and checking for it must create nothing, or a
// machine without a store (a remote host) would gain an empty one.
describe("hasLocalQuestStore", () => {
  it("is false on a machine without a store, and creates nothing", async () => {
    expect(await questStore.hasLocalQuestStore()).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("finds the per-quest store, a single-file store not yet moved, or legacy version files", async () => {
    // A store the server has already moved into one file per quest.
    writeQuestStoreFixture(companionDir(), { quests: [] });
    expect(await questStore.hasLocalQuestStore()).toBe(true);
    rmSync(liveStoreDir(), { recursive: true, force: true });
    expect(await questStore.hasLocalQuestStore()).toBe(false);

    // Single-file stores, in their current and first location.
    writeSingleFileStore(singleFileStorePath(), singleFileStore([]));
    expect(await questStore.hasLocalQuestStore()).toBe(true);
    rmSync(liveStoreDir(), { recursive: true, force: true });
    writeSingleFileStore(coLocatedStorePath(), singleFileStore([]));
    expect(await questStore.hasLocalQuestStore()).toBe(true);
    rmSync(coLocatedStorePath());

    // Pre-July per-version files.
    writeLegacyVersion(questDir(), { id: "q-3-v1", questId: "q-3", version: 1, title: "Legacy", status: "idea" });
    expect(await questStore.hasLocalQuestStore()).toBe(true);
  });
});
