import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { getServerId, getServerSlug, normalizeServerSlug } from "./settings-manager.js";
import {
  COMPANION_MEMORY_SPACE_SLUG_ENV,
  DEFAULT_MEMORY_SESSION_SPACE_SLUG,
  normalizeMemorySessionSpaceSlug,
} from "./memory-session-space.js";
import {
  buildMemoryFolderInfos,
  laterDate,
  listMemoryRepoFiles,
  localDate,
  noteFolder,
  readGitLastCommitDates,
  readHelpfulMarks,
  resolveNoteType,
  setFrontmatterField,
} from "./memory-repo-layout.js";
import { checkMemoryRepoHealth } from "./memory-repo-health.js";
import { stampNoteMachine } from "./memory-note-machines.js";
import {
  LEGACY_TYPE_FOLDERS,
  MEMORY_COMMIT_OPERATIONS,
  MEMORY_DESCRIPTION_CHAR_LIMIT,
  MEMORY_NOTE_TYPES,
  type FrontmatterScalar,
  type FrontmatterValue,
  type MemoryCatalog,
  type MemoryCatalogChange,
  type MemoryCatalogEntry,
  type MemoryCatalogDiff,
  type MemoryCommitInput,
  type MemoryCommitDiff,
  type MemoryCommitFileChange,
  type MemoryCommitOperation,
  type MemoryCommitResult,
  type MemoryCommitSourceFile,
  type MemoryFile,
  type MemoryFrontmatter,
  type MemoryLintIssue,
  type MemoryNoteType,
  type MemoryLockAcquireInput,
  type MemoryLockInfo,
  type MemoryRecentCommit,
  type MemoryRepoInfo,
  type MemoryRepoOptions,
  type MemorySpaceInfo,
} from "./workstream-memory-types.js";

const execFileAsync = promisify(execFile);
const LOCK_DIR_NAME = "takode-memory.lock";
const LOCK_INFO_FILE = "owner.json";
const SERVER_INDEX_DIR = ".servers";
const CATALOG_SEEN_DIR_NAME = "takode-memory-catalog-seen";
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
/** This server run, recorded on locks it grants. */
const SERVER_RUN = randomUUID();
const DEFAULT_CATALOG_READ_CONCURRENCY = 16;
const LEGACY_TYPE_FOLDER_NAMES = Object.keys(LEGACY_TYPE_FOLDERS);
const OBSOLETE_FRONTMATTER_FIELDS = new Set([
  "id",
  "kind",
  "title",
  "summary",
  "lifecycle",
  "canonicalFor",
  "canonical_for",
]);

interface ResolvedMemoryRepo extends MemoryRepoInfo {
  baseRoot: string;
  explicitRoot: boolean;
}

interface ServerMemoryIndexEntry {
  serverId: string;
  serverSlug: string;
  sessionSpaceSlug?: string;
  root: string;
  updatedAt: string;
}

export interface MemoryCatalogScanRuntime {
  /** Testable indirection for catalog body reads; production uses async fs.readFile. */
  readFile?: (path: string, signal?: AbortSignal) => Promise<string>;
  /** Bound concurrent body reads so cold filesystems do not serialize every record. */
  readConcurrency?: number;
  /** Optional hard deadline; aborts remaining body reads and releases coalescing state. */
  timeoutMs?: number;
}

interface InternalMemoryCatalogScanRuntime extends MemoryCatalogScanRuntime {
  signal?: AbortSignal;
}

const inFlightMemoryCatalogScans = new Map<string, Promise<MemoryCatalog>>();
const memoryCatalogReaderIds = new WeakMap<Function, number>();
let nextMemoryCatalogReaderId = 1;

export async function ensureMemoryRepo(options: MemoryRepoOptions = {}): Promise<MemoryRepoInfo> {
  const repo = resolveMemoryRepoInternal(options);
  if (!repo.explicitRoot) {
    await migrateDefaultMemoryRepo(repo);
  }
  await mkdir(repo.root, { recursive: true });
  const initialized = await pathExists(join(repo.root, ".git"));
  if (!initialized) {
    await runGit(repo.root, ["init"]);
  }
  if (!repo.explicitRoot) {
    await writeServerMemoryIndex(repo);
  }
  return publicRepoInfo({ ...repo, initialized: true, authoredDirs: await topLevelFolders(repo.root) });
}

export function resolveMemoryRepo(options: MemoryRepoOptions = {}): MemoryRepoInfo {
  return publicRepoInfo(resolveMemoryRepoInternal(options));
}

export async function resolveMemoryOptionsForSpace(
  input: { serverSlug?: string; root?: string; expectedSessionSpaceSlugs?: string[] } = {},
): Promise<MemoryRepoOptions> {
  const requestedRoot = input.root?.trim();
  if (requestedRoot) {
    const spaces = await listMemorySpaces({ expectedSessionSpaceSlugs: input.expectedSessionSpaceSlugs });
    const space = spaces.find((item) => resolve(item.root) === resolve(requestedRoot));
    if (!space) {
      throw new Error(`Unknown memory space root: ${requestedRoot}`);
    }
    return memoryOptionsForSpace(space);
  }

  const normalizedSlug = normalizeServerSlug(input.serverSlug ?? "");
  if (!normalizedSlug) return {};

  const current = resolveMemoryRepoInternal();
  if (normalizedSlug === current.serverSlug) {
    return { serverSlug: normalizedSlug };
  }

  const spaces = await listMemorySpaces({ expectedSessionSpaceSlugs: input.expectedSessionSpaceSlugs });
  const sibling = spaces.find((space) => !space.current && normalizeServerSlug(space.slug) === normalizedSlug);
  if (!sibling) {
    return { serverSlug: normalizedSlug };
  }

  return memoryOptionsForSpace(sibling);
}

function resolveMemoryRepoInternal(options: MemoryRepoOptions = {}): ResolvedMemoryRepo {
  const serverId = (options.serverId ?? process.env.COMPANION_SERVER_ID ?? getServerId()).trim() || "local";
  const serverSlug =
    normalizeServerSlug(options.serverSlug ?? process.env.COMPANION_SERVER_SLUG ?? getServerSlug()) || "local";
  const sessionSpaceSlug = normalizeSessionSpaceSlug(
    options.sessionSpaceSlug ?? process.env[COMPANION_MEMORY_SPACE_SLUG_ENV] ?? DEFAULT_MEMORY_SESSION_SPACE_SLUG,
  );
  const explicitRoot = !!(options.root?.trim() || process.env.COMPANION_MEMORY_DIR?.trim());
  const baseRoot = join(process.env.HOME || homedir(), ".companion", "memory");
  const root =
    options.root?.trim() ||
    process.env.COMPANION_MEMORY_DIR?.trim() ||
    join(baseRoot, sanitizeSlugForPath(serverSlug), sanitizeSlugForPath(sessionSpaceSlug));
  return {
    root,
    serverId,
    serverSlug,
    sessionSpaceSlug,
    baseRoot,
    explicitRoot,
    initialized: false,
    authoredDirs: [],
  };
}

