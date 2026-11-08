import { readdir, readFile, mkdir, rm, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { QuestCodeDelivery, QuestDeliveryTargetApproval } from "../shared/quest-delivery.js";
import { appendCodeEvidence, appendDeliveryTargetApproval } from "./quest-delivery-evidence.js";
import {
  hasQuestReviewMetadata,
  type QuestmasterTask,
  type QuestCreateInput,
  type QuestFeedbackEntry,
  type QuestPatchInput,
  type QuestTransitionInput,
  type QuestImage,
  type QuestInvocationProvenance,
  type QuestVerificationItem,
  type QuestDone,
  type QuestHistoryView,
  type QuestOwnerKind,
  type QuestOwnerRef,
  type QuestRecoveryEventDraft,
  type QuestStoreMigrationReport,
} from "./quest-types.js";
import { formatQuestIdList, normalizeCommitShas, normalizeQuestOwnership } from "./quest-store-helpers.js";
import {
  addQuestImagesToStore,
  readQuestImageFileFromDirs,
  removeQuestImageFromStore,
  saveQuestImageFile,
} from "./quest-store-images.js";
import { stripDerivedQuestRelationships, withQuestRelationshipSummaries } from "./quest-relationships.js";
import { _clearCachedJsonFilesForTests, deepFreeze, readCachedJsonFile } from "./cached-json-file.js";
import { applyQuestPatch } from "./quest-store-patch.js";
import { questStoreFileChunks } from "./quest-store-file.js";
import {
  QUEST_DIR_FORMAT,
  nextQuestNumberFor,
  readQuestDir,
  sortQuestsByRecency,
  writeNewQuestDir,
  writeQuestDirChanges,
  forgetQuestDir,
  _clearQuestDirCacheForTests,
  type QuestDirState,
} from "./quest-store-dir.js";
import { activateQuestDir, migrateSingleFileQuestStore, RETIRED_STORE_SUFFIX } from "./quest-store-migration.js";
import { normalizeLiveQuest } from "./quest-store-normalize.js";
import { assertQuestTextWithinLimit } from "./quest-text-limits.js";
import {
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS,
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH,
} from "../shared/quest-code-commit-evidence.js";
import { appendQuestCodeCommitEvidenceReplacementEvent } from "./quest-code-commit-evidence.js";
import { assertSafeQuestmasterTestRoot, recordQuestStoreMutationBackup } from "./quest-backup-store.js";
import { withDirectoryLock } from "./quest-store-locks.js";
import {
  assertQuestMutationOwner,
  buildCancelledQuest,
  buildCreatedQuest,
  buildQuestClaimTransitionInput,
  buildTransitionedQuest,
  type QuestClaimOptions,
} from "./quest-store-mutations.js";
import { getQuestOwner, normalizeQuestOwnerRef, sameQuestOwner } from "../shared/quest-owner.js";
// ─── Paths ───────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
/** The pre-July store: one file per quest version. Kept only as a migration source and for history. */
const QUESTMASTER_DIR = join(COMPANION_DIR, "questmaster");
const IMAGES_DIR = join(QUESTMASTER_DIR, "images");
const LATEST_SNAPSHOT_FILE = join(QUESTMASTER_DIR, "_latest_snapshot.json");
const LIVE_QUESTMASTER_DIR = join(COMPANION_DIR, "questmaster-live");
const LIVE_IMAGES_DIR = join(LIVE_QUESTMASTER_DIR, "images");
/** The store: one file per quest (see quest-store-dir.ts). */
const QUESTS_DIR = join(LIVE_QUESTMASTER_DIR, "quests");
/** The single-file store used from July to November 2026, read only until the server moves it into QUESTS_DIR. */
const SINGLE_FILE_STORE = join(LIVE_QUESTMASTER_DIR, "store.json");
/** The single-file store's first location, before it moved into questmaster-live. */
const COLOCATED_SINGLE_FILE_STORE = join(QUESTMASTER_DIR, "store.json");
const BACKUPS_DIR = join(COMPANION_DIR, "questmaster-backups");
const LIVE_STORE_LOCK_DIR = join(LIVE_QUESTMASTER_DIR, "_store.lock");
const LIVE_STORE_LOCK_STALE_MS = 120_000;

let pendingLiveStoreWrite: Promise<unknown> = Promise.resolve();
/** Why this server's startup migration failed; quest changes are refused until a restart succeeds. */
let migrationFailure: string | null = null;

type LiveQuestStore = QuestDirState;

const EMPTY_STORE: LiveQuestStore = deepFreeze({ nextQuestNumber: 1, quests: [] });

type QuestVersionFile = {
  file: string;
  questId: string;
  version: number;
};

type LegacyQuestLoadResult = {
  questId: string;
  files: string[];
  readable: QuestmasterTask[];
  unreadable: { file: string; error: string }[];
};

type QuestStoreBootstrapResult =
  | { mode: "preferred_live"; questsDir: string; legacyBackupDir?: string }
  | { mode: "migrated_single_file"; questsDir: string; questCount: number; backupFile: string; retiredFile: string }
  | { mode: "migrated_legacy"; questsDir: string; legacyBackupDir: string; report: QuestStoreMigrationReport }
  | { mode: "no_data"; questsDir: string }
  | { mode: "migration_failed"; questsDir: string; error: string };

function extractQuestNumber(questId: string): number {
  const match = questId.match(/^q-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function normalizeLiveQuestStore(value: unknown): LiveQuestStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Live quest store must be an object");
  }
  const parsed = value as {
    format?: unknown;
    legacyBackupDir?: unknown;
    nextQuestNumber?: unknown;
    quests?: unknown;
    version?: unknown;
  };
  if (parsed.format !== "mutable_current_record" || parsed.version !== 1 || !Array.isArray(parsed.quests)) {
    throw new Error("Live quest store has an unsupported format");
  }
  const quests = sortQuestsByRecency(parsed.quests.map((quest) => normalizeLiveQuest(quest as QuestmasterTask)));
  const computedNext = nextQuestNumberFor(quests);
  const nextQuestNumber =
    typeof parsed.nextQuestNumber === "number" &&
    Number.isInteger(parsed.nextQuestNumber) &&
    parsed.nextQuestNumber >= computedNext
      ? parsed.nextQuestNumber
      : computedNext;
  return {
    quests,
    nextQuestNumber,
    ...(typeof parsed.legacyBackupDir === "string" && parsed.legacyBackupDir.trim()
      ? { legacyBackupDir: parsed.legacyBackupDir }
      : {}),
  };
}

/**
 * The quest store, or null when there is none. Until the server's startup
 * migration has moved a single-file store into the quest folder (the window
 * between an update and the restart, or after a failed migration), that file
 * is read, read-only.
 */
async function readLiveQuestStore(): Promise<LiveQuestStore | null> {
  const store = await readQuestDir(QUESTS_DIR);
  if (store) return store;
  for (const path of [SINGLE_FILE_STORE, COLOCATED_SINGLE_FILE_STORE]) {
    const single = await readCachedJsonFile(path, (raw) => normalizeLiveQuestStore(JSON.parse(raw)));
    if (single) return single;
  }
  return null;
}

async function ensureLiveImagesDir(): Promise<void> {
  await mkdir(LIVE_IMAGES_DIR, { recursive: true });
}

async function currentStore(): Promise<LiveQuestStore> {
  return (await readLiveQuestStore()) ?? EMPTY_STORE;
}

/** The store to change, read under the write lock. A store not yet moved into the quest folder is never written. */
async function writableStore(): Promise<LiveQuestStore> {
  if (migrationFailure) throw new Error(migrationFailure);
  const store = await readQuestDir(QUESTS_DIR);
  if (store) return store;
  if (await hasUnmigratedData()) {
    throw new Error(
      "Quest changes are paused: the quest store has not been moved to one file per quest yet. " +
        "The Takode server does that when it starts; restart it.",
    );
  }
  await mkdir(LIVE_QUESTMASTER_DIR, { recursive: true });
  await writeNewQuestDir(QUESTS_DIR, { nextQuestNumber: 1, quests: [] });
  return (await readQuestDir(QUESTS_DIR))!;
}

async function hasUnmigratedData(): Promise<boolean> {
  for (const path of [SINGLE_FILE_STORE, COLOCATED_SINGLE_FILE_STORE]) {
    if (await stat(path).catch(() => null)) return true;
  }
  return (await listQuestVersionFilesInDir(QUESTMASTER_DIR)).length > 0;
}

const relationshipViews = new WeakMap<LiveQuestStore, QuestmasterTask[]>();

/** The store's quests with derived relationship summaries, computed once per cached store. Returns a fresh array. */
function liveQuestsWithRelationships(store: LiveQuestStore): QuestmasterTask[] {
  let quests = relationshipViews.get(store);
  if (!quests) {
    quests = deepFreeze(withQuestRelationshipSummaries(store.quests));
    relationshipViews.set(store, quests);
  }
  return [...quests];
}

async function withLiveStoreWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = () =>
    withDirectoryLock(LIVE_STORE_LOCK_DIR, { staleMs: LIVE_STORE_LOCK_STALE_MS, label: "live quest store lock" }, fn);
  const result = pendingLiveStoreWrite.catch(() => {}).then(run);
  pendingLiveStoreWrite = result.catch(() => {});
  return result;
}

