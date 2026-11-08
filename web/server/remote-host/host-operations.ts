import {
  auxiliaryWorktreeKeepReason,
  canonicalWorktreePath,
  inspectAuxiliaryWorktree,
  removeAuxiliaryWorktree,
  verifyCleanupBaseBranch,
} from "../auxiliary-worktrees.js";
import { prepareWorktreeSessionArtifacts } from "../cli-launcher-worktree.js";
import { GIT_WORKTREE_ADD_TIMEOUT } from "../constants.js";
import { listDirectories, listFolderEntries } from "../directory-listing.js";
import { deliverMcpOAuthCallback } from "../mcp-oauth-callback.js";
import { readCommitDetails, readRangeFileDiff } from "../git-commit-reader.js";
import { ensureWorktreeAsync, getRepoInfoAsync, listBranchesAsync } from "../git-utils.js";
import { startLandingRunner } from "../landing-runner-launcher.js";
import { syncBaseCheckoutToRemote } from "../landing-target-sync.js";
import { recreateSessionCheckout } from "../migration.js";
import { resolveBinary } from "../path-resolver.js";
import { verifyReview } from "../port-tracking.js";
import { verifyPublishedDeliveryTarget } from "../published-delivery-target.js";
import { buildCodeDelivery, runPortCommand } from "../quest-code-deliveries.js";
import { readDeliveryRange, resolveDeliveryRange } from "../quest-delivery-range.js";
import { assessWorktreeCleanupSafety, removeWorktreeCheckout } from "../routes/worktree-cleanup.js";
import { collectUserLevelContent, summarizeUserLevelContent } from "../user-content.js";
import { defaultMachineRoots, installUserContent, retireUserSkills } from "../user-content-install.js";
import { verifyReplacementWorkEvidence } from "../work-evidence-replacement.js";
import { prepareTrackCheckout, pullTrackCheckout, readTrackStatus, removeTrackCheckout } from "../work-tracks.js";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { requestOnHost } from "./session-machine.js";

/**
 * Operations a session's machine performs on its own repos and files. For a
 * session on this machine they run here; for a session on a remote host the
 * coordinator asks that host's `takode node` to run the same code there.
 * Arguments and results must survive JSON.
 */