function publicRepoInfo(repo: ResolvedMemoryRepo): MemoryRepoInfo {
  return {
    root: repo.root,
    serverId: repo.serverId,
    serverSlug: repo.serverSlug,
    sessionSpaceSlug: repo.sessionSpaceSlug,
    initialized: repo.initialized,
    authoredDirs: repo.authoredDirs,
  };
}

export function scanMemoryCatalog(
  options: MemoryRepoOptions = {},
  runtime: MemoryCatalogScanRuntime = {},
): Promise<MemoryCatalog> {
  const timeoutMs = normalizeCatalogScanTimeout(runtime.timeoutMs);
  const effectiveRuntime = { ...runtime, ...(timeoutMs ? { timeoutMs } : {}) };
  const key = memoryCatalogScanKey(options, effectiveRuntime);
  const existing = inFlightMemoryCatalogScans.get(key);
  if (existing) return existing;

  const pending = createMemoryCatalogScan(options, effectiveRuntime);
  inFlightMemoryCatalogScans.set(key, pending);
  void pending.then(
    () => clearInFlightMemoryCatalogScan(key, pending),
    () => clearInFlightMemoryCatalogScan(key, pending),
  );
  return pending;
}

function createMemoryCatalogScan(
  options: MemoryRepoOptions,
  runtime: MemoryCatalogScanRuntime,
): Promise<MemoryCatalog> {
  const timeoutMs = normalizeCatalogScanTimeout(runtime.timeoutMs);
  if (!timeoutMs) return scanMemoryCatalogUncoalesced(options, runtime);

  const controller = new AbortController();
  const scan = scanMemoryCatalogUncoalesced(options, { ...runtime, signal: controller.signal });
  return withMemoryCatalogScanTimeout(scan, timeoutMs, controller);
}

async function scanMemoryCatalogUncoalesced(
  options: MemoryRepoOptions,
  runtime: InternalMemoryCatalogScanRuntime = {},
): Promise<MemoryCatalog> {
  const repo = await repoForRead(options);
  const { notePaths, readmePaths } = await listMemoryRepoFiles(repo.root);
  throwIfMemoryCatalogScanAborted(runtime.signal);
  const { files, issues } = await readMemoryCatalogFiles(repo.root, notePaths, runtime);
  const readmeFiles = await readMemoryCatalogFiles(repo.root, readmePaths, runtime);
  // A malformed folder README only loses its description; it never blocks commits.
  issues.push(...readmeFiles.issues.map((issue) => ({ ...issue, severity: "warning" as const })));
  // Notes from before topic folders have no `updated:`; their last commit date stands in.
  const needsGitDates = repo.initialized && files.some((file) => !file.updated);
  const [gitDates, helpfulMarks] = await Promise.all([
    needsGitDates ? readGitLastCommitDates(repo.root, runtime.signal) : new Map<string, string>(),
    readHelpfulMarks(repo.root),
  ]);
  throwIfMemoryCatalogScanAborted(runtime.signal);

  const entries: MemoryCatalogEntry[] = [];
  for (const file of files) {
    issues.push(...validateMemoryFile(file));
    entries.push(catalogEntryFromFile(file, gitDates.get(file.path) ?? "", helpfulMarks[file.path] ?? ""));
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const readmes = new Map(readmeFiles.files.map((file) => [noteFolder(file.path), { description: file.description }]));

  return {
    repo,
    entries,
    folders: buildMemoryFolderInfos(entries, readmes),
    issues,
    contentHashes: Object.fromEntries(
      files.map((file) => [file.path, createHash("sha256").update(file.content).digest("hex")]),
    ),
  };
}

function memoryCatalogScanKey(options: MemoryRepoOptions, runtime: MemoryCatalogScanRuntime): string {
  const repo = resolveMemoryRepoInternal(options);
  const timeoutMs = normalizeCatalogScanTimeout(runtime.timeoutMs);
  return [
    resolve(repo.root),
    repo.serverId,
    repo.serverSlug,
    repo.sessionSpaceSlug,
    options.readOnly === true ? "read-only" : "writable",
    timeoutMs ? `timeout:${timeoutMs}` : "no-timeout",
    `concurrency:${normalizeCatalogReadConcurrency(runtime.readConcurrency)}`,
    runtime.readFile ? `reader:${memoryCatalogReaderId(runtime.readFile)}` : "reader:default",
  ].join("\0");
}

function memoryCatalogReaderId(reader: NonNullable<MemoryCatalogScanRuntime["readFile"]>): number {
  const existing = memoryCatalogReaderIds.get(reader);
  if (existing) return existing;
  const id = nextMemoryCatalogReaderId++;
  memoryCatalogReaderIds.set(reader, id);
  return id;
}

function clearInFlightMemoryCatalogScan(key: string, pending: Promise<MemoryCatalog>): void {
  if (inFlightMemoryCatalogScans.get(key) === pending) {
    inFlightMemoryCatalogScans.delete(key);
  }
}

async function readMemoryCatalogFiles(
  root: string,
  absolutePaths: string[],
  runtime: InternalMemoryCatalogScanRuntime,
): Promise<{ files: MemoryFile[]; issues: MemoryLintIssue[] }> {
  type ReadResult = { file: MemoryFile; issue?: never } | { file?: never; issue: MemoryLintIssue };
  const readCatalogFile =
    runtime.readFile ?? ((path: string, signal?: AbortSignal) => readFile(path, { encoding: "utf-8", signal }));
  const concurrency = normalizeCatalogReadConcurrency(runtime.readConcurrency);
  const results = await mapWithConcurrency<string, ReadResult>(absolutePaths, concurrency, async (absolutePath) => {
    throwIfMemoryCatalogScanAborted(runtime.signal);
    const path = repoRelative(root, absolutePath);
    try {
      const content = await readCatalogFile(absolutePath, runtime.signal);
      throwIfMemoryCatalogScanAborted(runtime.signal);
      return { file: parseMemoryFile(root, absolutePath, content) } as const;
    } catch (error) {
      if (runtime.signal?.aborted) throw memoryCatalogAbortReason(runtime.signal);
      return {
        issue: { severity: "error", path, message: errorMessage(error) } satisfies MemoryLintIssue,
      } as const;
    }
  });
  const files: MemoryFile[] = [];
  const issues: MemoryLintIssue[] = [];
  for (const result of results) {
    if (result.file) files.push(result.file);
    else issues.push(result.issue);
  }
  return { files, issues };
}

function normalizeCatalogReadConcurrency(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return DEFAULT_CATALOG_READ_CONCURRENCY;
}

function normalizeCatalogScanTimeout(value: number | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return undefined;
}

function throwIfMemoryCatalogScanAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw memoryCatalogAbortReason(signal);
}

function memoryCatalogAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("memory catalog scan aborted");
}

async function withMemoryCatalogScanTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`memory catalog scan timed out after ${timeoutMs}ms`);
          reject(error);
          controller.abort(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function markMemoryCatalogSeen(catalog: MemoryCatalog, options: MemoryRepoOptions = {}): Promise<void> {
  await writeCatalogSeen(catalog, undefined, options.catalogSessionKey);
}

export async function diffMemoryCatalog(options: MemoryRepoOptions = {}): Promise<MemoryCatalogDiff> {
  const catalog = await scanMemoryCatalog(options);
  const sessionKey = catalogSessionKey(options.catalogSessionKey);
  const previous = await readCatalogSeen(catalog.repo.root, sessionKey);
  const seenAt = new Date().toISOString();
  const changes = diffCatalogEntries(previous, catalog);
  await writeCatalogSeen(catalog, seenAt, sessionKey);
  return {
    repo: catalog.repo,
    changes,
    issues: catalog.issues,
    sessionKey,
    ...(previous?.seenAt ? { previousSeenAt: previous.seenAt } : {}),
    seenAt,
  };
}

/**
 * Full health check: the catalog's per-note schema issues plus repo-wide structure checks.
 * Per-note rules marked `blocksCommitOfNote` are errors only for changed notes (by default the
 * uncommitted ones, i.e. what a commit would include), so repos from before topic folders keep
 * committing until curated.
 */
export async function lintMemory(
  options: MemoryRepoOptions = {},
  lintOptions: { changedPaths?: ReadonlySet<string> } = {},
): Promise<MemoryCatalog> {
  const catalog = await scanMemoryCatalog(options);
  const health = await checkMemoryRepoHealth(catalog);
  // Without Git yet (a read-only lint of a new repo), every note is part of the first commit.
  const changedPaths =
    lintOptions.changedPaths ??
    new Set(
      catalog.repo.initialized
        ? await changedMemoryPaths(catalog.repo.root)
        : catalog.entries.map((entry) => entry.path),
    );
  const issues = [...catalog.issues, ...health].map((issue) =>
    issue.blocksCommitOfNote && issue.path && changedPaths.has(issue.path)
      ? { ...issue, severity: "error" as const }
      : issue,
  );
  return { ...catalog, issues };
}

export async function listMemorySpaces(options: MemoryRepoOptions = {}): Promise<MemorySpaceInfo[]> {
  const currentRepo = await ensureMemoryRepo(options);
  const resolved = resolveMemoryRepoInternal(options);
  // This server's own entries first (the sort is stable), so a stale entry that another
  // server identity left for one of our repos, such as one written under a test's
  // identity, can't make that repo look like another server's.
  const serverIndex = (await readServerMemoryIndexes(resolved.baseRoot)).sort(
    (a, b) => Number(b.serverId === resolved.serverId) - Number(a.serverId === resolved.serverId),
  );
  const spaces = new Map<string, MemorySpaceInfo>();

  const addSpace = async (input: {
    slug: string;
    root: string;
    current: boolean;
    serverId?: string;
    index?: ServerMemoryIndexEntry;
  }) => {
    const authoredDirs = await topLevelFolders(input.root);
    spaces.set(resolve(input.root), {
      slug: input.slug,
      root: input.root,
      current: input.current,
      initialized: await pathExists(join(input.root, ".git")),
      authoredDirs,
      hasAuthoredData: await hasAuthoredMemoryData(input.root),
      sessionSpaceSlug: input.index?.sessionSpaceSlug ?? sessionSpaceSlugFromRoot(input.slug, input.root),
      ...(input.index?.serverId || input.serverId ? { serverId: input.index?.serverId ?? input.serverId } : {}),
      ...(input.index?.updatedAt ? { updatedAt: input.index.updatedAt } : {}),
    });
  };

  const currentIndex = serverIndex.find((entry) => resolve(entry.root) === resolve(currentRepo.root));
  await addSpace({
    slug: currentRepo.serverSlug,
    root: currentRepo.root,
    current: true,
    serverId: currentRepo.serverId,
    index: currentIndex,
  });

  for (const expectedSlug of options.expectedSessionSpaceSlugs ?? []) {
    const sessionSpaceSlug = normalizeSessionSpaceSlug(expectedSlug);
    const root = join(
      resolved.baseRoot,
      sanitizeSlugForPath(resolved.serverSlug),
      sanitizeSlugForPath(sessionSpaceSlug),
    );
    const index = serverIndex.find(
      (item) =>
        resolve(item.root) === resolve(root) ||
        (item.serverId === resolved.serverId &&
          item.serverSlug === resolved.serverSlug &&
          item.sessionSpaceSlug === sessionSpaceSlug),
    );
    await addSpace({
      slug: index?.serverSlug || resolved.serverSlug,
      root: index?.root || root,
      current: resolve(index?.root || root) === resolve(currentRepo.root),
      serverId: index?.serverId || resolved.serverId,
      index,
    });
  }

  for (const entry of await safeReaddir(resolved.baseRoot)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(resolved.baseRoot, entry.name);
    if (!spaces.has(resolve(root)) && (await looksLikeMemorySpace(root))) {
      const index = serverIndex.find((item) => resolve(item.root) === resolve(root) || item.serverSlug === entry.name);
      await addSpace({ slug: index?.serverSlug || entry.name, root, current: false, index });
    }

    for (const child of await safeReaddir(root)) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const childRoot = join(root, child.name);
      if (spaces.has(resolve(childRoot)) || !(await looksLikeMemorySpace(childRoot))) continue;
      const index = serverIndex.find((item) => resolve(item.root) === resolve(childRoot));
      await addSpace({
        slug: index?.serverSlug || entry.name,
        root: childRoot,
        current: false,
        index,
      });
    }
  }

  return [...spaces.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.slug.localeCompare(b.slug));
}

function memoryOptionsForSpace(space: MemorySpaceInfo): MemoryRepoOptions {
  const current = resolveMemoryRepoInternal();
  return {
    root: space.root,
    serverSlug: space.slug,
    ...(space.sessionSpaceSlug ? { sessionSpaceSlug: space.sessionSpaceSlug } : {}),
    readOnly: space.serverId !== current.serverId,
    ...(space.serverId ? { serverId: space.serverId } : {}),
  };
}

export async function getMemoryLock(options: MemoryRepoOptions = {}): Promise<MemoryLockInfo> {
  const repo = await repoForRead(options);
  return readLockInfo(repo.root);
}

