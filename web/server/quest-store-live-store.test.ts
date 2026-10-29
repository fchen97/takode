// The live quest store file: where it lives, how it is loaded, migrated and written.
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  rmSync(tempDir, { recursive: true, force: true });
});

function questDir(): string {
  return join(tempDir, ".companion", "questmaster");
}

function latestSnapshotPath(): string {
  return join(questDir(), "_latest_snapshot.json");
}

function liveStoreDir(): string {
  return join(tempDir, ".companion", "questmaster-live");
}

function liveStorePath(): string {
  return join(liveStoreDir(), "store.json");
}

function legacyCoLocatedLiveStorePath(): string {
  return join(questDir(), "store.json");
}

function writeLiveStoreFixture(store: unknown): void {
  mkdirSync(liveStoreDir(), { recursive: true });
  writeFileSync(liveStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

function writeLegacyCoLocatedLiveStoreFixture(store: unknown): void {
  mkdirSync(questDir(), { recursive: true });
  writeFileSync(legacyCoLocatedLiveStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

describe("live quest store", () => {
  it("reads and writes mutable current quest records when store.json is present", async () => {
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 2,
          title: "Existing",
          status: "refined",
          description: "Current live record",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });

    const initial = await questStore.listQuests();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.id).toBe("q-1");

    const transitioned = await questStore.transitionQuest("q-1", {
      status: "in_progress",
      sessionId: "session-1",
    });
    expect(transitioned).toMatchObject({
      id: "q-1",
      questId: "q-1",
      version: 3,
      status: "in_progress",
      createdAt: 100,
      statusChangedAt: expect.any(Number),
    });

    const created = await questStore.createQuest({ title: "New live quest" });
    expect(created).toMatchObject({
      id: "q-2",
      questId: "q-2",
      version: 1,
      status: "idea",
    });

    const persisted = JSON.parse(readFileSync(liveStorePath(), "utf-8"));
    expect(persisted.quests).toHaveLength(2);
    expect(persisted.quests.map((quest: { id: string }) => quest.id).sort()).toEqual(["q-1", "q-2"]);
  });

  it("bootstrap prefers the separate live store when it already exists", async () => {
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: questDir(),
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 2,
          title: "Preferred live quest",
          status: "refined",
          description: "Use me",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });
    // Loading the store creates no directory of its own, so legacy fixtures make theirs.
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 50,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();

    expect(bootstrap).toMatchObject({
      mode: "preferred_live",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
    });
    expect((await questStore.listQuests()).map((quest) => quest.title)).toEqual(["Preferred live quest"]);
  });

  it("bootstrap migrates the old co-located live store into the preferred live location", async () => {
    writeLegacyCoLocatedLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: join(tempDir, ".companion", "questmaster-legacy-cutover-old"),
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 3,
          title: "Co-located live quest",
          status: "refined",
          description: "Move me forward",
          createdAt: 100,
          statusChangedAt: 200,
        },
      ],
    });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 50,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();
    const migrated = JSON.parse(readFileSync(liveStorePath(), "utf-8"));
    const original = JSON.parse(readFileSync(legacyCoLocatedLiveStorePath(), "utf-8"));

    expect(bootstrap).toMatchObject({
      mode: "migrated_existing_live",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
    });
    expect(migrated.legacyBackupDir).toBe(questDir());
    expect(migrated.quests.map((quest: { title: string }) => quest.title)).toEqual(["Co-located live quest"]);
    expect(original.legacyBackupDir).toBe(join(tempDir, ".companion", "questmaster-legacy-cutover-old"));
  });

  it("bootstrap best-effort migrates readable legacy quests into the preferred live location", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Readable legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(questDir(), "q-2-v1.json"), "{broken json", "utf-8");
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [{ questId: "q-1" }],
          latestVersionByQuestId: { "q-1": 1 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const bootstrap = await questStore.bootstrapQuestStore();
    const migrated = JSON.parse(readFileSync(liveStorePath(), "utf-8"));

    expect(bootstrap).toMatchObject({
      mode: "migrated_legacy",
      liveStoreFile: liveStorePath(),
      legacyBackupDir: questDir(),
      report: {
        legacyQuestCount: 2,
        migratedQuestCount: 1,
        blockedQuests: [expect.objectContaining({ questId: "q-2" })],
      },
    });
    expect(migrated.legacyBackupDir).toBe(questDir());
    expect(migrated.quests.map((quest: { questId: string }) => quest.questId)).toEqual(["q-1"]);
    expect(readFileSync(join(questDir(), "q-1-v1.json"), "utf-8")).toContain("Readable legacy quest");
    expect(readFileSync(join(questDir(), "q-2-v1.json"), "utf-8")).toBe("{broken json");
  });

  it("bootstrap fails loudly when the preferred live store is unreadable", async () => {
    mkdirSync(liveStoreDir(), { recursive: true });
    writeFileSync(liveStorePath(), "{broken json", "utf-8");
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expect(questStore.bootstrapQuestStore()).rejects.toThrow();
  });

  it("prepares live-store migration from legacy version files and reports unreadable quests explicitly", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(questDir(), "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy quest",
          status: "refined",
          description: "Ready to build",
          createdAt: 250,
          updatedAt: 300,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(questDir(), "q-2-v1.json"), "{broken json", "utf-8");
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [{ questId: "q-1" }],
          latestVersionByQuestId: { "q-1": 2 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const prepared = await questStore.prepareLiveQuestStoreMigration();

    expect(prepared.canActivate).toBe(false);
    expect(prepared.report).toMatchObject({
      legacyQuestCount: 2,
      migratedQuestCount: 1,
      snapshotQuestCount: 1,
      snapshotStatus: "readable",
      snapshotMismatchQuestIds: ["q-2"],
      blockedQuests: [
        expect.objectContaining({
          questId: "q-2",
          files: ["q-2-v1.json"],
        }),
      ],
      unreadableFiles: [
        expect.objectContaining({
          file: "q-2-v1.json",
          questId: "q-2",
        }),
      ],
    });
    expect(prepared.store.nextQuestNumber).toBe(3);
    expect(prepared.store.quests).toEqual([
      expect.objectContaining({
        id: "q-1",
        questId: "q-1",
        version: 2,
        createdAt: 100,
        updatedAt: 300,
        statusChangedAt: 250,
      }),
    ]);
    expect(prepared.backupDir).toContain("legacy-backup-");
  });

  it("reports a snapshot mismatch when an existing quest ID has a stale snapshot version", async () => {
    mkdirSync(questDir(), { recursive: true });
    writeFileSync(
      join(questDir(), "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy quest",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(questDir(), "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy quest",
          status: "refined",
          description: "Ready to build",
          createdAt: 250,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      latestSnapshotPath(),
      JSON.stringify(
        {
          version: 3,
          quests: [
            {
              id: "q-1-v1",
              questId: "q-1",
              version: 1,
              title: "Legacy quest",
              status: "idea",
              createdAt: 100,
            },
          ],
          latestVersionByQuestId: { "q-1": 1 },
          latestFileStateByQuestId: {},
          updatedAt: 0,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const prepared = await questStore.prepareLiveQuestStoreMigration();

    expect(prepared.canActivate).toBe(true);
    expect(prepared.report.snapshotMismatchQuestIds).toEqual(["q-1"]);
    expect(prepared.report.blockedQuests).toEqual([]);
  });

  it("reads history and versions from the preserved legacy backup when the live store is active", async () => {
    const backupDir = join(questDir(), "legacy-backup-manual");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, "q-1-v1.json"),
      JSON.stringify(
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Legacy v1",
          status: "idea",
          createdAt: 100,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(backupDir, "q-1-v2.json"),
      JSON.stringify(
        {
          id: "q-1-v2",
          questId: "q-1",
          version: 2,
          prevId: "q-1-v1",
          title: "Legacy v2",
          status: "refined",
          description: "Refined",
          createdAt: 200,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      legacyBackupDir: backupDir,
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 3,
          title: "Live current",
          status: "refined",
          description: "Current live record",
          createdAt: 100,
          statusChangedAt: 250,
        },
      ],
    });

    const history = await questStore.getQuestHistoryView("q-1");
    expect(history).toMatchObject({
      mode: "legacy_backup",
      backupDir,
    });
    expect(history.entries.map((entry) => entry.id)).toEqual(["q-1-v1", "q-1-v2"]);

    const version = await questStore.getQuestVersion("q-1-v2");
    expect(version).toMatchObject({ id: "q-1-v2", title: "Legacy v2" });
  });
});

// ===========================================================================
// hasLocalQuestStore
// ===========================================================================
// A quest CLI with no server to ask reads this machine's store only when there
// is one. Importing the store and checking for it must create nothing, or a
// machine without a store (a remote host) would gain an empty one.
describe("hasLocalQuestStore", () => {
  it("is false on a machine without a store, and creates nothing", async () => {
    expect(await questStore.hasLocalQuestStore()).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("finds the live store, the colocated legacy store, or legacy version files", async () => {
    writeLiveStoreFixture({ format: "mutable_current_record", version: 1, nextQuestNumber: 1, quests: [] });
    expect(await questStore.hasLocalQuestStore()).toBe(true);
    rmSync(liveStoreDir(), { recursive: true, force: true });

    mkdirSync(questDir(), { recursive: true });
    expect(await questStore.hasLocalQuestStore()).toBe(false);
    writeFileSync(legacyCoLocatedLiveStorePath(), "{}", "utf-8");
    expect(await questStore.hasLocalQuestStore()).toBe(true);
    rmSync(legacyCoLocatedLiveStorePath());

    writeFileSync(join(questDir(), "q-3-v1.json"), "{}", "utf-8");
    expect(await questStore.hasLocalQuestStore()).toBe(true);
  });
});
