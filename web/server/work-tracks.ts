import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { GIT_WORKTREE_ADD_TIMEOUT } from "./constants.js";
import { gitAsync, gitSafeAsync, listWorktreesAsync } from "./git-utils.js";

/**
 * A track: a named line of work a leader declares in a repository, with an
 * integration branch that workers start from and land into, and the branch it
 * follows (usually the repository's default branch). Takode keeps one checkout
 * of the integration branch, which workers on the track use as their port
 * target, so their ordinary port, landing and delivery tooling lands there.
 */
export interface WorkTrack {
  name: string;
  /** The repository's main checkout on the track's machine. */
  repoRoot: string;
  branch: string;
  /** The branch the track is kept current with by merging it in. */
  follows: string;
  /** The checkout of `branch` that workers port into. */
  checkoutPath: string;
  /** Takode made the checkout (closing removes it when clean); otherwise it adopted an existing one. */
  createdCheckout: boolean;
  /** Remote host the checkout is on; absent for the coordinator's machine. */
  hostId?: string;
  /** The leader that declared it, the only one that may close it. */
  ownerSessionId: string;
  createdAt: number;
  closedAt?: number;
}

/** Where a track stands against the branch it follows, read on its machine. */
export interface WorkTrackStatus {
  /** Commits on the followed branch the track lacks; null when unknown. */
  behind: number | null;
  /** When the track branch last got a commit (ms). */
  lastCommitAt: number | null;
  /** Why the remote could not be read, when it could not: counts then use what this machine last fetched. */
  fetchError?: string;
}

/** Track names are short words, since they are typed in every `takode spawn --track`. */
export const TRACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/** Host side: find or make the checkout of a track's branch. */
export async function prepareTrackCheckout(input: {
  repoRoot: string;
  name: string;
  branch: string;
  follows: string;
  /** Start the branch from the followed branch when it exists neither locally nor on origin. */
  create?: boolean;
  /** Folder for the checkouts Takode makes; `~/.companion/tracks` on the track's machine by default. */
  tracksRoot?: string;
}): Promise<{ checkoutPath: string; createdCheckout: boolean }> {
  const { repoRoot, name, branch, follows } = input;
  await gitAsync(`check-ref-format --branch ${quote(branch)}`, repoRoot);
  await gitSafeAsync("fetch --quiet origin", repoRoot);
  // A checkout already on the branch is the track's checkout: two checkouts of one branch are impossible.
  const existing = (await listWorktreesAsync(repoRoot)).find((worktree) => worktree.branch === branch);
  if (existing) return { checkoutPath: existing.path, createdCheckout: false };

  const tracksRoot = input.tracksRoot ?? join(homedir(), ".companion", "tracks");
  const checkoutPath = join(tracksRoot, basename(repoRoot), name);
  if (
    await access(checkoutPath).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`${checkoutPath} already exists; remove it or choose another track name`);
  }
  const addCheckout = (args: string) =>
    gitAsync(`worktree add ${args}`, repoRoot, undefined, { timeout: GIT_WORKTREE_ADD_TIMEOUT });
  const has = (ref: string) => gitSafeAsync(`rev-parse --verify --quiet ${quote(ref)}`, repoRoot).then(Boolean);
  if (await has(`refs/heads/${branch}`)) {
    await addCheckout(`${quote(checkoutPath)} ${quote(branch)}`);
  } else if (await has(`refs/remotes/origin/${branch}`)) {
    await addCheckout(`--track -b ${quote(branch)} ${quote(checkoutPath)} ${quote(`origin/${branch}`)}`);
  } else if (input.create) {
    const start = (await has(`refs/remotes/origin/${follows}`)) ? `origin/${follows}` : follows;
    if (!(await has(start))) throw new Error(`The followed branch ${follows} does not exist`);
    await addCheckout(`-b ${quote(branch)} ${quote(checkoutPath)} ${quote(start)}`);
  } else {
    throw new Error(
      `Branch ${branch} exists neither in ${repoRoot} nor on origin; add --create to start it from ${follows}`,
    );
  }
  return { checkoutPath, createdCheckout: true };
}

/** Host side: how far a track is behind the branch it follows, after fetching both. */
export async function readTrackStatus(input: {
  checkoutPath: string;
  branch: string;
  follows: string;
}): Promise<WorkTrackStatus> {
  const { checkoutPath, branch, follows } = input;
  let fetchError: string | undefined;
  await gitAsync(`fetch --quiet origin ${quote(follows)}`, checkoutPath).catch((error: unknown) => {
    fetchError = error instanceof Error ? error.message.split("\n")[0] : String(error);
  });
  const followed = (await gitSafeAsync(
    `rev-parse --verify --quiet ${quote(`refs/remotes/origin/${follows}`)}`,
    checkoutPath,
  ))
    ? `refs/remotes/origin/${follows}`
    : `refs/heads/${follows}`;
  const behind = await gitSafeAsync(`rev-list --count ${quote(`refs/heads/${branch}..${followed}`)}`, checkoutPath);
  const committedAt = await gitSafeAsync(`log -1 --format=%ct ${quote(`refs/heads/${branch}`)}`, checkoutPath);
  return {
    behind: behind === null ? null : Number(behind),
    lastCommitAt: committedAt ? Number(committedAt) * 1000 : null,
    ...(fetchError ? { fetchError } : {}),
  };
}

/**
 * Host side: fast-forward a track's checkout to its remote branch, so a new
 * worker starts from what has landed. Returns why it could not, instead of
 * throwing: the worker then starts from the checkout as it is.
 */
export async function pullTrackCheckout(input: {
  checkoutPath: string;
  branch: string;
}): Promise<{ warning?: string }> {
  const { checkoutPath, branch } = input;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetched = await gitAsync(
    `fetch --quiet origin ${quote(`+refs/heads/${branch}:${remoteRef}`)}`,
    checkoutPath,
  ).then(
    () => true,
    () => false,
  );
  // A branch not pushed yet has nothing to pull.
  if (!fetched) return {};
  const current = await gitSafeAsync("symbolic-ref --short HEAD", checkoutPath);
  if (current !== branch) return { warning: `The track checkout ${checkoutPath} is not on ${branch}` };
  const merged = await gitAsync(`merge --quiet --ff-only ${quote(remoteRef)}`, checkoutPath).then(
    () => true,
    () => false,
  );
  return merged ? {} : { warning: `The track checkout ${checkoutPath} could not fast-forward to origin/${branch}` };
}

/** Host side: remove a track checkout Takode made. Git refuses one with changes; the branch is kept. */
export async function removeTrackCheckout(input: { repoRoot: string; checkoutPath: string }): Promise<void> {
  await gitAsync(`worktree remove -- ${quote(input.checkoutPath)}`, input.repoRoot);
}

/** Quote one argument for the shell command line gitAsync runs. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