async function mutateLiveQuestStore<T>(
  fn: (store: LiveQuestStore) =>
    | Promise<{ store: LiveQuestStore; result: T; write?: boolean }>
    | {
        store: LiveQuestStore;
        result: T;
        write?: boolean;
      },
): Promise<T> {
  return withLiveStoreWriteLock(async () => {
    const current = await writableStore();
    const { store, result, write = true } = await fn(current);
    if (write) {
      // Before anything is written, so a refused change leaves the store and its backups untouched.
      assertQuestTextWithinLimit(current.quests, store.quests);
      await recordQuestStoreMutationBackup(backupView(current), backupView(store));
      await writeQuestDirChanges(QUESTS_DIR, current, store);
    }
    return result;
  });
}

function backupView(store: LiveQuestStore) {
  return { format: QUEST_DIR_FORMAT, version: 2, updatedAt: Date.now(), ...store };
}

/** The store as the single-file format wrote it, for a whole-store backup. */
function singleFileStoreText(store: LiveQuestStore): string {
  const singleFile = {
    format: "mutable_current_record",
    version: 1,
    quests: store.quests,
    nextQuestNumber: store.nextQuestNumber,
    updatedAt: Date.now(),
    ...(store.legacyBackupDir ? { legacyBackupDir: store.legacyBackupDir } : {}),
  };
  return Buffer.concat(questStoreFileChunks(singleFile)).toString("utf-8");
}

// ─── Pre-July per-version files (migration source and history only) ────────

async function readQuestAtPath(path: string): Promise<QuestmasterTask | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask);
  } catch {
    return null;
  }
}

async function listQuestVersionFilesInDir(dir: string, questId?: string): Promise<QuestVersionFile[]> {
  try {
    const files = await readdir(dir);
    return files
      .map((file) => {
        const match = file.match(/^(q-\d+)-v(\d+)\.json$/);
        if (!match) return null;
        if (questId && match[1] !== questId) return null;
        return {
          file,
          questId: match[1],
          version: Number(match[2]),
        } satisfies QuestVersionFile;
      })
      .filter((entry): entry is QuestVersionFile => entry !== null)
      .sort((a, b) => a.questId.localeCompare(b.questId) || a.version - b.version);
  } catch {
    return [];
  }
}

