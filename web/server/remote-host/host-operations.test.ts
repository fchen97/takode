import { execFileSync } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_WORKTREE_ADD_TIMEOUT } from "../constants.js";
import { FakeHostLink } from "../test-fixtures/fake-host-link.js";
import { prepareWorktreeForSessionCreate } from "../routes/session-worktree-create.js";
import { HostAgent } from "./host-agent.js";
import { HostLinkManager } from "./host-link-manager.js";
import { onMachine } from "./host-operations.js";
import { configureRemoteMachines, requestOnHost } from "./session-machine.js";

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Worktree operations for a session on a remote host run on that host. The
 * "remote" host is an in-process HostAgent reached only through the host link,
 * and every path lives under a temporary directory.
 */
describe("host operations", () => {
  const hostId = "host-1";
  let manager: HostLinkManager;
  let agent: HostAgent;
  let dir: string;
  let repo: string;
  let checkout: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "host-operations-")));
    repo = join(dir, "repo");
    checkout = join(dir, "checkout");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "worktree", "add", "-q", "-b", "main-wt-1", checkout);

    manager = new HostLinkManager();
    configureRemoteMachines(manager);
    agent = new HostAgent({
      coordinatorUrl: "http://coordinator.test",
      token: "token",
      apiProxyPort: 45_678,
      log: () => {},
      connect: () => new FakeHostLink(manager, hostId).agentSide,
    });
    agent.start();
    await waitFor(() => manager.status(hostId).online);
  });

  afterEach(async () => {
    agent.stop();
    configureRemoteMachines(null);
    await rm(dir, { recursive: true, force: true });
  });

  // The same call answers from this machine without a host and from the host
  // with one, and results survive the trip as JSON.
  it("inspects a repo and checks cleanup safety on the session's machine", async () => {
    const local = await onMachine(undefined, "repoInfo", checkout);
    expect(await onMachine(hostId, "repoInfo", checkout)).toEqual(local);
    expect(local).toMatchObject({ repoRoot: repo, currentBranch: "main-wt-1", isWorktree: true });

    const target = { sessionId: "s1", repoRoot: repo, branch: "main", worktreePath: checkout, createdAt: 0, hostId };
    expect(await onMachine(hostId, "worktreeCleanupSafety", target)).toMatchObject({ status: "safe" });
    await writeFile(join(checkout, "draft.txt"), "unsaved");
    expect(await onMachine(hostId, "worktreeCleanupSafety", target)).toMatchObject({ status: "blocked", dirty: true });
  });

  // Archive removes the checkout on the host; a dirty one stays unless forced.
  it("removes a session's checkout on the host", async () => {
    const target = { sessionId: "s1", repoRoot: repo, branch: "main", worktreePath: checkout, createdAt: 0, hostId };
    await writeFile(join(checkout, "draft.txt"), "unsaved");
    expect(await onMachine(hostId, "removeWorktreeCheckout", target, { force: false })).toMatchObject({
      cleaned: false,
      dirty: true,
    });
    expect(await onMachine(hostId, "removeWorktreeCheckout", target, { force: true })).toMatchObject({ cleaned: true });
    await expect(access(checkout)).rejects.toThrow();
  });

  // Creating a checkout of a large repo can take minutes on the host, so the
  // coordinator waits past the host's longer checkout limit for operations that
  // create one, and keeps the shorter wait for everything else.
  it("waits longer for operations that create a checkout", async () => {
    const request = vi.spyOn(manager, "request");
    await onMachine(hostId, "repoInfo", checkout);
    const result = await onMachine(hostId, "ensureWorktree", repo, "main", {
      forceNew: true,
      worktreeRoot: join(dir, "worktrees"),
    });
    expect(git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(result.actualBranch);

    const waits = request.mock.calls.map(([, sent, timeoutMs]) => [(sent as { name?: string }).name, timeoutMs]);
    expect(waits).toEqual([
      ["repoInfo", 120_000],
      ["ensureWorktree", GIT_WORKTREE_ADD_TIMEOUT + 120_000],
    ]);
  });

  // The host runs only the named operations, never an arbitrary function.
  it("refuses an unknown operation", async () => {
    await expect(requestOnHost(hostId, { kind: "operation", name: "constructor", args: [] }, 5_000)).rejects.toThrow(
      "Unknown host operation: constructor",
    );
  });

  // A worktree session created on a host starts from the branch checked out in
  // the host's clone, not from the remote's default branch. A clone has
  // origin/HEAD, so a detached checkout reporting `HEAD` used to resolve to
  // origin/main; it now fails with a clear message instead.
  it("bases a host worktree on the clone's checked-out branch", async () => {
    git(repo, "checkout", "-q", "-b", "jiayi");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "j");
    const jiayiTip = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", repo, clone]);
    git(clone, "checkout", "-q", "jiayi");
    const create = (cwd: string) =>
      prepareWorktreeForSessionCreate({
        body: { useWorktree: true },
        cwd,
        hostId,
        isOrchestrator: false,
        emit: async () => {},
        throwPreparationError: (message) => {
          throw new Error(message);
        },
      });

    const result = await create(clone);
    expect(result?.worktreeInfo).toMatchObject({
      repoRoot: clone,
      branch: "jiayi",
      actualBranch: expect.stringMatching(/^jiayi-wt-\d+$/),
      portTarget: { repoRoot: clone, branch: "jiayi", hostId },
    });
    expect(git(result!.cwd, "rev-parse", "HEAD")).toBe(jiayiTip);

    git(clone, "checkout", "-q", "--detach");
    await expect(create(clone)).rejects.toThrow("detached HEAD");
  });
});