export async function acquireMemoryLock(input: MemoryLockAcquireInput = {}): Promise<MemoryLockInfo> {
  const repo = await ensureMemoryRepo(input);
  const lockPath = memoryLockPath(repo.root);
  const now = Date.now();
  const expiresAt = new Date(now + (input.ttlMs ?? DEFAULT_LOCK_TTL_MS)).toISOString();
  const lockInfo = {
    owner: input.owner?.trim() || "takode-memory",
    session: input.lockHolder?.trim() || undefined,
    serverRun: SERVER_RUN,
    acquiredAt: new Date(now).toISOString(),
    expiresAt,
    token: randomUUID(),
  };

  try {
    await mkdir(lockPath);
  } catch (error) {
    const existing = await readLockInfo(repo.root);
    if (!canTakeOverLock(existing, lockInfo.session, input)) throw new Error(formatLockConflict(existing));
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
  }

  await writeFile(join(lockPath, LOCK_INFO_FILE), JSON.stringify(lockInfo, null, 2), "utf-8");
  return readLockInfo(repo.root);
}

export async function releaseMemoryLock(options: MemoryRepoOptions = {}): Promise<MemoryLockInfo> {
  const repo = await ensureMemoryRepo(options);
  const lockPath = memoryLockPath(repo.root);
  await rm(lockPath, { recursive: true, force: true });
  return readLockInfo(repo.root);
}

export async function memoryGitStatus(options: MemoryRepoOptions = {}): Promise<string> {
  const repo = await repoForRead(options);
  if (options.readOnly && !repo.initialized) return "";
  return (await runGit(repo.root, ["status", "--short", "--untracked-files=all"])).trim();
}

export async function memoryRecentCommits(options: MemoryRepoOptions = {}, limit = 6): Promise<MemoryRecentCommit[]> {
  const repo = await repoForRead(options);
  if (options.readOnly && !repo.initialized) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  try {
    const output = await runGit(repo.root, [
      "log",
      `--max-count=${safeLimit}`,
      "--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%ae%x1f%s%x1f%B%x1d",
      "--name-status",
    ]);
    return parseRecentMemoryCommits(output);
  } catch (error) {
    console.warn("Unable to read recent memory commits:", error);
    return [];
  }
}

export async function memoryCommitDiff(options: MemoryRepoOptions = {}, sha: string): Promise<MemoryCommitDiff | null> {
  const repo = await repoForRead(options);
  if (options.readOnly && !repo.initialized) return null;
  const normalizedSha = sha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(normalizedSha)) {
    throw new Error("Invalid memory update SHA");
  }

  try {
    const metadataOutput = await runGit(repo.root, [
      "show",
      "--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%ae%x1f%s%x1f%B%x1d",
      "--name-status",
      normalizedSha,
    ]);
    const commit = parseRecentMemoryCommits(metadataOutput)[0];
    if (!commit || commit.changedFiles.length === 0) return null;
    const diff = await runGit(repo.root, [
      "show",
      "--format=",
      "--find-renames",
      "--patch",
      "--no-ext-diff",
      "--unified=3",
      normalizedSha,
    ]);
    const sourceFiles = await readMemoryCommitSourceFiles(repo.root, normalizedSha, commit.changedFiles);
    return { repo, commit, diff, sourceFiles };
  } catch (error) {
    console.warn("Unable to read memory commit diff:", error);
    return null;
  }
}

async function readMemoryCommitSourceFiles(
  root: string,
  sha: string,
  changes: MemoryCommitFileChange[],
): Promise<MemoryCommitSourceFile[]> {
  const sourceFiles: MemoryCommitSourceFile[] = [];
  for (const change of changes) {
    const statusKind = change.status[0];
    const oldPath = change.previousPath ?? change.path;
    const sourceFile = {
      status: change.status,
      path: change.path,
      oldText: statusKind === "A" ? "" : await readCommitFile(root, `${sha}^`, oldPath),
      newText: statusKind === "D" ? "" : await readCommitFile(root, sha, change.path),
    };
    sourceFiles.push(change.previousPath ? { ...sourceFile, previousPath: change.previousPath } : sourceFile);
  }
  return sourceFiles;
}