async function readQuestAtPathWithError(path: string): Promise<{ quest: QuestmasterTask | null; error?: string }> {
  try {
    const raw = await readFile(path, "utf-8");
    return { quest: normalizeQuestOwnership(JSON.parse(raw) as QuestmasterTask) };
  } catch (error) {
    return { quest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readQuestVersionFromDir(dir: string, id: string): Promise<QuestmasterTask | null> {
  const path = join(dir, `${id}.json`);
  const { quest } = await readQuestAtPathWithError(path);
  return quest;
}

async function readQuestHistoryForIdFromDir(dir: string, questId: string): Promise<QuestmasterTask[]> {
  const versionFiles = await listQuestVersionFilesInDir(dir, questId);
  if (versionFiles.length === 0) return [];
  const versions = await Promise.all(versionFiles.map(({ file }) => readQuestAtPath(join(dir, file))));
  return versions.filter((quest): quest is QuestmasterTask => quest !== null);
}

async function loadLegacyQuestResults(dir: string): Promise<LegacyQuestLoadResult[]> {
  const versionFiles = await listQuestVersionFilesInDir(dir);
  const grouped = new Map<string, QuestVersionFile[]>();
  for (const versionFile of versionFiles) {
    const current = grouped.get(versionFile.questId) ?? [];
    current.push(versionFile);
    grouped.set(versionFile.questId, current);
  }

  const results: LegacyQuestLoadResult[] = [];
  for (const [questId, files] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const readable: QuestmasterTask[] = [];
    const unreadable: { file: string; error: string }[] = [];
    const sortedFiles = [...files].sort((a, b) => a.version - b.version);
    for (const versionFile of sortedFiles) {
      const { quest, error } = await readQuestAtPathWithError(join(dir, versionFile.file));
      if (quest) readable.push(quest);
      else unreadable.push({ file: versionFile.file, error: error ?? "Unknown error" });
    }
    results.push({
      questId,
      files: sortedFiles.map((file) => file.file),
      readable,
      unreadable,
    });
  }
  return results;
}

function buildLiveQuestFromLegacy(result: LegacyQuestLoadResult): QuestmasterTask | null {
  if (result.readable.length === 0) return null;
  const oldest = result.readable[0]!;
  const latest = result.readable[result.readable.length - 1]!;
  const updatedAt = (latest as { updatedAt?: number }).updatedAt;
  return normalizeLiveQuest({
    ...latest,
    id: latest.questId,
    createdAt: oldest.createdAt,
    ...(typeof updatedAt === "number" ? { updatedAt } : {}),
    statusChangedAt: latest.createdAt,
    prevId: undefined,
  });
}

function normalizeLatestVersionByQuestId(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: Record<string, number> = {};
  for (const [questId, version] of Object.entries(value as Record<string, unknown>)) {
    if (!/^q-\d+$/.test(questId)) return null;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
    normalized[questId] = version;
  }
  return normalized;
}

async function readLatestSnapshotStatusAtPath(snapshotPath: string): Promise<{
  count: number;
  error?: string;
  questIds: string[];
  latestVersionByQuestId: Record<string, number>;
  status: QuestStoreMigrationReport["snapshotStatus"];
}> {
  try {
    const raw = await readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      latestVersionByQuestId?: unknown;
      quests?: Array<{ questId?: string; version?: unknown }>;
    };
    if (!Array.isArray(parsed.quests)) {
      return {
        count: 0,
        questIds: [],
        latestVersionByQuestId: {},
        status: "unreadable",
        error: "Snapshot is missing a quests array",
      };
    }
    const questIds: string[] = [];
    const fallbackLatestVersionByQuestId: Record<string, number> = {};
    for (const quest of parsed.quests) {
      if (typeof quest?.questId !== "string") continue;
      questIds.push(quest.questId);
      if (typeof quest.version === "number" && Number.isInteger(quest.version) && quest.version >= 1) {
        fallbackLatestVersionByQuestId[quest.questId] = quest.version;
      }
    }
    const latestVersionByQuestId =
      normalizeLatestVersionByQuestId(parsed.latestVersionByQuestId) ?? fallbackLatestVersionByQuestId;
    return { count: questIds.length, questIds, latestVersionByQuestId, status: "readable" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { count: 0, questIds: [], latestVersionByQuestId: {}, status: "missing" };
    }
    return {
      count: 0,
      questIds: [],
      latestVersionByQuestId: {},
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function prepareLegacyQuestStoreMigration(options: {
  legacyDir: string;
  preservedLegacyDir: string;
  snapshotPath: string;
}): Promise<{ report: QuestStoreMigrationReport; store: LiveQuestStore & { legacyBackupDir: string } }> {
  const legacyResults = await loadLegacyQuestResults(options.legacyDir);
  const liveQuests = legacyResults
    .map((result) => buildLiveQuestFromLegacy(result))
    .filter((quest): quest is QuestmasterTask => quest !== null);
  const snapshot = await readLatestSnapshotStatusAtPath(options.snapshotPath);
  const legacyQuestIds = legacyResults.map((result) => result.questId);
  const legacyLatestReadableVersionByQuestId = Object.fromEntries(
    legacyResults
      .map((result) => {
        const latestReadable = result.readable[result.readable.length - 1];
        return latestReadable ? ([result.questId, latestReadable.version] as const) : null;
      })
      .filter((entry): entry is readonly [string, number] => entry !== null),
  );
  const snapshotMismatchQuestIds = [...new Set([...legacyQuestIds, ...snapshot.questIds])]
    .filter((questId) => {
      const membershipMismatch = legacyQuestIds.includes(questId) !== snapshot.questIds.includes(questId);
      if (membershipMismatch) return true;
      const legacyVersion = legacyLatestReadableVersionByQuestId[questId];
      if (legacyVersion === undefined || !snapshot.questIds.includes(questId)) return false;
      return snapshot.latestVersionByQuestId[questId] !== legacyVersion;
    })
    .sort((a, b) => a.localeCompare(b));
  const unreadableFiles = legacyResults.flatMap((result) =>
    result.unreadable.map((entry) => ({
      file: entry.file,
      questId: result.questId,
      error: entry.error,
    })),
  );
  const blockedQuests = legacyResults
    .filter((result) => result.readable.length === 0)
    .map((result) => ({
      questId: result.questId,
      files: result.files,
      errors: result.unreadable.map((entry) => entry.error),
    }));
  const store = {
    quests: sortQuestsByRecency(liveQuests),
    nextQuestNumber: nextQuestNumberFor(legacyQuestIds.map((questId) => ({ questId }))),
    legacyBackupDir: options.preservedLegacyDir,
  };
  const report: QuestStoreMigrationReport = {
    legacyQuestCount: legacyQuestIds.length,
    migratedQuestCount: liveQuests.length,
    snapshotQuestCount: snapshot.count,
    snapshotStatus: snapshot.status,
    ...(snapshot.error ? { snapshotError: snapshot.error } : {}),
    snapshotMismatchQuestIds,
    unreadableFiles,
    blockedQuests,
  };
  return { report, store };
}

// ─── Startup ─────────────────────────────────────────────────────────────────

/**
 * Bring the store into the quest folder at server startup, before anything
 * reads or writes quests. A single-file store is moved with
 * {@link migrateSingleFileQuestStore}; pre-July per-version files are rebuilt
 * into the folder and stay where they are for history. When the move fails,
 * the old store stays as it was and in use read-only, and quest changes are
 * refused with the reason until a later start succeeds. An old store that
 * cannot even be parsed still fails startup loudly.
 */
export async function bootstrapQuestStore(options?: {
  log?: (message: string) => void;
  logError?: (message: string) => void;
}): Promise<QuestStoreBootstrapResult> {
  const log = options?.log ?? (() => {});
  const logError = options?.logError ?? log;
  return withLiveStoreWriteLock(async () => {
    migrationFailure = null;
    const singleFile = await settleSingleFileBesideQuestDir(log);
    if (!singleFile) {
      const store = await readQuestDir(QUESTS_DIR);
      if (store) {
        log(`[quest-store] Using the quest store at ${QUESTS_DIR} (${store.quests.length} quests)`);
        return {
          mode: "preferred_live",
          questsDir: QUESTS_DIR,
          ...(store.legacyBackupDir ? { legacyBackupDir: store.legacyBackupDir } : {}),
        };
      }
    }
    // An old store that cannot even be parsed fails startup, as it always has.
    if (singleFile) normalizeLiveQuestStore(JSON.parse(await readFile(singleFile, "utf-8")));
    try {
      return await migrateIntoQuestDir(singleFile, log);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      migrationFailure =
        `Quest changes are paused: moving the quest store to one file per quest failed (${reason}). ` +
        "The old store is untouched and still readable; restarting the Takode server tries again.";
      logError(`[quest-store] ${migrationFailure}`);
      return { mode: "migration_failed", questsDir: QUESTS_DIR, error: reason };
    }
  });
}

/**
 * When a single-file store sits beside the quest folder, decide which is
 * current. One older than the folder is left from a migration interrupted
 * after the switch and is moved aside. A newer one was written by an older
 * build after a rollback, so it is current: the folder is moved aside and the
 * file migrated again. Nothing is deleted. Returns the single-file store to
 * migrate, if any.
 */
async function settleSingleFileBesideQuestDir(log: (message: string) => void): Promise<string | null> {
  const singleFile = (await stat(SINGLE_FILE_STORE).catch(() => null))
    ? SINGLE_FILE_STORE
    : (await stat(COLOCATED_SINGLE_FILE_STORE).catch(() => null))
      ? COLOCATED_SINGLE_FILE_STORE
      : null;
  if (!singleFile) return null;
  const folderMeta = await stat(join(QUESTS_DIR, "_meta.json")).catch(() => null);
  if (!folderMeta) return singleFile;
  const fileTime = (await stat(singleFile)).mtimeMs;
  if (fileTime <= folderMeta.mtimeMs) {
    const retired = `${singleFile}${RETIRED_STORE_SUFFIX}-${Date.now()}`;
    await rename(singleFile, retired);
    log(`[quest-store] Moved ${singleFile}, left by an interrupted migration, to ${retired}`);
    return null;
  }
  const replaced = `${QUESTS_DIR}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await rename(QUESTS_DIR, replaced);
  forgetQuestDir(QUESTS_DIR);
  log(
    `[quest-store] ${singleFile} is newer than ${QUESTS_DIR} (an older build wrote it); moved the folder to ${replaced}`,
  );
  return singleFile;
}

async function migrateIntoQuestDir(
  singleFile: string | null,
  log: (message: string) => void,
): Promise<QuestStoreBootstrapResult> {
  if (singleFile) {
    const result = await migrateSingleFileQuestStore({
      storeFile: singleFile,
      questsDir: QUESTS_DIR,
      backupsDir: BACKUPS_DIR,
      ...(singleFile === COLOCATED_SINGLE_FILE_STORE ? { legacyBackupDir: QUESTMASTER_DIR } : {}),
    });
    log(
      `[quest-store] Moved ${result.questCount} quests from ${singleFile} to one file per quest in ${QUESTS_DIR}; ` +
        `verified copy of the old store at ${result.backupFile}, old file kept at ${result.retiredFile}`,
    );
    return {
      mode: "migrated_single_file",
      questsDir: QUESTS_DIR,
      questCount: result.questCount,
      backupFile: result.backupFile!,
      retiredFile: result.retiredFile!,
    };
  }

  await mkdir(LIVE_QUESTMASTER_DIR, { recursive: true });
  if ((await listQuestVersionFilesInDir(QUESTMASTER_DIR)).length === 0) {
    await writeNewQuestDir(QUESTS_DIR, { nextQuestNumber: 1, quests: [] });
    log(`[quest-store] No quest data found; created an empty quest store at ${QUESTS_DIR}`);
    return { mode: "no_data", questsDir: QUESTS_DIR };
  }

  const prepared = await prepareLegacyQuestStoreMigration({
    legacyDir: QUESTMASTER_DIR,
    preservedLegacyDir: QUESTMASTER_DIR,
    snapshotPath: LATEST_SNAPSHOT_FILE,
  });
  await activateQuestDir(QUESTS_DIR, prepared.store);
  const { report } = prepared;
  log(
    `[quest-store] Migrated ${report.migratedQuestCount}/${report.legacyQuestCount} legacy quests into ${QUESTS_DIR}; preserving legacy quest directory at ${QUESTMASTER_DIR}`,
  );
  if (report.unreadableFiles.length > 0) {
    log(
      `[quest-store] Encountered unreadable legacy quest files during startup migration: ${formatQuestIdList([
        ...new Set(report.unreadableFiles.map((file) => file.questId)),
      ])}`,
    );
  }
  if (report.blockedQuests.length > 0) {
    log(
      `[quest-store] Skipped unreadable legacy quests during startup migration: ${formatQuestIdList(
        report.blockedQuests.map((quest) => quest.questId),
      )}`,
    );
  }
  if (report.snapshotMismatchQuestIds.length > 0) {
    log(
      `[quest-store] Legacy snapshot mismatches were advisory during startup migration: ${formatQuestIdList(
        report.snapshotMismatchQuestIds,
      )}`,
    );
  }
  if (report.snapshotStatus === "unreadable") {
    log(
      `[quest-store] Legacy snapshot was unreadable during startup migration: ${report.snapshotError ?? "Unknown error"}`,
    );
  }
  return { mode: "migrated_legacy", questsDir: QUESTS_DIR, legacyBackupDir: QUESTMASTER_DIR, report };
}

async function getQuestHistoryViewForLiveStore(questId: string, store: LiveQuestStore): Promise<QuestHistoryView> {
  if (!store.legacyBackupDir) {
    return {
      mode: "unavailable",
      entries: [],
      message: "Legacy history is unavailable until the live store is activated with a preserved backup.",
    };
  }

  const entries = await readQuestHistoryForIdFromDir(store.legacyBackupDir, questId);
  return {
    mode: "legacy_backup",
    entries,
    backupDir: store.legacyBackupDir,
    ...(entries.length === 0 ? { message: "No legacy backup history exists for this quest." } : {}),
  };
}

function getLiveQuestById(store: LiveQuestStore, questId: string): QuestmasterTask | null {
  return store.quests.find((quest) => quest.questId === questId) ?? null;
}

function upsertLiveQuest(store: LiveQuestStore, quest: QuestmasterTask): LiveQuestStore {
  const nextQuest = normalizeLiveQuest(quest);
  const quests = sortQuestsByRecency([
    ...store.quests.filter((existing) => existing.questId !== nextQuest.questId),
    nextQuest,
  ]);
  return {
    ...store,
    quests,
    nextQuestNumber: Math.max(store.nextQuestNumber, nextQuestNumberFor(quests)),
  };
}

function removeLiveQuest(store: LiveQuestStore, questId: string): LiveQuestStore {
  const quests = store.quests.filter((quest) => quest.questId !== questId);
  return {
    ...store,
    quests,
    nextQuestNumber: Math.max(store.nextQuestNumber, nextQuestNumberFor(quests)),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Whether this machine holds a quest store, current or not yet migrated, checked
 * without creating anything. A CLI with no server to ask reads the local store
 * only when there is one, so a machine without one never gains an empty store.
 */
export async function hasLocalQuestStore(): Promise<boolean> {
  if (await stat(join(QUESTS_DIR, "_meta.json")).catch(() => null)) return true;
  return hasUnmigratedData();
}

/** List the latest version of every quest. */
export async function listQuests(): Promise<QuestmasterTask[]> {
  return liveQuestsWithRelationships(await currentStore());
}

/** Get the latest version of a quest by questId. */
export async function getQuest(questId: string): Promise<QuestmasterTask | null> {
  return liveQuestsWithRelationships(await currentStore()).find((quest) => quest.questId === questId) ?? null;
}

/** Get a specific pre-July version by full version id (e.g., "q-1-v3") from the preserved legacy files. */
export async function getQuestVersion(id: string): Promise<QuestmasterTask | null> {
  const liveStore = await currentStore();
  if (!liveStore.legacyBackupDir) return null;
  return readQuestVersionFromDir(liveStore.legacyBackupDir, id);
}

/** Get all versions of a quest, ordered oldest → newest. */
export async function getQuestHistory(questId: string): Promise<QuestmasterTask[]> {
  return (await getQuestHistoryView(questId)).entries;
}

export async function getQuestHistoryView(questId: string): Promise<QuestHistoryView> {
  return getQuestHistoryViewForLiveStore(questId, await currentStore());
}

/** Create a new quest. Returns the initial version. */
export async function createQuest(input: QuestCreateInput): Promise<QuestmasterTask> {
  if (!input.title?.trim()) {
    throw new Error("Quest title is required");
  }
  return mutateLiveQuestStore(async (store) => {
    const questId = `q-${Math.max(store.nextQuestNumber, nextQuestNumberFor(store.quests))}`;
    const quest = buildCreatedQuest(questId, input);
    return {
      store: upsertLiveQuest(
        {
          ...store,
          nextQuestNumber: extractQuestNumber(questId) + 1,
        },
        quest,
      ),
      result: quest,
    };
  });
}

/** Same-stage edit. Mutates the latest version in place, no new version. */
export async function patchQuest(
  questId: string,
  patch: QuestPatchInput,
  options?: { current?: QuestmasterTask | null },
): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = stripDerivedQuestRelationships(
      options?.current && options.current.questId === questId ? options.current : getLiveQuestById(store, questId),
    );
    if (!current) return { store, result: null, write: false };

    const updated = applyQuestPatch(current, questId, patch);
    if (patch.lastModifiedBy) updated.lastModifiedBy = patch.lastModifiedBy;
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

/** Atomically patch an unowned quest or one owned by the exact provider-aware owner.
 * A callback computes its patch from the latest quest while the mutation lock is held;
 * returning null preserves the record without another write.
 */
export async function patchQuestForOwner(
  questId: string,
  owner: QuestOwnerRef,
  patch: QuestPatchInput | ((current: QuestmasterTask) => QuestPatchInput | null),
): Promise<QuestmasterTask | null> {
  const normalizedOwner = normalizeQuestOwnerRef(owner);
  if (!normalizedOwner) throw new Error("A valid quest owner is required");
  return mutateLiveQuestStore(async (store) => {
    const current = stripDerivedQuestRelationships(getLiveQuestById(store, questId));
    if (!current) return { store, result: null, write: false };
    assertQuestMutationOwner(current, normalizedOwner, "edit");
    const resolvedPatch = typeof patch === "function" ? patch(current) : patch;
    if (resolvedPatch === null) return { store, result: normalizeLiveQuest(current), write: false };
    const updated = applyQuestPatch(current, questId, resolvedPatch);
    if (resolvedPatch.lastModifiedBy) updated.lastModifiedBy = resolvedPatch.lastModifiedBy;
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

/**
 * Atomically append structured code-commit evidence while a quest is still in progress.
 * This narrow API is reserved for the exact active owner at the guarded Work -> Memory boundary.
 */
export async function appendQuestCodeCommitEvidenceForOwner(
  questId: string,
  owner: QuestOwnerRef,
  commitShas: unknown[],
  delivery?: QuestCodeDelivery,
): Promise<QuestmasterTask | null> {
  const normalizedOwner = normalizeQuestOwnerRef(owner);
  if (!normalizedOwner) throw new Error("A valid quest owner is required");
  const normalizedCommitShas = normalizeCommitShas(commitShas);
  if (normalizedCommitShas.length === 0) {
    throw new Error("At least one code commit SHA is required");
  }

  return mutateQuestWorkEvidence(questId, (current) =>
    appendCodeEvidence(current, normalizedOwner, normalizedCommitShas, delivery),
  );
}

/** Called only by the authenticated assigned-leader target approval route. */
export async function appendQuestDeliveryTargetApproval(
  questId: string,
  approval: QuestDeliveryTargetApproval,
): Promise<QuestmasterTask | null> {
  return mutateQuestWorkEvidence(questId, (current) => appendDeliveryTargetApproval(current, approval));
}

async function mutateQuestWorkEvidence(
  questId: string,
  appendEvidence: (current: QuestmasterTask) => QuestmasterTask,
): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = stripDerivedQuestRelationships(getLiveQuestById(store, questId));
    if (!current) return { store, result: null, write: false };
    const updated = appendEvidence(current);
    if (updated === current) return { store, result: current, write: false };
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

export interface QuestCodeCommitEvidenceReplacementInput {
  expectedCommitShas: readonly unknown[];
  replacementCommitShas: readonly unknown[];
  reason: string;
  journeyRunId: string;
  phaseOccurrenceId: string;
  verifiedTargetBranch: string;
  verifiedTargetHeadSha: string;
}

/**
 * Atomically replace structured code-commit evidence after exact-owner verification.
 * Ordinary Work evidence remains append-only; this API requires an exact ordered compare-and-swap
 * and records the correction as a separate append-only audit event.
 */
export async function replaceQuestCodeCommitEvidenceForOwner(
  questId: string,
  owner: QuestOwnerRef,
  input: QuestCodeCommitEvidenceReplacementInput,
): Promise<QuestmasterTask | null> {
  const normalizedOwner = normalizeQuestOwnerRef(owner);
  if (!normalizedOwner) throw new Error("A valid quest owner is required");
  const expectedCommitShas = normalizeCommitShas([...input.expectedCommitShas]);
  const replacementCommitShas = normalizeCommitShas([...input.replacementCommitShas]);
  if (expectedCommitShas.length === 0) {
    throw new Error("Existing code commit evidence must be non-empty for replacement");
  }
  if (replacementCommitShas.length === 0) {
    throw new Error("Replacement code commit evidence must be non-empty");
  }
  if (
    expectedCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS ||
    replacementCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS
  ) {
    throw new Error(
      `Code commit evidence replacement supports at most ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS} commits per list`,
    );
  }
  if (replacementCommitShas.length < expectedCommitShas.length) {
    throw new Error("Replacement code commit evidence cannot contain fewer commits than existing evidence");
  }
  if (orderedCommitShaListsEqual(expectedCommitShas, replacementCommitShas)) {
    throw new Error("Replacement code commit evidence must differ from existing evidence");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Code commit evidence replacement reason is required");
  if (reason.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH) {
    throw new Error(
      `Code commit evidence replacement reason must be ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH} characters or fewer`,
    );
  }
  const journeyRunId = input.journeyRunId.trim();
  if (!journeyRunId) throw new Error("journeyRunId is required for code commit evidence replacement");
  const phaseOccurrenceId = input.phaseOccurrenceId.trim();
  if (!phaseOccurrenceId) throw new Error("phaseOccurrenceId is required for code commit evidence replacement");
  const verifiedTargetBranch = input.verifiedTargetBranch.trim();
  if (!verifiedTargetBranch) throw new Error("Verified target branch is required for code commit evidence replacement");
  const verifiedTargetHeadSha = input.verifiedTargetHeadSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(verifiedTargetHeadSha)) {
    throw new Error("Verified target head must be a full 40-character commit SHA");
  }

  const replaceEvidence = (current: QuestmasterTask): QuestmasterTask => {
    if (current.status !== "in_progress") {
      throw new Error("Code commit evidence can only be replaced on an in-progress quest");
    }
    const activeOwner = getQuestOwner(current);
    if (!activeOwner || !sameQuestOwner(activeOwner, normalizedOwner)) {
      throw new Error("Only the exact active quest owner may replace in-progress code commit evidence");
    }
    const currentCommitShas = normalizeCommitShas(current.commitShas ?? []);
    if (!orderedCommitShaListsEqual(currentCommitShas, expectedCommitShas)) {
      throw new Error("Stored code commit evidence does not exactly match the expected ordered commits");
    }
    const now = Date.now();
    const codeCommitEvidenceReplacementEvents = appendQuestCodeCommitEvidenceReplacementEvent(
      current.codeCommitEvidenceReplacementEvents,
      {
        operation: "replace_code_commit_evidence",
        actorSessionId: normalizedOwner.sessionId,
        reason,
        previousCommitShas: currentCommitShas,
        replacementCommitShas,
        journeyRunId,
        phaseOccurrenceId,
        verifiedTargetBranch,
        verifiedTargetHeadSha,
      },
      now,
    );
    return {
      ...current,
      commitShas: replacementCommitShas,
      codeCommitEvidenceReplacementEvents,
      updatedAt: now,
    } as QuestmasterTask;
  };

  return mutateLiveQuestStore(async (store) => {
    const current = stripDerivedQuestRelationships(getLiveQuestById(store, questId));
    if (!current) return { store, result: null, write: false };
    const updated = replaceEvidence(current);
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

function orderedCommitShaListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((sha, index) => sha === right[index]);
}

/** Atomically append one feedback entry without replacing concurrently written feedback. */
export async function appendQuestFeedback(
  questId: string,
  entry: QuestFeedbackEntry,
  options?: { lastModifiedBy?: QuestInvocationProvenance },
): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = stripDerivedQuestRelationships(getLiveQuestById(store, questId));
    if (!current) return { store, result: null, write: false };
    const updated = applyQuestPatch(current, questId, {
      feedback: [...(current.feedback ?? []), entry],
      ...(options?.lastModifiedBy ? { lastModifiedBy: options.lastModifiedBy } : {}),
    });
    if (options?.lastModifiedBy) updated.lastModifiedBy = options.lastModifiedBy;
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

/** Delete a quest and all its versions. */
export async function deleteQuest(questId: string): Promise<boolean> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: false, write: false };
    return { store: removeLiveQuest(store, questId), result: true };
  });
}

/**
 * Generic status transition. Creates a new version linked to the previous.
 * Carries forward fields from the current version and adds new required fields.
 */
export async function transitionQuest(questId: string, input: QuestTransitionInput): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    const quest = buildTransitionedQuest(current, input);
    return { store: upsertLiveQuest(store, quest), result: quest };
  });
}

/** Get the active (in_progress) quest for a provider-aware owner, if any. */
export async function getActiveQuestForOwner(owner: QuestOwnerRef): Promise<QuestmasterTask | null> {
  const normalizedOwner = normalizeQuestOwnerRef(owner);
  if (!normalizedOwner) return null;
  return (
    (await currentStore()).quests.find(
      (quest) => quest.status === "in_progress" && sameQuestOwner(getQuestOwner(quest), normalizedOwner),
    ) ?? null
  );
}

/**
 * Get the active (in_progress) quest for a Takode session, if any.
 * Returns null if the session has no in_progress quest.
 */
export async function getActiveQuestForSession(sessionId: string): Promise<QuestmasterTask | null> {
  return getActiveQuestForOwner({ kind: "takode", sessionId });
}

/** Convenience: claim a quest (transition to in_progress). */
export async function claimQuest(
  questId: string,
  sessionId: string,
  options?: QuestClaimOptions,
): Promise<QuestmasterTask | null> {
  const leaderSessionId = options?.leaderSessionId?.trim();
  const nextOwner = normalizeQuestOwnerRef({ kind: options?.ownerKind ?? "takode", sessionId });
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    if (!nextOwner) throw new Error("sessionId is required to claim a quest");
    const existing = activeQuestBlockingClaim(store.quests, nextOwner, options);
    const input = buildQuestClaimTransitionInput(current, nextOwner, leaderSessionId, options, existing);
    if (!input) return { store, result: current, write: false };
    const quest = buildTransitionedQuest(current, input);
    return { store: upsertLiveQuest(store, quest), result: quest };
  });
}

/**
 * The owner's in-progress quest that keeps it from claiming another, if any. A quest that only
 * waits in Landing doesn't: its worker finished with it at final Memory.
 */
function activeQuestBlockingClaim(
  quests: readonly QuestmasterTask[],
  owner: QuestOwnerRef,
  options: QuestClaimOptions | undefined,
): QuestmasterTask | undefined {
  return quests.find(
    (quest) =>
      quest.status === "in_progress" &&
      sameQuestOwner(getQuestOwner(quest), owner) &&
      !options?.waitsInLanding?.(quest.questId),
  );
}

/**
 * Rewrite quests under one lock, for one-time migrations. `rewrite` gets the
 * whole store as single-file text and the quests, and returns replacement
 * quests (unchanged ones as the same objects), or null to leave the store
 * alone. Only the changed quests are written. A migration takes its own backup
 * from the text: this write is not recorded in the mutation journal.
 */
export async function rewriteAllQuests(
  rewrite: (storeText: string, quests: readonly QuestmasterTask[]) => Promise<QuestmasterTask[] | null>,
): Promise<boolean> {
  return withLiveStoreWriteLock(async () => {
    const current = await writableStore();
    const quests = await rewrite(singleFileStoreText(current), current.quests);
    if (!quests) return false;
    await writeQuestDirChanges(QUESTS_DIR, current, { ...current, quests });
    return true;
  });
}

/** Convenience: complete a quest (mark done and enter the review inbox). */
export async function completeQuest(
  questId: string,
  items: QuestVerificationItem[],
  opts?: {
    commitShas?: string[];
    memoryCommitShas?: string[];
    ownerKind?: QuestOwnerKind;
    provenance?: QuestInvocationProvenance;
    sessionId?: string;
    debrief?: string;
    debriefTldr?: string;
    debriefMachine?: string;
    recoveryEvent?: QuestRecoveryEventDraft;
  },
): Promise<QuestmasterTask | null> {
  return transitionQuest(questId, {
    status: "done",
    verificationItems: items,
    verificationInboxUnread: true,
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts?.ownerKind ? { ownerKind: opts.ownerKind } : {}),
    ...(opts?.provenance ? { lastModifiedBy: opts.provenance } : {}),
    ...(opts?.commitShas?.length ? { commitShas: opts.commitShas } : {}),
    ...(opts?.memoryCommitShas?.length ? { memoryCommitShas: opts.memoryCommitShas } : {}),
    ...(opts?.debrief !== undefined ? { debrief: opts.debrief } : {}),
    ...(opts?.debriefTldr !== undefined ? { debriefTldr: opts.debriefTldr } : {}),
    ...(opts?.debriefMachine ? { debriefMachine: opts.debriefMachine } : {}),
    ...(opts?.recoveryEvent ? { recoveryEvent: opts.recoveryEvent } : {}),
  });
}

/** Convenience: mark a quest as done (or cancelled). */
export async function markDone(
  questId: string,
  opts?: {
    notes?: string;
    cancelled?: boolean;
    debrief?: string;
    debriefTldr?: string;
    ownerKind?: QuestOwnerKind;
    provenance?: QuestInvocationProvenance;
  },
): Promise<QuestmasterTask | null> {
  return transitionQuest(questId, {
    status: "done",
    ...(opts?.notes ? { notes: opts.notes } : {}),
    ...(opts?.debrief !== undefined ? { debrief: opts.debrief } : {}),
    ...(opts?.debriefTldr !== undefined ? { debriefTldr: opts.debriefTldr } : {}),
    ...(opts?.cancelled ? { cancelled: true } : {}),
    ...(opts?.ownerKind ? { ownerKind: opts.ownerKind } : {}),
    ...(opts?.provenance ? { lastModifiedBy: opts.provenance } : {}),
  });
}

/**
 * Cancel a quest from any status. Transitions directly to done+cancelled
 * without requiring sessionId or verificationItems.
 */
export async function cancelQuest(
  questId: string,
  notes?: string,
  options?: { provenance?: QuestInvocationProvenance },
): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    const quest = buildCancelledQuest(current, notes, options?.provenance);
    return { store: upsertLiveQuest(store, quest), result: quest };
  });
}

/** Atomically cancel an unowned quest or one owned by the exact provider-aware owner. */
export async function cancelQuestForOwner(
  questId: string,
  owner: QuestOwnerRef,
  notes?: string,
  options?: { provenance?: QuestInvocationProvenance },
): Promise<QuestmasterTask | null> {
  const normalizedOwner = normalizeQuestOwnerRef(owner);
  if (!normalizedOwner) throw new Error("A valid quest owner is required");
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    assertQuestMutationOwner(current, normalizedOwner, "cancel");
    const quest = buildCancelledQuest(current, notes, options?.provenance);
    return { store: upsertLiveQuest(store, quest), result: quest };
  });
}

/** Toggle a User review check checkbox (in-place, no new version). */
export async function checkVerificationItem(
  questId: string,
  index: number,
  checked: boolean,
): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    if (!("verificationItems" in current)) {
      throw new Error("Quest does not have User review checks");
    }

    const items = [...(current as QuestDone).verificationItems];
    if (index < 0 || index >= items.length) {
      throw new Error(`User review check index ${index} out of range`);
    }

    items[index] = { ...items[index], checked };
    const updated = {
      ...current,
      verificationItems: items,
      updatedAt: Date.now(),
    } as QuestmasterTask;
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

/** Mark a review-pending quest as read so it leaves the review inbox. */
export async function markQuestVerificationRead(questId: string): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    if (!hasQuestReviewMetadata(current) || !current.verificationInboxUnread) {
      return { store, result: current, write: false };
    }

    const updated: QuestDone = {
      ...current,
      verificationInboxUnread: false,
      updatedAt: Date.now(),
    };
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

/** Mark a review-pending quest as unread so it returns to the review inbox. */
export async function markQuestVerificationInboxUnread(questId: string): Promise<QuestmasterTask | null> {
  return mutateLiveQuestStore(async (store) => {
    const current = getLiveQuestById(store, questId);
    if (!current) return { store, result: null, write: false };
    if (!hasQuestReviewMetadata(current) || current.verificationInboxUnread) {
      return { store, result: current, write: false };
    }

    const updated: QuestDone = {
      ...current,
      verificationInboxUnread: true,
      updatedAt: Date.now(),
    };
    return { store: upsertLiveQuest(store, updated), result: normalizeLiveQuest(updated) };
  });
}

// ─── Image management ────────────────────────────────────────────────────────

/** Save an image to disk and return image metadata. */
export async function saveQuestImage(filename: string, data: Buffer, mimeType: string): Promise<QuestImage> {
  return saveQuestImageFile({ filename, data, mimeType, liveImagesDir: LIVE_IMAGES_DIR, ensureLiveImagesDir });
}

/** Add images to a quest (in-place patch, no new version). */
export async function addQuestImages(questId: string, images: QuestImage[]): Promise<QuestmasterTask | null> {
  return addQuestImagesToStore(questId, images, {
    getLiveQuestById,
    liveQuestmasterDir: LIVE_QUESTMASTER_DIR,
    mutateLiveQuestStore,
    normalizeLiveQuest,
    upsertLiveQuest,
  });
}

/** Remove an image from a quest and delete the file. */
export async function removeQuestImage(questId: string, imageId: string): Promise<QuestmasterTask | null> {
  return removeQuestImageFromStore(questId, imageId, {
    getLiveQuestById,
    liveQuestmasterDir: LIVE_QUESTMASTER_DIR,
    mutateLiveQuestStore,
    normalizeLiveQuest,
    upsertLiveQuest,
  });
}

/** Read an image file from disk. Returns null if not found. */
export async function readQuestImageFile(imageId: string): Promise<{ data: Buffer; mimeType: string } | null> {
  return readQuestImageFileFromDirs(imageId, [LIVE_IMAGES_DIR, IMAGES_DIR]);
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Reset the store directory. Only for tests. */
export async function _resetForTests(): Promise<void> {
  assertSafeQuestmasterTestRoot(COMPANION_DIR);
  _clearCachedJsonFilesForTests();
  _clearQuestDirCacheForTests();
  for (const dir of [QUESTMASTER_DIR, LIVE_QUESTMASTER_DIR]) {
    await mkdir(dir, { recursive: true });
    try {
      const files = await readdir(dir);
      for (const file of files) {
        try {
          await rm(join(dir, file), { recursive: true, force: true });
        } catch {
          // ok
        }
      }
    } catch {
      // ok
    }
  }
}