const operations = {
  listDirectories: (path: string | undefined, showHidden: boolean) => listDirectories(path, showHidden),
  // A folder's files and subfolders, for Takode's file viewer.
  listFolderEntries: (path: string, showHidden: boolean) => listFolderEntries(path, showHidden),
  // A path with its symlinks resolved, so an opened HTML page cannot reach files outside its folder.
  realPath: (path: string) => realpath(path),
  // For each program, whether this machine can find it (the New Session backend picker).
  findPrograms: (programs: string[]) => programs.map((program) => resolveBinary(program) !== null),
  repoInfo: (cwd: string) => getRepoInfoAsync(cwd),
  listBranches: (repoRoot: string, options: Parameters<typeof listBranchesAsync>[1]) =>
    listBranchesAsync(repoRoot, options),
  ensureWorktree: (repoRoot: string, branch: string, options: Parameters<typeof ensureWorktreeAsync>[2]) =>
    ensureWorktreeAsync(repoRoot, branch, options),
  prepareWorktreeArtifacts: (options: Parameters<typeof prepareWorktreeSessionArtifacts>[0]) =>
    prepareWorktreeSessionArtifacts(options),
  worktreeCleanupSafety: (target: Parameters<typeof assessWorktreeCleanupSafety>[0]) =>
    assessWorktreeCleanupSafety(target),
  removeWorktreeCheckout: (...args: Parameters<typeof removeWorktreeCheckout>) => removeWorktreeCheckout(...args),
  // Auxiliary checkouts a session registered (`takode worktree register`): their checks and removal.
  inspectAuxiliaryWorktree: (path: string) => inspectAuxiliaryWorktree(path),
  canonicalWorktreePath: (path: string) => canonicalWorktreePath(path),
  verifyCleanupBaseBranch: (repoRoot: string, branch: string) => verifyCleanupBaseBranch(repoRoot, branch),
  auxiliaryWorktreeKeepReason: (...args: Parameters<typeof auxiliaryWorktreeKeepReason>) =>
    auxiliaryWorktreeKeepReason(...args),
  removeAuxiliaryWorktree: (repoRoot: string, worktreePath: string) => removeAuxiliaryWorktree(repoRoot, worktreePath),
  // Tracks (`takode track`): the checkout of a track's integration branch on its machine.
  prepareTrackCheckout: (input: Parameters<typeof prepareTrackCheckout>[0]) => prepareTrackCheckout(input),
  readTrackStatus: (input: Parameters<typeof readTrackStatus>[0]) => readTrackStatus(input),
  pullTrackCheckout: (input: Parameters<typeof pullTrackCheckout>[0]) => pullTrackCheckout(input),
  removeTrackCheckout: (input: Parameters<typeof removeTrackCheckout>[0]) => removeTrackCheckout(input),
  recreateSessionCheckout: (input: Parameters<typeof recreateSessionCheckout>[0]) => recreateSessionCheckout(input),
  // Delivery evidence: Git checks and reads of the checkout a Work delivery names.
  verifyPublishedDeliveryTarget: (...args: Parameters<typeof verifyPublishedDeliveryTarget>) =>
    verifyPublishedDeliveryTarget(...args),
  verifyWorkEvidence: (...args: Parameters<typeof verifyReplacementWorkEvidence>) =>
    verifyReplacementWorkEvidence(...args),
  buildCodeDelivery: (input: Parameters<typeof buildCodeDelivery>[0]) => buildCodeDelivery(input),
  portCommand: (...args: Parameters<typeof runPortCommand>) => runPortCommand(...args),
  verifyReview: (...args: Parameters<typeof verifyReview>) => verifyReview(...args),
  readCommitDetails: (...args: Parameters<typeof readCommitDetails>) => readCommitDetails(...args),
  // A guided review's file over its range, whole-file context, for the code around a stop.
  readRangeFileDiff: (...args: Parameters<typeof readRangeFileDiff>) => readRangeFileDiff(...args),
  resolveDeliveryRange: (...args: Parameters<typeof resolveDeliveryRange>) => resolveDeliveryRange(...args),
  readDeliveryRange: (...args: Parameters<typeof readDeliveryRange>) => readDeliveryRange(...args),
  // The landing queue starts runners on the host of a waiting change (the coordinator's own machine starts them in-process).
  startLandingRunner: (input: Parameters<typeof startLandingRunner>[0]) =>
    startLandingRunner(input, { forRemoteCoordinator: true }),
  syncBaseCheckoutToRemote: (input: Parameters<typeof syncBaseCheckoutToRemote>[0]) => syncBaseCheckoutToRemote(input),
  // User content from the coordinator's store, delivered to this machine's standard Claude and Codex places.
  installUserContent: (request: Parameters<typeof installUserContent>[0]) => installUserContent(request),
  // The one-time import: this machine's user-level instructions and skills, read for the coordinator's store.
  collectUserContent: (takodeSkills: string[]) =>
    collectUserLevelContent(takodeSkills, defaultMachineRoots().installRoot + sep),
  // Moves the user's own skill entries named by an agent (with the user's approval) into a backup folder.
  retireUserSkills: (request: Parameters<typeof retireUserSkills>[0]) => retireUserSkills(request),
  // Opens an MCP sign-in callback on the loopback address where this machine's Codex session listens.
  deliverMcpOAuthCallback: (callbackUrl: string) => deliverMcpOAuthCallback(callbackUrl),
  // What that import would bring in, without the contents, for choosing the machine to import from.
  summarizeUserContent: (takodeSkills: string[]) =>
    summarizeUserLevelContent(takodeSkills, defaultMachineRoots().installRoot + sep),
};

export type HostOperations = typeof operations;
export type HostOperationName = keyof HostOperations;

/** Git and worktree operations can take a while on a large repo. */
const OPERATION_TIMEOUT_MS = 120_000;
/** Operations that create a checkout wait for its longer limit, plus time for their other Git steps. */
const CHECKOUT_OPERATION_TIMEOUT_MS = GIT_WORKTREE_ADD_TIMEOUT + OPERATION_TIMEOUT_MS;
const CHECKOUT_OPERATIONS: ReadonlySet<HostOperationName> = new Set([
  "ensureWorktree",
  "prepareTrackCheckout",
  "recreateSessionCheckout",
]);

/** Run an operation on the session's machine: the remote host `hostId`, or this one when absent. */
export async function onMachine<K extends HostOperationName>(
  hostId: string | null | undefined,
  name: K,
  ...args: Parameters<HostOperations[K]>
): Promise<Awaited<ReturnType<HostOperations[K]>>> {
  type Result = Awaited<ReturnType<HostOperations[K]>>;
  if (!hostId) {
    const run = operations[name] as unknown as (...input: Parameters<HostOperations[K]>) => Promise<Result>;
    return run(...args);
  }
  const timeoutMs = CHECKOUT_OPERATIONS.has(name) ? CHECKOUT_OPERATION_TIMEOUT_MS : OPERATION_TIMEOUT_MS;
  const response = await requestOnHost(hostId, { kind: "operation", name, args }, timeoutMs);
  return response.result as Result;
}

/** Host side: run an operation the coordinator asked for. */
export async function performHostOperation(name: string, args: unknown[]): Promise<unknown> {
  if (!Object.hasOwn(operations, name)) throw new Error(`Unknown host operation: ${name}`);
  const run = operations[name as HostOperationName] as (...input: unknown[]) => Promise<unknown>;
  // JSON has no `undefined`; normalize so both sides see the same result.
  return (await run(...args)) ?? null;
}