async function readCommitFile(root: string, rev: string, path: string): Promise<string> {
  try {
    return await runGit(root, ["show", `${rev}:${path}`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read memory file content for ${path} at ${rev}: ${message}`);
  }
}

function parseRecentMemoryCommits(output: string): MemoryRecentCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map(parseRecentMemoryCommit)
    .filter((commit) => commit.sha && commit.shortSha && Number.isFinite(commit.timestamp));
}

function parseRecentMemoryCommit(record: string): MemoryRecentCommit {
  const [metadata = "", changedFilesBlock = ""] = record.split("\x1d", 2);
  const [sha = "", shortSha = "", timestamp = "0", authorName = "", authorEmail = "", message = "", body = ""] =
    splitDelimitedFields(metadata, "\x1f", 7);
  const trailers = parseCommitTrailers(body);
  const session = firstTrailerValue(trailers, "session");
  const author = authorName.trim();
  return {
    sha,
    shortSha,
    timestamp: Number.parseInt(timestamp, 10) * 1000,
    message,
    authorName: author,
    authorEmail: authorEmail.trim(),
    actor: session || (author && author !== "Takode Memory" ? author : null),
    quest: firstTrailerValue(trailers, "quest"),
    session,
    sources: trailerValues(trailers, "source"),
    changedFiles: parseMemoryCommitFileChanges(changedFilesBlock),
  };
}

function splitDelimitedFields(value: string, delimiter: string, expectedFields: number): string[] {
  const fields: string[] = [];
  let rest = value;
  while (fields.length < expectedFields - 1) {
    const index = rest.indexOf(delimiter);
    if (index === -1) break;
    fields.push(rest.slice(0, index));
    rest = rest.slice(index + delimiter.length);
  }
  fields.push(rest);
  return fields;
}

function parseCommitTrailers(body: string): Map<string, string[]> {
  const trailers = new Map<string, string[]>();
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z][A-Za-z-]*):\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    trailers.set(key, [...(trailers.get(key) ?? []), match[2]!.trim()]);
  }
  return trailers;
}

function firstTrailerValue(trailers: Map<string, string[]>, key: string): string | null {
  return trailers.get(key.toLowerCase())?.[0] ?? null;
}

function trailerValues(trailers: Map<string, string[]>, key: string): string[] {
  return trailers.get(key.toLowerCase()) ?? [];
}

function parseMemoryCommitFileChanges(block: string): MemoryRecentCommit["changedFiles"] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status = "", firstPath = "", secondPath] = line.split("\t");
      if (secondPath) return { status, previousPath: firstPath, path: secondPath };
      return { status, path: firstPath };
    })
    .filter((change) => change.status && change.path);
}

export async function memoryGitDiff(options: MemoryRepoOptions = {}): Promise<string> {
  const repo = await repoForRead(options);
  if (options.readOnly && !repo.initialized) return "";
  return runGit(repo.root, ["diff"]);
}

export async function commitMemory(input: MemoryCommitInput): Promise<MemoryCommitResult> {
  const repo = await ensureMemoryRepo(input);
  validateMemoryCommitInput(input);
  await assertMemoryLockHolder(repo.root, input.lockHolder);
  const changedPaths = await changedMemoryPaths(repo.root);
  // A repair (moves, reference rewrites, README and description fixes) doesn't change what notes
  // say: it neither makes them look recently updated nor holds the notes it touched to the
  // per-note rules, which would otherwise block mechanical moves in uncurated repos.
  const repair = parseOperation(input.operation) === "repair";
  const catalog = await lintMemory(input, { changedPaths: new Set(repair ? [] : changedPaths) });
  const errors = catalog.issues.filter((issue) => issue.severity === "error");
  if (errors.length) {
    throw new Error(`Memory lint failed: ${errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  if (!repair) await stampChangedNotes(repo.root, changedPaths, input.machine);

  await runGit(repo.root, ["add", "-A"]);
  const status = await memoryGitStatus(input);
  if (!status) {
    return { committed: false, message: "No memory changes to commit", status };
  }

  const message = buildCommitMessage(input);
  await runGit(repo.root, [
    "-c",
    "user.name=Takode Memory",
    "-c",
    "user.email=takode-memory@local",
    "commit",
    "-m",
    message,
  ]);
  const sha = (await runGit(repo.root, ["rev-parse", "--short", "HEAD"])).trim();
  return { committed: true, sha, message, status };
}

export function parseMemoryFile(root: string, absolutePath: string, content: string): MemoryFile {
  const { frontmatter, body } = parseFrontmatter(content);
  const path = repoRelative(root, absolutePath);
  return {
    id: path,
    type: resolveNoteType(path, optionalString(frontmatter.type)),
    folder: noteFolder(path),
    updated: optionalString(frontmatter.updated),
    description: optionalString(frontmatter.description),
    source: stringList(frontmatter.source),
    machines: stringList(frontmatter.machines),
    path,
    absolutePath,
    frontmatter,
    body,
    content,
  };
}

export async function readMemoryRecord(
  path: string,
  options: MemoryRepoOptions = {},
): Promise<{ repo: MemoryRepoInfo; file: MemoryFile }> {
  const repo = await repoForRead(options);
  const resolvedRecord = await resolveMemoryRecordPath(repo.root, path);
  const content = await readFile(resolvedRecord.absolutePath, "utf-8");
  return { repo, file: parseMemoryFile(resolvedRecord.root, resolvedRecord.absolutePath, content) };
}

async function repoForRead(options: MemoryRepoOptions): Promise<MemoryRepoInfo> {
  if (options.readOnly) {
    return inspectExistingMemoryRepo(options);
  }
  return ensureMemoryRepo(options);
}

async function inspectExistingMemoryRepo(options: MemoryRepoOptions): Promise<MemoryRepoInfo> {
  const repo = resolveMemoryRepoInternal(options);
  return publicRepoInfo({
    ...repo,
    initialized: await pathExists(join(repo.root, ".git")),
    authoredDirs: await topLevelFolders(repo.root),
  });
}

function catalogEntryFromFile(file: MemoryFile, gitDate: string, helpfulDate: string): MemoryCatalogEntry {
  const updated = file.updated || gitDate;
  return {
    id: file.id,
    ...(file.type ? { type: file.type } : {}),
    folder: file.folder,
    updated,
    touched: laterDate(updated, helpfulDate),
    description: file.description,
    path: file.path,
    source: file.source,
    machines: file.machines,
    facets: normalizeFacets(file.frontmatter.facets),
  };
}

interface CatalogSeenSnapshot {
  seenAt: string;
  entries: MemoryCatalogEntry[];
  contentHashes?: Record<string, string>;
}

async function readCatalogSeen(root: string, sessionKey = catalogSessionKey()): Promise<CatalogSeenSnapshot | null> {
  try {
    const raw = await readFile(catalogSeenPath(root, sessionKey), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CatalogSeenSnapshot>;
    if (typeof parsed.seenAt !== "string" || !Array.isArray(parsed.entries)) return null;
    return {
      seenAt: parsed.seenAt,
      entries: parsed.entries.filter(isMemoryCatalogEntry),
      contentHashes: parsed.contentHashes,
    };
  } catch {
    return null;
  }
}

async function writeCatalogSeen(
  catalog: MemoryCatalog,
  seenAt = new Date().toISOString(),
  sessionKey = catalogSessionKey(),
): Promise<void> {
  const path = catalogSeenPath(catalog.repo.root, sessionKey);
  await mkdir(dirname(path), { recursive: true });
  const snapshot: CatalogSeenSnapshot = {
    seenAt,
    entries: catalog.entries,
    contentHashes: catalog.contentHashes,
  };
  await writeFile(path, JSON.stringify(snapshot, null, 2), "utf-8");
}

function diffCatalogEntries(
  previousSnapshot: CatalogSeenSnapshot | null,
  catalog: MemoryCatalog,
): MemoryCatalogChange[] {
  const previous = new Map((previousSnapshot?.entries ?? []).map((entry) => [entry.path, entry]));
  const current = new Map(catalog.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const changes: MemoryCatalogChange[] = [];
  for (const path of paths) {
    const before = previous.get(path);
    const after = current.get(path);
    if (!before && after) {
      changes.push({ kind: "added", path, after });
      continue;
    }
    if (before && !after) {
      changes.push({ kind: "removed", path, before });
      continue;
    }
    const previousHash = previousSnapshot?.contentHashes?.[path];
    // Legacy snapshots cannot prove the body is unchanged. Report the entry once,
    // then let the returned catalog establish a content-aware baseline.
    if (before && after && (!previousHash || previousHash !== catalog.contentHashes?.[path])) {
      changes.push({ kind: "changed", path, before, after });
    }
  }
  return changes;
}

function isMemoryCatalogEntry(value: unknown): value is MemoryCatalogEntry {
  const entry = value as Partial<MemoryCatalogEntry>;
  return (
    !!entry &&
    typeof entry.id === "string" &&
    typeof entry.description === "string" &&
    typeof entry.path === "string" &&
    Array.isArray(entry.source) &&
    typeof entry.facets === "object" &&
    entry.facets !== null
  );
}

function catalogSeenPath(root: string, sessionKey = catalogSessionKey()): string {
  return join(root, ".git", CATALOG_SEEN_DIR_NAME, `${sanitizeSlugForPath(sessionKey)}.json`);
}

function catalogSessionKey(override?: string): string {
  return (
    override?.trim() ||
    process.env.COMPANION_SESSION_ID?.trim() ||
    process.env.COMPANION_SESSION_NUM?.trim() ||
    process.env.TAKODE_SESSION_ID?.trim() ||
    "default"
  );
}

function validateMemoryFile(file: MemoryFile): MemoryLintIssue[] {
  const issues: MemoryLintIssue[] = [];
  for (const field of OBSOLETE_FRONTMATTER_FIELDS) {
    if (file.frontmatter[field] !== undefined) {
      issues.push({
        severity: "warning",
        id: file.id,
        path: file.path,
        message: `Obsolete memory frontmatter field "${field}" is ignored; derive it from path or use description/source.`,
      });
    }
  }
  if (file.description.length === 0) {
    issues.push({ severity: "error", id: file.id, path: file.path, message: "Memory description is required" });
  }
  const descriptionLength = [...file.description].length;
  if (descriptionLength > MEMORY_DESCRIPTION_CHAR_LIMIT) {
    issues.push({
      severity: "warning",
      blocksCommitOfNote: true,
      id: file.id,
      path: file.path,
      message: `Memory description has ${descriptionLength} characters; maximum is ${MEMORY_DESCRIPTION_CHAR_LIMIT}. Rewrite it as a "Read when/before/for..." routing line and keep detail in the body.`,
    });
  }
  const explicitType = optionalString(file.frontmatter.type);
  if (explicitType && !MEMORY_NOTE_TYPES.includes(explicitType as MemoryNoteType)) {
    issues.push({
      severity: "error",
      id: file.id,
      path: file.path,
      message: `Unknown memory type "${explicitType}". Use one of: ${MEMORY_NOTE_TYPES.join(", ")}.`,
    });
  } else if (!file.type) {
    issues.push({
      severity: "warning",
      blocksCommitOfNote: true,
      id: file.id,
      path: file.path,
      message: `Memory note has no type. Add \`type:\` (one of: ${MEMORY_NOTE_TYPES.join(", ")}).`,
    });
  }
  if (!file.folder) {
    issues.push({
      severity: "warning",
      blocksCommitOfNote: true,
      id: file.id,
      path: file.path,
      message: "Memory note is at the repo root; move it into a topic folder with `memory mv`.",
    });
  }
  if (typeof file.frontmatter.source === "string") {
    issues.push({
      severity: "error",
      id: file.id,
      path: file.path,
      message: "Memory source must be a YAML list of contributing quest or session refs",
    });
  }
  if (file.source.length === 0) {
    issues.push({
      severity: "error",
      id: file.id,
      path: file.path,
      message: "Memory source must list at least one contributing quest or session ref",
    });
  }
  if (!basename(file.path).endsWith(".md")) {
    issues.push({ severity: "error", id: file.id, path: file.path, message: "Memory files must use .md extension" });
  }
  return issues;
}

function parseFrontmatter(content: string): { frontmatter: MemoryFrontmatter; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new Error("Memory files must start with YAML frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) throw new Error("Memory frontmatter is missing closing ---");
  return {
    frontmatter: parseYamlSubset(lines.slice(1, end)),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

function parseYamlSubset(lines: string[]): MemoryFrontmatter {
  const result: MemoryFrontmatter = {};
  let currentKey: string | undefined;
  let currentNestedKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const listMatch = /^  -\s+(.+)$/.exec(line);
    if (listMatch && currentKey) {
      appendTopLevelListValue(result, currentKey, parseScalar(listMatch[1]));
      continue;
    }

    const nestedListMatch = /^    -\s+(.+)$/.exec(line);
    if (nestedListMatch && currentKey && currentNestedKey) {
      appendNestedListValue(result, currentKey, currentNestedKey, parseScalar(nestedListMatch[1]));
      continue;
    }

    const nestedMatch = /^  ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nestedMatch && currentKey) {
      currentNestedKey = nestedMatch[1];
      setNestedValue(result, currentKey, currentNestedKey, parseYamlValue(nestedMatch[2]));
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Unsupported frontmatter line: ${line}`);
    currentKey = match[1];
    currentNestedKey = undefined;
    result[currentKey] = parseYamlValue(match[2]);
  }

  return result;
}

function parseYamlValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  return parseScalar(trimmed);
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function appendTopLevelListValue(result: MemoryFrontmatter, key: string, value: string): void {
  const existing = result[key];
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  if (existing === undefined) {
    result[key] = [value];
    return;
  }
  result[key] = [String(existing), value];
}

function appendNestedListValue(result: MemoryFrontmatter, key: string, nestedKey: string, value: string): void {
  const parent = objectValue(result[key]);
  const existing = parent[nestedKey];
  parent[nestedKey] = Array.isArray(existing) ? [...existing, value] : existing ? [String(existing), value] : [value];
  result[key] = parent;
}

function setNestedValue(result: MemoryFrontmatter, key: string, nestedKey: string, value: FrontmatterValue): void {
  const parent = objectValue(result[key]);
  parent[nestedKey] = Array.isArray(value) || typeof value === "string" ? value : [];
  result[key] = parent;
}

function objectValue(value: FrontmatterValue | undefined): Record<string, FrontmatterScalar> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function optionalString(value: FrontmatterValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: FrontmatterValue | undefined): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeFacets(value: FrontmatterValue | undefined): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const facets: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const values = Array.isArray(raw) ? raw : [raw];
    facets[key] = values.map((item) => String(item).trim()).filter(Boolean);
  }
  return facets;
}

function parseOperation(value: string | undefined): MemoryCommitOperation | undefined {
  if (!value) return undefined;
  if (MEMORY_COMMIT_OPERATIONS.includes(value as MemoryCommitOperation)) return value as MemoryCommitOperation;
  throw new Error(`Invalid memory operation "${value}". Expected one of: ${MEMORY_COMMIT_OPERATIONS.join(", ")}`);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".")) files.push(...(await listMarkdownFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

async function safeReaddir(dir: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readLockInfo(root: string): Promise<MemoryLockInfo> {
  const lockPath = memoryLockPath(root);
  try {
    const raw = JSON.parse(await readFile(join(lockPath, LOCK_INFO_FILE), "utf-8")) as {
      owner?: string;
      session?: string;
      acquiredAt?: string;
      expiresAt?: string;
      serverRun?: string;
    };
    const expiresAt = raw.expiresAt;
    return {
      locked: true,
      lockPath,
      owner: raw.owner,
      session: raw.session,
      acquiredAt: raw.acquiredAt,
      expiresAt,
      stale: expiresAt ? Date.parse(expiresAt) <= Date.now() : false,
      serverRun: raw.serverRun,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { locked: false, lockPath };
    throw error;
  }
}

/**
 * Whether `holder` may replace an existing lock: its own lock (a session acquiring again, for
 * example after its process restarted), or one whose holder is gone. A holder is gone when the
 * lock expired, its session has ended, or, for a sessionless holder that cannot be checked,
 * when the lock was granted by an earlier server run.
 */
function canTakeOverLock(lock: MemoryLockInfo, holder: string | undefined, input: MemoryLockAcquireInput): boolean {
  if (holder && lock.session === holder) return true;
  if (input.stealStale === false) return false;
  if (lock.stale) return true;
  return lock.session ? input.isSessionGone?.(lock.session) === true : lock.serverRun !== SERVER_RUN;
}

function formatLockConflict(info: MemoryLockInfo): string {
  if (!info.locked) return "Memory repo is locked";
  const owner = info.owner ? ` by ${info.owner}` : "";
  const session = info.session ? ` (${info.session})` : "";
  const expires = info.expiresAt ? ` until ${info.expiresAt}` : "";
  return `Memory repo is already locked${owner}${session}${expires}`;
}

/** Repo-relative paths with uncommitted changes, including both sides of renames. */
async function changedMemoryPaths(root: string): Promise<string[]> {
  const output = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index].slice(0, 2);
    paths.push(fields[index].slice(3));
    if (status.includes("R") || status.includes("C")) paths.push(fields[++index]);
  }
  return paths;
}

/**
 * Stamp `updated:` with today's date, and the committing session's machine when known, on
 * changed notes that still exist (not folder READMEs).
 */
async function stampChangedNotes(root: string, changedPaths: string[], machine: string | undefined): Promise<void> {
  const today = localDate();
  for (const path of changedPaths) {
    if (!path.endsWith(".md") || path === "README.md" || path.endsWith("/README.md")) continue;
    let content: string;
    try {
      content = await readFile(join(root, path), "utf-8");
    } catch {
      continue; // Deleted or moved away.
    }
    const dated = setFrontmatterField(content, "updated", today);
    const stamped = machine ? stampNoteMachine(dated, machine) : dated;
    if (stamped !== content) await writeFile(join(root, path), stamped, "utf-8");
  }
}

function buildCommitMessage(input: MemoryCommitInput): string {
  if (!input.message.trim()) throw new Error("Memory commit message is required");
  const lines = [input.message.trim(), ""];
  const operation = parseOperation(input.operation);
  if (operation) lines.push(`Memory-Operation: ${operation}`);
  for (const id of input.memoryIds ?? []) lines.push(`Memory-Id: ${id}`);
  if (input.quest?.trim()) lines.push(`Quest: ${input.quest.trim()}`);
  if (input.session?.trim()) lines.push(`Session: ${input.session.trim()}`);
  for (const source of input.sources ?? []) lines.push(`Source: ${source}`);
  return lines.join("\n");
}

/** Throw unless the repo lock is held, unexpired, by `holder` (see `MemoryRepoOptions.lockHolder`). */
export async function assertMemoryLockHolder(root: string, holder: string | undefined): Promise<void> {
  const lock = await readLockInfo(root);
  if (!lock.locked) {
    throw new Error("Acquire the memory repo lock before changing memory notes (`memory lock acquire`).");
  }
  if (lock.stale) {
    throw new Error("Memory repo lock is stale; acquire a fresh lock before changing memory notes.");
  }
  const caller = holder?.trim() || undefined;
  if (lock.session !== caller) {
    const heldBy = lock.session ? `session ${lock.session}` : "a caller without a session";
    const self = caller ? `session ${caller}` : "this caller";
    throw new Error(
      `The memory repo lock is held by ${heldBy} (owner ${lock.owner ?? "unknown"}), not by ${self}. ` +
        "Wait for it to be released, then run `memory lock acquire`.",
    );
  }
}

function validateMemoryCommitInput(input: MemoryCommitInput): void {
  if (!input.message.trim()) throw new Error("Memory commit message is required");
  const sources = (input.sources ?? []).map((source) => source.trim()).filter(Boolean);
  if (sources.length === 0) {
    throw new Error("Memory commits require at least one source trailer.");
  }
  const hasTraceability = Boolean(
    input.quest?.trim() || input.session?.trim() || input.memoryIds?.some((id) => id.trim()),
  );
  if (!hasTraceability) {
    throw new Error("Memory commits require traceability: include quest, session, or at least one memory id.");
  }
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-C", root, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function migrateDefaultMemoryRepo(repo: ResolvedMemoryRepo): Promise<void> {
  const candidates = await getMigrationCandidates(repo);
  if (!candidates.length) return;

  const source = await firstExistingMemoryRepo(candidates, repo.root);
  if (!source) return;

  const flatTargetRoot = join(repo.baseRoot, sanitizeSlugForPath(repo.serverSlug));
  if (
    resolve(flatTargetRoot) !== resolve(source) &&
    resolve(flatTargetRoot) !== resolve(repo.root) &&
    isPathInside(resolve(flatTargetRoot), resolve(repo.root)) &&
    (await pathExists(flatTargetRoot)) &&
    (await hasAuthoredMemoryData(flatTargetRoot))
  ) {
    throw new Error(formatMemoryRepoSlugConflict(repo, source));
  }

  const targetExists = await pathExists(repo.root);
  if (targetExists && !(await isEmptyMemoryRepo(repo.root))) {
    throw new Error(formatMemoryRepoSlugConflict(repo, source));
  }

  await mkdir(repo.baseRoot, { recursive: true });
  if (targetExists) {
    await rm(repo.root, { recursive: true, force: true });
  }
  await moveMemoryRepo(source, repo.root, repo.baseRoot);
}

async function getMigrationCandidates(repo: ResolvedMemoryRepo): Promise<string[]> {
  const candidates: string[] = [];
  const index = await readServerMemoryIndex(repo.baseRoot, repo.serverId, repo.sessionSpaceSlug);
  if (index?.root) candidates.push(index.root);
  if (index?.serverSlug) {
    const indexedServerRoot = join(repo.baseRoot, sanitizeSlugForPath(index.serverSlug));
    candidates.push(join(indexedServerRoot, sanitizeSlugForPath(index.sessionSpaceSlug ?? repo.sessionSpaceSlug)));
    candidates.push(indexedServerRoot);
  }
  const currentServerRoot = join(repo.baseRoot, sanitizeSlugForPath(repo.serverSlug));
  candidates.push(currentServerRoot);
  candidates.push(join(repo.baseRoot, sanitizeSlugForPath(repo.serverId)));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = resolve(candidate);
    if (!candidate || resolved === resolve(repo.root) || seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

async function firstExistingMemoryRepo(candidates: string[], targetRoot: string): Promise<string | null> {
  for (const candidate of candidates) {
    if (resolve(candidate) === resolve(targetRoot) || !(await pathExists(candidate))) continue;
    if (!(await looksLikeMemorySpace(candidate))) continue;
    return candidate;
  }
  return null;
}

function formatMemoryRepoSlugConflict(repo: ResolvedMemoryRepo, sourceRoot: string): string {
  const space = `${repo.serverSlug}/${repo.sessionSpaceSlug}`;
  return [
    `Memory repo space "${space}" already exists at ${repo.root} and contains authored data.`,
    `Existing memory for this server id is still at ${sourceRoot}.`,
    "Rename the server slug or merge the memory repos manually before using this session space.",
  ].join(" ");
}

async function moveMemoryRepo(sourceRoot: string, targetRoot: string, baseRoot: string): Promise<void> {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  await mkdir(dirname(target), { recursive: true });

  if (!isPathInside(source, target)) {
    await rename(source, target);
    return;
  }

  const tempRoot = join(baseRoot, `.migration-${basename(source)}-${randomUUID()}`);
  await rename(source, tempRoot);
  await mkdir(dirname(target), { recursive: true });
  await rename(tempRoot, target);
}

async function readServerMemoryIndex(
  baseRoot: string,
  serverId: string,
  sessionSpaceSlug: string,
): Promise<ServerMemoryIndexEntry | null> {
  const currentIndex = await readServerMemoryIndexFile(serverIndexPath(baseRoot, serverId, sessionSpaceSlug), serverId);
  if (currentIndex) return currentIndex;

  const legacyIndex = await readServerMemoryIndexFile(legacyServerIndexPath(baseRoot, serverId), serverId);
  if (!legacyIndex) return null;
  if (legacyIndex.sessionSpaceSlug && legacyIndex.sessionSpaceSlug !== sessionSpaceSlug) return null;
  return legacyIndex;
}

async function readServerMemoryIndexFile(
  path: string,
  expectedServerId?: string,
): Promise<ServerMemoryIndexEntry | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServerMemoryIndexEntry>;
    if (typeof parsed.serverId !== "string") return null;
    if (expectedServerId !== undefined && parsed.serverId !== expectedServerId) return null;
    return {
      serverId: parsed.serverId,
      serverSlug: typeof parsed.serverSlug === "string" ? parsed.serverSlug : "",
      ...(typeof parsed.sessionSpaceSlug === "string"
        ? { sessionSpaceSlug: normalizeSessionSpaceSlug(parsed.sessionSpaceSlug) }
        : {}),
      root: typeof parsed.root === "string" ? parsed.root : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

async function readServerMemoryIndexes(baseRoot: string): Promise<ServerMemoryIndexEntry[]> {
  const dir = join(baseRoot, SERVER_INDEX_DIR);
  const entries = await safeReaddir(dir);
  const indexes: ServerMemoryIndexEntry[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const index = await readServerMemoryIndexFile(join(dir, entry.name));
      if (index) {
        indexes.push(index);
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    const childDir = join(dir, entry.name);
    for (const child of await safeReaddir(childDir)) {
      if (!child.isFile() || !child.name.endsWith(".json")) continue;
      const index = await readServerMemoryIndexFile(join(childDir, child.name));
      if (index) {
        indexes.push(index);
      }
    }
  }
  return indexes;
}

async function writeServerMemoryIndex(repo: ResolvedMemoryRepo): Promise<void> {
  const path = serverIndexPath(repo.baseRoot, repo.serverId, repo.sessionSpaceSlug);
  await mkdir(dirname(path), { recursive: true });
  const entry: ServerMemoryIndexEntry = {
    serverId: repo.serverId,
    serverSlug: repo.serverSlug,
    sessionSpaceSlug: repo.sessionSpaceSlug,
    root: repo.root,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(entry, null, 2), "utf-8");
}

function serverIndexPath(baseRoot: string, serverId: string, sessionSpaceSlug: string): string {
  return join(
    baseRoot,
    SERVER_INDEX_DIR,
    sanitizeSlugForPath(serverId),
    `${sanitizeSlugForPath(sessionSpaceSlug)}.json`,
  );
}

function legacyServerIndexPath(baseRoot: string, serverId: string): string {
  return join(baseRoot, SERVER_INDEX_DIR, `${sanitizeSlugForPath(serverId)}.json`);
}

async function isEmptyMemoryRepo(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const allowedEmptyDirs = new Set([".git", ...LEGACY_TYPE_FOLDER_NAMES]);
    for (const entry of entries) {
      if (entry.isDirectory() && allowedEmptyDirs.has(entry.name)) continue;
      return false;
    }
    for (const kind of LEGACY_TYPE_FOLDER_NAMES) {
      const kindPath = join(path, kind);
      if ((await pathExists(kindPath)) && (await listMarkdownFiles(kindPath)).length > 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function looksLikeMemorySpace(root: string): Promise<boolean> {
  if (await pathExists(join(root, ".git"))) return true;
  return (await existingLegacyTypeFolders(root)).length > 0;
}

/** Legacy type folders identify a memory repo even before Git init (pre-session-space layouts). */
async function existingLegacyTypeFolders(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const kind of LEGACY_TYPE_FOLDER_NAMES) {
    try {
      const info = await stat(join(root, kind));
      if (info.isDirectory()) dirs.push(kind);
    } catch {
      continue;
    }
  }
  return dirs;
}

async function topLevelFolders(root: string): Promise<string[]> {
  return (await safeReaddir(root))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Notes in legacy type folders, or anywhere in a Git-initialized repo. The Git requirement keeps
 * a server-slug directory that merely contains session-space repos from counting as a repo.
 */
async function hasAuthoredMemoryData(root: string): Promise<boolean> {
  for (const kind of LEGACY_TYPE_FOLDER_NAMES) {
    if ((await listMarkdownFiles(join(root, kind))).length > 0) return true;
  }
  if (!(await pathExists(join(root, ".git")))) return false;
  return (await listMemoryRepoFiles(root)).notePaths.length > 0;
}

function sanitizeSlugForPath(slug: string): string {
  return slug.trim().replace(/[^a-zA-Z0-9_.-]/g, "_") || "local";
}

function normalizeSessionSpaceSlug(slug: string): string {
  return normalizeMemorySessionSpaceSlug(slug);
}

function sessionSpaceSlugFromRoot(serverSlug: string, root: string): string | undefined {
  const parent = basename(dirname(root));
  if (parent !== sanitizeSlugForPath(serverSlug)) return undefined;
  return basename(root);
}

function repoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function resolveMemoryRecordPath(
  root: string,
  requestedPath: string,
): Promise<{ root: string; absolutePath: string }> {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) throw new Error("Memory record path is required");
  if (isAbsolute(trimmedPath)) throw new Error("Memory record path must be repo-relative");

  const rootPath = resolve(root);
  const syntacticPath = resolve(rootPath, trimmedPath);
  const syntacticRelativePath = repoRelative(rootPath, syntacticPath);
  if (!isPathInside(rootPath, syntacticPath)) {
    throw new Error("Memory record path must stay inside the memory repo");
  }
  if (syntacticRelativePath.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error("Memory record path must not be inside a hidden directory");
  }
  if (!syntacticRelativePath.endsWith(".md")) {
    throw new Error("Memory record path must point to a Markdown file");
  }

  const realRoot = await realpath(rootPath);
  const realTarget = await realpath(syntacticPath);
  if (!isPathInside(realRoot, realTarget)) {
    throw new Error("Memory record path must stay inside the memory repo");
  }
  if (!repoRelative(realRoot, realTarget).endsWith(".md")) {
    throw new Error("Memory record path must point to a Markdown file");
  }
  return { root: realRoot, absolutePath: realTarget };
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function memoryLockPath(root: string): string {
  return join(root, ".git", LOCK_DIR_NAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
