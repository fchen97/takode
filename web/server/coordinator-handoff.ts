import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  coordinatorLockPath,
  coordinatorMovePath,
  raiseCoordinatorEpoch,
  readCoordinatorEpoch,
  readCoordinatorMove,
  writeCoordinatorMove,
} from "./coordinator-lock.js";
import { machineNameError, readMachineName } from "./machine-identity.js";
import {
  mergeCarriedOverTokenUsage,
  parseCarriedOverTokenUsage,
  pickCarriedOverTokenUsageState,
  TOKEN_USAGE_CARRYOVER_FILE,
  type CarriedOverTokenUsageSession,
} from "./workspace-token-usage-carryover.js";
import { MEMORY_MACHINE_STAMPS_MARKER, QUEST_MACHINE_STAMPS_MARKER, SESSION_NUMBERS_FILE } from "./constants.js";

/**
 * Hand a coordinator (one Takode server identity) from this machine to
 * another one that already runs sessions for it as a registered host.
 *
 * `exportCoordinatorHandoff` runs on the departing machine with its server
 * stopped. It packages the coordinator's state with a SHA-256 for every file,
 * relabels sessions to the machine they run on (this machine's sessions get a
 * new host entry named after it, the receiving host's sessions become the
 * coordinator's own), and fences this machine: a server with the same
 * identity then refuses to start here (see `coordinator-lock.ts`).
 * `importCoordinatorHandoff` runs on the receiving machine, verifies every
 * checksum before writing, and moves aside anything it would replace.
 *
 * Only unarchived sessions move; archived history stays in the departing
 * machine's files, and only its token usage comes along (see
 * `workspace-token-usage-carryover.ts`). Machine-local state stays too: logs,
 * leases, worktree checkouts and auxiliary worktree registrations, agent
 * artifacts.
 */

export interface HandoffExportOptions {
  /** Home directory holding `.companion` on this machine. */
  home?: string;
  /** Port of the server being handed off; its settings and sessions are per port. */
  port?: number;
  /** Empty or missing directory to write the package to. */
  packageDir: string;
  /** Name of the machine taking over, usually a host registered with this coordinator. */
  toMachine: string;
  /** Where the coordinator is opened after the handoff; the fence points users there. */
  toAddress: string;
  /**
   * Package a copy for a trial run without stopping or fencing this server.
   * The copy then cannot launch agents (its machines' Claude and Codex
   * settings point nowhere) or alert a phone, so copied
   * timers and herd events cannot resume real sessions next to the live ones.
   */
  rehearsal?: boolean;
  now?: Date;
}

export interface HandoffImportOptions {
  /** Home directory holding `.companion` on this machine. */
  home?: string;
  /** Port the coordinator will listen on here; defaults to the departing server's port. */
  port?: number;
  packageDir: string;
  /** Move existing files the package replaces into a backup folder instead of refusing. */
  replaceExisting?: boolean;
  /** Verify the package and report what would change, without writing. */
  checkOnly?: boolean;
  now?: Date;
}

export interface HandoffManifest {
  kind: "takode-coordinator-handoff";
  version: 1;
  createdAt: string;
  rehearsal: boolean;
  serverId: string;
  serverSlug: string;
  port: number;
  /** Home of the departing machine; paths below it in memory repo configs are rebased on import. */
  sourceHome: string;
  fromMachine: string;
  toMachine: string;
  toAddress: string;
  /** Host id the departing machine gets on the coordinator. */
  fromHostId: string;
  /** Latest coordinator epoch on the departing machine; the next start must exceed it. */
  epoch: number;
  /**
   * Paths (relative to `.companion`) the import owns entirely: each replaces
   * whatever is there, so stale data from an earlier server never mixes in.
   */
  roots: string[];
  files: HandoffFile[];
  summary: HandoffSummary;
}

export type HandoffFile = { path: string; bytes: number; sha256: string } | { path: string; symlink: string };

export interface HandoffSummary {
  sessions: { moved: number; toFromHost: number; toCoordinator: number; onOtherHosts: number; archivedLeft: number };
  nextSessionNumber: number;
  timers: number;
  memoryRepos: Array<{ name: string; head: string | null; remote: string | null }>;
  /** Things to check by hand after the import. */
  notes: string[];
  files: number;
  bytes: number;
}

export interface HandoffExportResult {
  manifest: HandoffManifest;
  /** Token file for the departing machine's `takode node`; absent for a rehearsal. */
  nodeTokenFile?: string;
}

export interface HandoffImportResult {
  manifest: HandoffManifest;
  applied: boolean;
  /** Existing paths the import replaced (or would replace), relative to `.companion`. */
  replaced: string[];
  backupDir?: string;
}

const MANIFEST_FILE = "manifest.json";
const FILES_DIR = "files";
/** Claude and Codex setting of a rehearsal copy: a program that does not exist, so no agent starts. */
export const REHEARSAL_DISABLED_BINARY = "/nonexistent/takode-rehearsal-copy-runs-no-agents";
const LOCK_SUFFIX = ".lock";
const execFileAsync = promisify(execFile);

export async function exportCoordinatorHandoff(options: HandoffExportOptions): Promise<HandoffExportResult> {
  const home = options.home ?? homedir();
  const port = options.port ?? 3456;
  const now = options.now ?? new Date();
  const rehearsal = options.rehearsal === true;
  const companion = join(home, ".companion");

  const settingsFile = `settings-${port}.json`;
  const settings = await readJson(join(companion, settingsFile));
  const serverId = requireString(settings.serverId, `${settingsFile} has no serverId`);
  const serverSlug = requireString(settings.serverSlug, `${settingsFile} has no serverSlug`);
  const fromMachine = await readMachineName(home);
  if (!fromMachine) throw new Error("This machine has no name yet; start Takode on it once first.");
  if (fromMachine === options.toMachine) throw new Error(`The coordinator already runs on ${fromMachine}.`);
  if (!rehearsal) {
    await assertStopped(companion, serverId);
    await assertNoLandingRun(companion, serverId);
  }
  const memoryRepos = await describeMemoryRepos(companion, serverSlug);
  const stampNotes = await checkMachineStamps(companion, serverSlug, memoryRepos, {
    fromMachine,
    toMachine: options.toMachine,
    rehearsal,
  });

  const plan = await planHandoff({
    companion,
    port,
    settings,
    serverId,
    fromMachine,
    toMachine: options.toMachine,
    rehearsal,
    now,
  });
  const epoch = await readCoordinatorEpoch(coordinatorLockPath(serverId, home));

  await assertEmptyDir(options.packageDir);
  const files: HandoffFile[] = [];
  for (const entry of plan.entries) {
    const target = join(options.packageDir, FILES_DIR, entry.path);
    files.push(
      entry.content !== undefined
        ? await writePackaged(entry.path, target, entry.content)
        : await copyVerified(entry.path, join(companion, entry.path), target),
    );
  }
  const bytes = files.reduce((sum, file) => sum + ("bytes" in file ? file.bytes : 0), 0);
  const manifest: HandoffManifest = {
    kind: "takode-coordinator-handoff",
    version: 1,
    createdAt: now.toISOString(),
    rehearsal,
    serverId,
    serverSlug,
    port,
    sourceHome: home,
    fromMachine,
    toMachine: options.toMachine,
    toAddress: options.toAddress,
    fromHostId: plan.fromHostId,
    epoch,
    roots: plan.roots,
    files,
    summary: {
      ...plan.summary,
      memoryRepos,
      notes: [...stampNotes, ...plan.summary.notes],
      files: files.length,
      bytes,
    },
  };
  await writeFile(join(options.packageDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  if (rehearsal) return { manifest };

  // Fence last: the package is complete, and from now on only the new machine may change this state.
  const nodeTokenFile = join(companion, "hosts", `${serverId}-node.token`);
  await mkdir(dirname(nodeTokenFile), { recursive: true });
  await writeFile(nodeTokenFile, plan.fromHostToken, { encoding: "utf-8", mode: 0o600 });
  await writeCoordinatorMove(coordinatorMovePath(serverId, home), {
    machine: options.toMachine,
    address: options.toAddress,
    movedAt: now.getTime(),
  });
  return { manifest, nodeTokenFile };
}

export async function importCoordinatorHandoff(options: HandoffImportOptions): Promise<HandoffImportResult> {
  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  const companion = join(home, ".companion");
  const manifest = await readManifest(options.packageDir);
  const port = options.port ?? manifest.port;
  const machine = await readMachineName(home);
  if (machine !== manifest.toMachine) {
    throw new Error(
      `This package hands the coordinator to ${manifest.toMachine}, but this machine is ${machine ?? "unnamed"}.`,
    );
  }
  const targetPath = (path: string) => join(companion, retargetPort(path, manifest.port, port));

  const mismatched: string[] = [];
  for (const file of manifest.files) {
    if (!("sha256" in file)) continue;
    const actual = await readFile(join(options.packageDir, FILES_DIR, file.path)).then(sha256, () => "missing");
    if (actual !== file.sha256) mismatched.push(file.path);
  }
  if (mismatched.length > 0) {
    throw new Error(`The package is damaged; these files do not match their checksums:\n${mismatched.join("\n")}`);
  }
  await assertStopped(companion, manifest.serverId);

  const replaced: string[] = [];
  for (const root of manifest.roots) {
    if (await exists(targetPath(root))) replaced.push(retargetPort(root, manifest.port, port));
  }
  if (options.checkOnly) return { manifest, applied: false, replaced };
  if (replaced.length > 0 && !options.replaceExisting) {
    throw new Error(
      `These paths already exist here; rerun with --replace-existing to move them into a backup folder:\n${replaced.join("\n")}`,
    );
  }

  let backupDir: string | undefined;
  if (replaced.length > 0) {
    backupDir = join(companion, "coordinator-handoff-backups", now.toISOString().replace(/[:.]/g, "-"));
    for (const path of replaced) {
      await mkdir(dirname(join(backupDir, path)), { recursive: true });
      await rename(join(companion, path), join(backupDir, path));
    }
  }
  for (const file of manifest.files) {
    const target = targetPath(file.path);
    await mkdir(dirname(target), { recursive: true });
    if ("symlink" in file) await symlink(file.symlink, target);
    else await copyFile(join(options.packageDir, FILES_DIR, file.path), target);
  }
  await rebaseMemoryRepoConfigs(companion, manifest, home);
  // Hosts that followed the coordinator here refuse an epoch they have already passed.
  await raiseCoordinatorEpoch(coordinatorLockPath(manifest.serverId, home), manifest.epoch);
  return { manifest, applied: true, replaced, ...(backupDir ? { backupDir } : {}) };
}

// ─── Planning ────────────────────────────────────────────────────────────────

interface PlanEntry {
  /** Path relative to `.companion`. */
  path: string;
  /** Rewritten content; absent to copy the file as it is. */
  content?: string;
}

interface HandoffPlan {
  entries: PlanEntry[];
  roots: string[];
  fromHostId: string;
  fromHostToken: string;
  summary: Pick<HandoffSummary, "sessions" | "nextSessionNumber" | "timers" | "notes">;
}

type JsonRecord = Record<string, unknown>;

async function planHandoff(input: {
  companion: string;
  port: number;
  settings: JsonRecord;
  serverId: string;
  fromMachine: string;
  toMachine: string;
  rehearsal: boolean;
  now: Date;
}): Promise<HandoffPlan> {
  const { companion, port, settings, serverId, fromMachine, toMachine, rehearsal, now } = input;
  const entries: PlanEntry[] = [];
  const roots: string[] = [];
  const own = (path: string) => roots.push(path);
  /** Copy a file or a whole directory that the import then owns. */
  const copyRoot = async (path: string) => {
    if (!(await exists(join(companion, path)))) return;
    own(path);
    for (const file of await listFiles(companion, path)) entries.push({ path: file });
  };
  /** Copy files without owning their folder. */
  const copyMerged = async (path: string) => {
    if (!(await exists(join(companion, path)))) return;
    for (const file of await listFiles(companion, path)) entries.push({ path: file });
  };
  const writeRoot = (path: string, value: unknown) => {
    own(path);
    entries.push({ path, content: JSON.stringify(value, null, 2) });
  };

  // Hosts: this machine becomes a host; the receiving host becomes the coordinator's own machine.
  const registry = (await readJsonIfExists<JsonRecord>(join(companion, "hosts", `${serverId}.json`))) ?? {};
  const hosts = Array.isArray(registry.hosts) ? (registry.hosts as JsonRecord[]) : [];
  const toHost = hosts.find((host) => host.name === toMachine);
  const toHostId = typeof toHost?.id === "string" ? toHost.id : undefined;
  const nameProblem = machineNameError(fromMachine);
  if (nameProblem) throw new Error(nameProblem);
  if (hosts.some((host) => host !== toHost && host.name === fromMachine)) {
    throw new Error(`A registered host is already named ${fromMachine}; rename it before the handoff.`);
  }
  const fromHostId = randomUUID();
  const fromHostToken = randomBytes(32).toString("base64url");
  const local = isRecord(registry.local) ? registry.local : {};
  writeRoot(`hosts/${serverId}.json`, {
    hosts: [
      ...hosts.filter((host) => host !== toHost),
      {
        id: fromHostId,
        name: fromMachine,
        createdAt: now.getTime(),
        tokenSha256: sha256(fromHostToken),
        ...(isRecord(local.settings) ? { settings: local.settings } : {}),
      },
    ],
    local: {
      settings: rehearsal
        ? { claudeBinary: REHEARSAL_DISABLED_BINARY, codexBinary: REHEARSAL_DISABLED_BINARY }
        : isRecord(toHost?.settings)
          ? toHost.settings
          : { claudeBinary: "", codexBinary: "" },
    },
  });
  const notes: string[] = [];
  const toSettings = isRecord(toHost?.settings) ? toHost.settings : {};
  if (!rehearsal && (!toSettings.claudeBinary || !toSettings.codexBinary)) {
    notes.push(
      `${toMachine} has no stored Claude Code or Codex program (a node flag may have set them), so the coordinator ` +
        `would run the ones on its PATH: check This machine in Settings > Hosts after the import.`,
    );
  }
  const relabel = (hostId: unknown): string | undefined =>
    typeof hostId !== "string" || !hostId ? fromHostId : hostId === toHostId ? undefined : hostId;

  // Settings keep the server's identity. A rehearsal copy alerts no phone and calls no paid API.
  const settingsFile = `settings-${port}.json`;
  if (rehearsal) {
    writeRoot(settingsFile, { ...settings, pushoverEnabled: false, pushoverUserKey: "", pushoverApiToken: "" });
  } else {
    writeRoot(settingsFile, settings);
    await copyRoot(`settings-secrets-${port}.json`);
    await copyRoot(`web-push/${serverId}.json`);
  }
  const sharedState = [
    "questmaster",
    "questmaster-live",
    "quest-evidence",
    "todos",
    "cron",
    "streams",
    "envs",
    "bundles",
    "user-instructions",
    "user-skills",
  ];
  for (const path of sharedState) {
    await copyRoot(path);
  }
  await copyRoot(`memory/${settings.serverSlug as string}`);
  for (const path of [
    `browser-login/${serverId}.json`,
    `landing-gates/${serverId}.json`,
    `landing-queue/${serverId}.json`,
    `tree-groups/${serverId}.json`,
    `new-session-defaults/${serverId}.json`,
    "session-names.json",
  ]) {
    await copyRoot(path);
  }
  await copyMerged("image-variants");

  // Sessions: unarchived ones only, relabeled to the machine they run on.
  const sessionsDir = `sessions/${port}`;
  own(sessionsDir);
  const launcher = (await readJsonIfExists<JsonRecord[]>(join(companion, sessionsDir, "launcher.json"))) ?? [];
  const moving = launcher.filter((info) => info.archived !== true && typeof info.sessionId === "string");
  const movingIds = new Set(moving.map((info) => info.sessionId as string));
  const sessions = { moved: moving.length, toFromHost: 0, toCoordinator: 0, onOtherHosts: 0 };
  for (const info of moving) {
    const hostId = relabel(info.hostId);
    if (hostId === fromHostId) sessions.toFromHost++;
    else if (hostId === undefined) sessions.toCoordinator++;
    else sessions.onOtherHosts++;
    setOrDelete(info, "hostId", hostId);
    const portTarget = info.worktreePortTarget;
    if (isRecord(portTarget)) setOrDelete(portTarget, "hostId", relabel(portTarget.hostId));
    // Every process ends with the handoff; each session resumes on its next message.
    for (const key of ["pid", "hostProcId", "hostClaudeRequests", "hostCodexRequests"]) delete info[key];
    info.state = "exited";
  }
  entries.push({ path: `${sessionsDir}/launcher.json`, content: JSON.stringify(moving, null, 2) });
  // Archived sessions stay behind, so record where numbering continues.
  let nextSessionNumber = 0;
  for (const info of launcher) {
    if (Number.isInteger(info.sessionNum))
      nextSessionNumber = Math.max(nextSessionNumber, (info.sessionNum as number) + 1);
  }
  entries.push({
    path: `${sessionsDir}/${SESSION_NUMBERS_FILE}`,
    content: JSON.stringify({ next: nextSessionNumber }),
  });
  for (const name of await readdir(join(companion, sessionsDir))) {
    const sessionId = name.slice(0, 36);
    if (!movingIds.has(sessionId) || name[36] !== "." || name.endsWith(".tmp")) continue;
    const path = `${sessionsDir}/${name}`;
    if (name !== `${sessionId}.json`) {
      entries.push({ path });
      continue;
    }
    const hot = await readJson(join(companion, path));
    if (isRecord(hot.state)) setOrDelete(hot.state, "host_id", relabel(hot.state.host_id));
    entries.push({ path, content: JSON.stringify(hot) });
  }
  // Archived sessions stay behind, but their token usage counts toward the workspace totals.
  const carryoverPath = `${sessionsDir}/${TOKEN_USAGE_CARRYOVER_FILE}`;
  const leftBehind: CarriedOverTokenUsageSession[] = [];
  for (const info of launcher) {
    const sessionId = info.sessionId;
    if (typeof sessionId !== "string" || movingIds.has(sessionId)) continue;
    // An unreadable session file only loses that session's usage; it must not stop the move.
    const hot = await readJsonIfExists<JsonRecord>(join(companion, sessionsDir, `${sessionId}.json`)).catch(() => null);
    const state = pickCarriedOverTokenUsageState(hot?.state, now.getTime());
    if (!state) continue;
    const sessionNum = Number.isInteger(info.sessionNum) ? { sessionNum: info.sessionNum as number } : {};
    leftBehind.push({ sessionId, ...sessionNum, state });
  }
  const previousCarryover = await readJsonIfExists<unknown>(join(companion, carryoverPath)).catch(() => {
    notes.push(`${carryoverPath} is unreadable, so token usage carried over by earlier moves is left out.`);
    return null;
  });
  const carriedOver = mergeCarriedOverTokenUsage(parseCarriedOverTokenUsage(previousCarryover), leftBehind);
  if (carriedOver.sessions.length > 0) entries.push({ path: carryoverPath, content: JSON.stringify(carriedOver) });
  const acknowledgements = `${sessionsDir}/model-provenance-migration-acknowledgements.json`;
  if (await exists(join(companion, acknowledgements))) entries.push({ path: acknowledgements });

  // Per-session state outside the sessions folder.
  own("timers");
  let timers = 0;
  for (const sessionId of movingIds) {
    const timerFile = `timers/${sessionId}.json`;
    if (!(await exists(join(companion, timerFile)))) continue;
    entries.push({ path: timerFile });
    timers++;
  }
  // Attachments and preview variants merge with what the receiving machine has: as a host it
  // keeps its own copies of its sessions' attachments under the same names.
  for (const sessionId of movingIds) await copyMerged(`images/${sessionId}`);
  const worktrees = (await readJsonIfExists<JsonRecord[]>(join(companion, "worktrees.json"))) ?? [];
  writeRoot(
    "worktrees.json",
    worktrees
      .filter((record) => movingIds.has(record.sessionId as string))
      .map((record) => setOrDelete({ ...record }, "hostId", relabel(record.hostId))),
  );

  return {
    entries,
    roots,
    fromHostId,
    fromHostToken,
    summary: {
      sessions: { ...sessions, archivedLeft: launcher.length - moving.length },
      nextSessionNumber,
      timers,
      notes,
    },
  };
}

// ─── Safety checks ───────────────────────────────────────────────────────────

/**
 * Quest and memory notes written before machine stamps existed get stamped
 * once by the server, with its own machine's name: where they were written
 * as long as the coordinator never moved. That must happen here, before the
 * move; the receiving machine would stamp them with its own name.
 */
async function checkMachineStamps(
  companion: string,
  serverSlug: string,
  memoryRepos: HandoffSummary["memoryRepos"],
  machines: { fromMachine: string; toMachine: string; rehearsal: boolean },
): Promise<string[]> {
  const unstamped: string[] = [];
  if (!(await exists(join(companion, "questmaster-live", QUEST_MACHINE_STAMPS_MARKER)))) unstamped.push("quests");
  for (const repo of memoryRepos) {
    const marker = join(companion, "memory", serverSlug, repo.name, ".git", MEMORY_MACHINE_STAMPS_MARKER);
    if (repo.head && !(await exists(marker))) unstamped.push(`memory ${repo.name}`);
  }
  if (unstamped.length === 0) return [];
  const found = `Older notes are not stamped with ${machines.fromMachine}'s name yet (${unstamped.join(", ")}).`;
  if (machines.rehearsal) return [`${found} The copy stamps them with ${machines.toMachine}'s name.`];
  throw new Error(
    `${found} Start the Takode server here once on this build, which stamps them, stop it, and export again.`,
  );
}

/** Refuse while this machine runs the coordinator or its own node, whose state would keep changing. */
async function assertStopped(companion: string, serverId: string): Promise<void> {
  const lock = await readJsonIfExists<JsonRecord>(join(companion, "coordinator", `${serverId}.json`));
  if (lock && typeof lock.pid === "number" && lock.hostname === hostname() && isAlive(lock.pid)) {
    throw new Error(`The Takode server for ${serverId} runs here (pid ${lock.pid}); stop it first.`);
  }
  const nodePid = Number(
    (await readFile(join(companion, "hosts", `${serverId}-local-node.pid`), "utf-8").catch(() => "")).trim(),
  );
  if (Number.isInteger(nodePid) && nodePid > 0 && isAlive(nodePid)) {
    throw new Error(
      `This machine's own takode node still runs (pid ${nodePid}); stop the server normally, which ends it.`,
    );
  }
  if (await readCoordinatorMove(join(companion, "coordinator", `${serverId}.moved.json`))) {
    throw new Error(
      `This coordinator was already handed off from this machine; see coordinator/${serverId}.moved.json.`,
    );
  }
}

/** A landing run works in a checkout on this machine, so it must finish here first; pending entries move. */
async function assertNoLandingRun(companion: string, serverId: string): Promise<void> {
  const queue = await readJsonIfExists<{ entries?: JsonRecord[]; runs?: JsonRecord[] }>(
    join(companion, "landing-queue", `${serverId}.json`),
  );
  const running = [...(queue?.entries ?? []), ...(queue?.runs ?? [])].some((item) => item.state === "running");
  if (running) throw new Error("A landing run is in progress; let it finish, then stop the server and export again.");
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertEmptyDir(path: string): Promise<void> {
  const names = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (names.length > 0) throw new Error(`The package folder ${path} is not empty.`);
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** Files below `path` (relative to `root`), or `path` itself; locks (files or folders) are left behind. */
async function listFiles(root: string, path: string): Promise<string[]> {
  if (path.endsWith(LOCK_SUFFIX)) return [];
  const info = await lstat(join(root, path));
  if (!info.isDirectory()) return [path];
  const files: string[] = [];
  for (const name of (await readdir(join(root, path))).sort()) {
    files.push(...(await listFiles(root, `${path}/${name}`)));
  }
  return files;
}

/** Copy one file into the package and check that the source still matches what was copied. */
async function copyVerified(path: string, source: string, target: string): Promise<HandoffFile> {
  await mkdir(dirname(target), { recursive: true });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const link = await readlink(source);
    await symlink(link, target);
    return { path, symlink: link };
  }
  // Whole-file reads: a stream-based copy of the live store once stalled for good under Bun.
  const content = await readFile(source);
  await writeFile(target, content);
  const digest = sha256(content);
  if (sha256(await readFile(source)) !== digest) {
    throw new Error(`${source} changed while it was copied; stop the server and export again.`);
  }
  return { path, bytes: content.length, sha256: digest };
}

async function writePackaged(path: string, target: string, content: string): Promise<HandoffFile> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return { path, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Map a package path written for one port to the port the coordinator uses here. */
function retargetPort(path: string, from: number, to: number): string {
  if (from === to) return path;
  return path
    .replace(new RegExp(`^settings-${from}\\.json$`), `settings-${to}.json`)
    .replace(new RegExp(`^settings-secrets-${from}\\.json$`), `settings-secrets-${to}.json`)
    .replace(new RegExp(`^sessions/${from}(/|$)`), `sessions/${to}$1`);
}

// ─── Memory repos ────────────────────────────────────────────────────────────

async function describeMemoryRepos(companion: string, serverSlug: string): Promise<HandoffSummary["memoryRepos"]> {
  const base = join(companion, "memory", serverSlug);
  const names = await readdir(base).catch(() => [] as string[]);
  const repos: HandoffSummary["memoryRepos"] = [];
  for (const name of names.sort()) {
    if (!(await exists(join(base, name, ".git")))) continue;
    repos.push({
      name,
      head: await git(join(base, name), ["rev-parse", "HEAD"]),
      remote: await git(join(base, name), ["remote", "get-url", "origin"]),
    });
  }
  return repos;
}

/** Repo configs name helpers by absolute path (credential helpers); point those at this machine's home. */
async function rebaseMemoryRepoConfigs(companion: string, manifest: HandoffManifest, home: string): Promise<void> {
  if (manifest.sourceHome === home) return;
  const from = `${join(manifest.sourceHome, ".companion")}/`;
  const to = `${companion}/`;
  for (const repo of manifest.summary.memoryRepos) {
    const config = join(companion, "memory", manifest.serverSlug, repo.name, ".git", "config");
    const text = await readFile(config, "utf-8").catch(() => null);
    if (text?.includes(from)) await writeFile(config, text.split(from).join(to));
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync("git", ["--no-optional-locks", ...args], { cwd })).stdout.trim() || null;
  } catch {
    return null;
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

async function readManifest(packageDir: string): Promise<HandoffManifest> {
  const manifest = (await readJson(join(packageDir, MANIFEST_FILE))) as unknown as HandoffManifest;
  if (manifest.kind !== "takode-coordinator-handoff" || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`${join(packageDir, MANIFEST_FILE)} is not a coordinator handoff package.`);
  }
  return manifest;
}

async function readJson(path: string): Promise<JsonRecord> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} does not hold a JSON object.`);
  return parsed;
}

/** A JSON file's content, or null when the file does not exist. */
async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function setOrDelete<T extends JsonRecord>(record: T, key: string, value: string | undefined): T {
  if (value === undefined) delete record[key];
  else (record as JsonRecord)[key] = value;
  return record;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}
