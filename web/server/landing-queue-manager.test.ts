import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingQueueManager, type LandingRunnerCaller, type LandingRunnerRequest } from "./landing-queue-manager.js";
import { LandingGateStore } from "./landing-gate-store.js";
import { LandingQueueStore } from "./landing-queue-store.js";
import { ResourceLeaseManager } from "./resource-lease-manager.js";
import { ResourceLeaseStore } from "./resource-lease-store.js";
import type { LandingCommitMapping, LandingEntry, LandingTarget } from "../shared/landing-queue.js";

const target: LandingTarget = { repo: "takode", branch: "jiayi" };
const LEASE = "port:takode:jiayi";
const OWNER = "landing-queue:takode:jiayi";
const sha = (n: number) => n.toString(16).padStart(40, "0");

/**
 * The landing queue with server-started runs: the queue holds the branch's port
 * lease in its own name and starts runner processes, so nobody who submitted
 * waits for, starts or finishes a landing run. Real lease and queue stores in a
 * disposable directory; the runner processes are played by the test through the
 * same manager calls the runner routes make.
 */
describe("landing queue manager", () => {
  let directory: string;
  let leases: ResourceLeaseManager;
  let queue: LandingQueueManager;
  let now: number;
  let launches: LandingRunnerRequest[];
  let launchFailure: Error | null;
  const leaseMessages = vi.fn((_sessionId: string, _content: string) => "sent" as const);
  const notify = vi.fn((_sessionId: string, _text: string) => undefined);
  const alertLeaders = vi.fn((_entries: LandingEntry[], _text: string) => undefined);
  const invalidateSession = vi.fn((_sessionId: string) => undefined);

  function createQueue(extra: Partial<ConstructorParameters<typeof LandingQueueManager>[0]> = {}) {
    return new LandingQueueManager(
      {
        leases,
        notify,
        alertLeaders,
        launchRunner: async (request) => {
          if (launchFailure) throw launchFailure;
          launches.push(request);
        },
        sessionNum: (id) => ({ a: 1, b: 2, c: 3 })[id],
        machineName: (hostId) => hostId ?? "coordinator",
        invalidateSession,
        now: () => now,
        ...extra,
      },
      // Separate directories: both stores name their file after the namespace.
      new LandingQueueStore("test", join(directory, "queue")),
      new LandingGateStore("test", join(directory, "gates")),
    );
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "landing-queue-"));
    now = Date.parse("2026-10-09T12:00:00Z");
    launches = [];
    launchFailure = null;
    leaseMessages.mockClear();
    notify.mockClear();
    alertLeaders.mockClear();
    invalidateSession.mockReset();
    leases = new ResourceLeaseManager(
      { injectUserMessage: leaseMessages, invalidateSessionNavigation: vi.fn() },
      new ResourceLeaseStore("test", join(directory, "leases")),
    );
    queue = createQueue();
    await queue.start();
    // The target opted into the queue by having a saved gate.
    await queue.gates.set(target, { version: 1, steps: [{ name: "check", run: ["true"] }] }, { sessionId: "a" });
  });

  afterEach(async () => {
    // Outcome messages go out after a timer; let them land inside this test, not the next.
    await settle();
    queue.destroy();
    leases.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  const submit = (session: string, n: number, extra: { preparationId?: string; hostId?: string } = {}) =>
    queue.submit({
      callerSessionId: session,
      target,
      baseCheckout: `/checkouts/${extra.hostId ?? "coordinator"}/companion`,
      questId: `q-${n}`,
      bundleId: `b-0000000${n}`,
      base: sha(1),
      tip: sha(100 + n),
      commits: [{ sha: sha(100 + n), subject: `change ${n}` }],
      preSubmitTest: { kind: "skipped", reason: "test" },
      ...extra,
    });
  const mapping = (n: number): LandingCommitMapping[] => [
    { source: sha(100 + n), target: sha(200 + n), subject: `change ${n}` },
  ];
  /** Let the queue's deferred work (starting runners, telling owners) run. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** The runner the latest launch started, as its routes would see it. */
  const runner = (request = launches.at(-1)!): LandingRunnerCaller =>
    queue.verifyRunner(request.sessionId, request.token)!;
  const landAll = async (caller: LandingRunnerCaller) => {
    const claim = await queue.claim(caller, target);
    await queue.finish(claim.run!.id, caller, {
      outcomes: claim.entries.map((entry) => ({
        entryId: entry.id,
        outcome: "landed" as const,
        mapping: mapping(Number(entry.questId!.slice(2))),
      })),
      pushedTip: sha(299),
      summary: `Landed ${claim.entries.length}.`,
    });
    return claim;
  };

  it("starts one runner for every waiting change, and nobody who submitted holds or waits for the lease", async () => {
    // The first submit takes the port lease in the queue's name and starts a runner on the
    // oldest change's machine; changes arriving before it claims ride along in the same run.
    expect((await submit("a", 1, { hostId: "devbox" })).ahead).toBe(0);
    expect((await submit("b", 2)).ahead).toBe(1);
    await settle();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ hostId: "devbox", baseCheckout: "/checkouts/devbox/companion", target });
    const status = await leases.getStatus(LEASE);
    expect(status.leases.map((lease) => lease.ownerSessionId)).toEqual([OWNER]);
    expect(status.waiters).toEqual([]);

    const claim = await landAll(runner());
    expect(claim.entries.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
    expect(claim.run!.hostId).toBe("devbox");
    await settle();
    expect((await leases.getStatus(LEASE)).leases).toEqual([]);
    expect(leaseMessages).not.toHaveBeenCalled();
    // Without a quest hand-off, owners hear the outcome from the queue; nobody is told to finish anything.
    expect(notify.mock.calls.map(([session]) => session)).toEqual(["a", "b"]);
    expect(notify.mock.calls[1]![1]).toContain(`Target SHAs in order: ${sha(202)}`);
    expect(notify.mock.calls[1]![1]).not.toContain("land finish");
    // Nothing waits any more, so no new runner is started.
    expect(launches).toHaveLength(1);
  });

  it("waits behind a classic port and starts its runner when the lease is released to it", async () => {
    await leases.acquire({ resourceKey: LEASE, callerSessionId: "porter", purpose: "classic port" });
    await submit("a", 1);
    await settle();
    expect(launches).toEqual([]);
    expect((await queue.snapshot(target)).queueLease).toBe("waiting");
    await leases.release(LEASE, "porter");
    await settle();
    expect(launches).toHaveLength(1);
    // The queue was promoted silently: no session got a Resource Lease message.
    expect(leaseMessages).not.toHaveBeenCalled();
    expect((await queue.snapshot(target)).queueLease).toBe("held");
  });

  it("republishes every change owner when a run starts and when it ends", async () => {
    // Sidebar and board rows show "landing run" for these sessions, read from
    // isLandingActive, so each republish must already see the new run state.
    await submit("a", 1);
    await submit("b", 2);
    await settle();
    const seen: Array<[string, boolean]> = [];
    invalidateSession.mockImplementation((sessionId) => {
      seen.push([sessionId, queue.isLandingActive(sessionId)]);
    });
    const caller = runner();
    const claim = await queue.claim(caller, target);
    expect(seen).toEqual([
      ["a", true],
      ["b", true],
    ]);
    seen.length = 0;
    await queue.finish(claim.run!.id, caller, {
      outcomes: claim.entries.map((entry, i) => ({ entryId: entry.id, outcome: "landed", mapping: mapping(i + 1) })),
      pushedTip: sha(202),
      summary: "Landed 2 of 2.",
    });
    expect(seen).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("keeps only the latest outcome's reason and details on an entry", async () => {
    // An entry re-queued after a failed attempt must not show that old reason
    // once it lands, and a later bounce must not keep an earlier bounce's output.
    const finishWith = async (outcome: "requeue" | "landed" | "bounced", reason: string) => {
      await settle();
      const caller = runner();
      const claim = await queue.claim(caller, target);
      const entryId = claim.entries[0]!.id;
      await queue.finish(claim.run!.id, caller, {
        outcomes: [
          outcome === "landed"
            ? { entryId, outcome, mapping: mapping(1) }
            : outcome === "bounced"
              ? { entryId, outcome, reason }
              : { entryId, outcome, reason },
        ],
        summary: "done",
      });
      return entryId;
    };
    await submit("a", 1);
    const first = await finishWith("requeue", "Dependency install failed.");
    expect((await queue.getEntry(first))!.reason).toBe("Dependency install failed.");
    await finishWith("landed", "");
    const landed = (await queue.getEntry(first))!;
    expect(landed.state).toBe("landed");
    expect(landed.reason).toBeUndefined();

    await submit("b", 2);
    const second = await finishWith("requeue", "The push was rejected.");
    await finishWith("bounced", "It conflicts.");
    const bounced = (await queue.getEntry(second))!;
    expect(bounced.reason).toBe("It conflicts.");
    expect(bounced.details).toBeUndefined();
  });

  it("bounces one entry and re-queues another, and the next runner takes the re-queued one with newcomers", async () => {
    await submit("a", 1);
    await submit("b", 2);
    await settle();
    const caller = runner();
    const claim = await queue.claim(caller, target);
    await submit("c", 3); // arrives during the run
    await queue.finish(claim.run!.id, caller, {
      outcomes: [
        { entryId: claim.entries[0]!.id, outcome: "requeue", reason: "The push was rejected." },
        { entryId: claim.entries[1]!.id, outcome: "bounced", reason: "The landing gate failed.", details: "boom" },
      ],
      summary: "Landed 0 of 2.",
    });
    await settle();
    // Only b hears anything: its change bounced. a and c simply wait for the next runner.
    expect(notify.mock.calls.map(([session]) => session)).toEqual(["b"]);
    expect(launches).toHaveLength(2);
    expect((await queue.claim(runner(), target)).entries.map((entry) => entry.sessionId)).toEqual(["a", "c"]);
  });

  it("requires the queue to hold the lease to claim, and releases it when nothing waits", async () => {
    await submit("a", 1);
    await settle();
    const caller = runner();
    await leases.release(LEASE, "leader", true);
    await expect(queue.claim(caller, target)).rejects.toThrow(`no longer holds ${LEASE}`);

    // A runner that finds nothing waiting (the change was withdrawn) ends and frees the lease.
    await queue.sweep();
    await settle();
    const entryId = (await queue.snapshot(target)).entries[0]!.id;
    const fresh = runner();
    await queue.withdraw(entryId, "a", () => false);
    expect(await queue.claim(fresh, target)).toEqual({ entries: [], unreconciled: [] });
    expect((await leases.getStatus(LEASE)).leases).toEqual([]);
  });

  it("returns the changes of a run that lost the lease without a push plan to the queue", async () => {
    await submit("a", 1);
    await settle();
    const claim = await queue.claim(runner(), target);
    // A leader force-releases the lease of a runner that hung.
    await leases.release(LEASE, "leader", true);
    await queue.sweep();
    await settle();
    const snapshot = await queue.snapshot(target);
    expect(snapshot.entries[0]!.state).toBe("pending");
    expect(snapshot.recentRuns.at(-1)).toMatchObject({ id: claim.run!.id, state: "abandoned" });
    expect(launches).toHaveLength(2);
    expect((await queue.claim(runner(), target)).entries[0]!.id).toBe(claim.entries[0]!.id);
  });

  it("lets only the queue's current runner claim and update runs", async () => {
    await submit("a", 1);
    await settle();
    const request = launches[0]!;
    expect(queue.verifyRunner(request.sessionId, "wrong")).toBeNull();
    expect(queue.verifyRunner("a", request.token)).toBeNull();
    const caller = runner();
    const claim = await queue.claim(caller, target);
    await expect(queue.claim(caller, target)).rejects.toThrow("already claimed");
    const impostor = { ...caller, launchId: "ll-00000000" };
    await expect(queue.heartbeat(claim.run!.id, impostor)).rejects.toThrow("Only the run's runner");
    await queue.finish(claim.run!.id, caller, {
      outcomes: [{ entryId: claim.entries[0]!.id, outcome: "landed", mapping: mapping(1) }],
      summary: "Landed 1.",
    });
    // A finished runner's credentials stop working.
    expect(queue.verifyRunner(request.sessionId, request.token)).toBeNull();
  });

  it("renews the queue's lease on every heartbeat and refuses one after the lease is gone", async () => {
    await submit("a", 1);
    // Starting the runner includes asynchronous persistence; timer turns alone
    // do not establish that its credentials are ready for the heartbeat test.
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    const caller = runner();
    const claim = await queue.claim(caller, target);
    const before = (await leases.getStatus(LEASE)).leases[0]!.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.heartbeat(claim.run!.id, caller, "gating 1 change(s)");
    expect((await leases.getStatus(LEASE)).leases[0]!.expiresAt).toBeGreaterThan(before);
    await leases.release(LEASE, "leader", true);
    await expect(queue.heartbeat(claim.run!.id, caller)).rejects.toThrow("no longer holds the port lease");
  });

  it("keeps a re-queued change waiting without disturbing its owner, and tells the leaders after repeated failures", async () => {
    // The failure that motivated server-reclaimed runs: runs keep failing before pushing
    // (an environment problem, not the change). Owners are not interrupted; their leaders hear once.
    await submit("a", 1);
    await settle();
    for (const attempt of [1, 2]) {
      const caller = runner();
      const claim = await queue.claim(caller, target);
      await queue.finish(claim.run!.id, caller, {
        outcomes: [{ entryId: claim.entries[0]!.id, outcome: "requeue", reason: "Dependency install failed." }],
        summary: "Landed 0 of 1.",
      });
      await settle();
      expect((await leases.getStatus(LEASE)).leases.map((lease) => lease.ownerSessionId)).toEqual(
        attempt === 1 ? [OWNER] : [],
      );
    }
    expect(notify).not.toHaveBeenCalled();
    expect(alertLeaders).toHaveBeenCalledTimes(1);
    expect(alertLeaders.mock.calls[0]![1]).toContain("failed 2 times in a row");
    // The first failure retried at once; the second waits a minute before the next attempt.
    expect(launches).toHaveLength(2);
    const snapshot = await queue.snapshot(target);
    expect(snapshot.entries[0]!.reason).toBe("Dependency install failed.");
    expect(snapshot.launchProblem!.retryAt).toBe(now + 60_000);
    now += 61_000;
    await queue.sweep();
    await settle();
    expect(launches).toHaveLength(3);
  });

  it("gives up on a runner that could not start, frees the lease and tries the next machine", async () => {
    await submit("a", 1, { hostId: "laptop" });
    await submit("b", 2, { hostId: "devbox" });
    launchFailure = new Error("the host is offline");
    await settle();
    expect(launches).toEqual([]);
    const snapshot = await queue.snapshot(target);
    expect(snapshot.launchProblem!.message).toContain("could not start on laptop: the host is offline");
    // Classic ports are not held up while the queue waits to retry.
    expect((await leases.getStatus(LEASE)).leases).toEqual([]);
    launchFailure = null;
    await queue.sweep();
    await settle();
    expect(launches.map((launch) => launch.hostId)).toEqual(["devbox"]);
  });

  it("takes back a run whose runner stopped reporting, frees the lease and starts another runner", async () => {
    // A run that errored while reporting its result kept the lease until a leader force-released it.
    await submit("a", 1);
    await settle();
    const claim = await queue.claim(runner(), target);
    now += 4 * 60_000;
    await queue.sweep();
    await settle();
    const snapshot = await queue.snapshot(target);
    expect(snapshot.recentRuns.at(-1)).toMatchObject({ id: claim.run!.id, state: "abandoned" });
    expect(snapshot.entries[0]!.state).toBe("pending");
    expect(launches).toHaveLength(2);
    expect((await leases.getStatus(LEASE)).leases.map((lease) => lease.ownerSessionId)).toEqual([OWNER]);
  });

  it("takes back a run at once when the server sees its runner exit", async () => {
    await submit("a", 1);
    await settle();
    const claim = await queue.claim(runner(), target);
    await queue.runnerExited(launches[0]!.launchId, "exit code 1");
    await settle();
    const snapshot = await queue.snapshot(target);
    expect(snapshot.recentRuns.at(-1)).toMatchObject({ id: claim.run!.id, state: "abandoned" });
    expect(launches).toHaveLength(2);
    expect(queue.verifyRunner(launches[0]!.sessionId, launches[0]!.token)).toBeNull();
  });

  it("reconciles an interrupted run's push plan in the next runner before claiming", async () => {
    await submit("a", 1);
    await submit("b", 2);
    await settle();
    const first = runner();
    const claim = await queue.claim(first, target);
    await queue.recordPlan(claim.run!.id, first, {
      base: sha(1),
      tip: sha(202),
      mapping: { [claim.entries[0]!.id]: mapping(1), [claim.entries[1]!.id]: mapping(2) },
    });
    await queue.runnerExited(launches[0]!.launchId, "signal SIGKILL");
    await settle();
    expect((await queue.snapshot(target)).unreconciled.map((run) => run.id)).toEqual([claim.run!.id]);
    const second = runner();
    const next = await queue.claim(second, target);
    expect(next.run).toBeUndefined();
    expect(next.unreconciled).toHaveLength(1);
    await queue.reconcile(claim.run!.id, second, true);
    const entries = (await queue.snapshot(target)).entries;
    expect(entries.map((entry) => entry.state)).toEqual(["landed", "landed"]);
    expect(entries[1]!.mapping).toEqual(mapping(2));
  });

  it("starts a runner by hand only when no run is under way and no classic port holds the lease", async () => {
    // The escape hatch for a leader when the server cannot start runners.
    launchFailure = new Error("the host is offline");
    await submit("a", 1);
    // A failed launch records its failure before saving and releasing its lease.
    // Wait for both facts so the porter actually owns the lease under test.
    await vi.waitFor(async () => {
      expect((await queue.snapshot(target)).launchProblem).toBeDefined();
      expect(leases.holdsLease(LEASE, OWNER)).toBe(false);
    });
    expect(
      await leases.acquire({ resourceKey: LEASE, callerSessionId: "porter", purpose: "classic port" }),
    ).toMatchObject({
      status: "acquired",
    });
    const byHand = { callerSessionId: "leader", target, baseCheckout: "/leader/companion", hostId: "laptop" };
    await expect(queue.startRunnerByHand(byHand)).rejects.toThrow("held by porter");
    await leases.release(LEASE, "porter");
    await settle();
    const request = await queue.startRunnerByHand(byHand);
    expect(request).toMatchObject({ hostId: "laptop", baseCheckout: "/leader/companion" });
    expect((await queue.snapshot(target)).launchProblem).toBeUndefined();
    const claim = await queue.claim(runner(request), target);
    await expect(queue.startRunnerByHand(byHand)).rejects.toThrow(`Landing run ${claim.run!.id} is under way`);
  });

  it("asks the quest side first and skips its own message when the quest side handled the outcome", async () => {
    queue.destroy();
    const onEntryResolved = vi.fn(async (entry: LandingEntry) => entry.sessionId === "a");
    queue = createQueue({ onEntryResolved });
    await queue.start();
    await submit("a", 1);
    await submit("b", 2);
    await settle();
    await landAll(runner());
    await settle();
    expect(onEntryResolved.mock.calls.map(([entry]) => entry.sessionId)).toEqual(["a", "b"]);
    expect(notify.mock.calls.map(([session]) => session)).toEqual(["b"]);
  });

  it("moves owners of waiting changes out of the port lease's line on start", async () => {
    // Before server-started runs every owner of a waiting change queued for the lease itself.
    await leases.acquire({ resourceKey: LEASE, callerSessionId: "porter", purpose: "classic port" });
    await submit("a", 1);
    await settle();
    await leases.acquire({ resourceKey: LEASE, callerSessionId: "a", purpose: "old", waitIfUnavailable: true });
    queue.destroy();
    queue = createQueue();
    await queue.start();
    expect((await leases.getStatus(LEASE)).waiters.map((waiter) => waiter.waiterSessionId)).toEqual([OWNER]);
  });

  it("attests landings and bounced preparations only for the owning session", async () => {
    const prep = "a".repeat(32);
    await submit("a", 1, { preparationId: prep });
    await settle();
    const caller = runner();
    const claim = await queue.claim(caller, target);
    const entryId = claim.entries[0]!.id;
    expect(await queue.attestsUnlanded(prep, "a")).toBe(false);
    await queue.finish(claim.run!.id, caller, {
      outcomes: [{ entryId, outcome: "landed", mapping: mapping(1) }],
      summary: "Landed 1 of 1.",
    });
    expect(await queue.attestsLanding(entryId, "a", prep, sha(101), sha(201))).toBe(true);
    expect(await queue.attestsLanding(entryId, "b", prep, sha(101), sha(201))).toBe(false);
    expect(await queue.attestsLanding(entryId, "a", prep, sha(101), sha(299))).toBe(false);

    const other = "b".repeat(32);
    await submit("b", 2, { preparationId: other });
    await settle();
    const second = runner();
    const bounced = await queue.claim(second, target);
    await queue.finish(bounced.run!.id, second, {
      outcomes: [{ entryId: bounced.entries[0]!.id, outcome: "bounced", reason: "conflict", details: "boom" }],
      summary: "Landed 0 of 1.",
    });
    await settle();
    expect(await queue.attestsUnlanded(other, "b")).toBe(true);
    expect(await queue.attestsUnlanded(other, "a")).toBe(false);
    const message = notify.mock.calls.find(([session]) => session === "b")![1];
    expect(message).toContain("boom");
    expect(message).toContain("takode land resume");
  });

  it("allows one waiting entry per session and lets only its owner or leader withdraw it", async () => {
    const { entry } = await submit("a", 1);
    await expect(submit("a", 2)).rejects.toThrow("still pending");
    await expect(queue.withdraw(entry.id, "b", () => false)).rejects.toThrow("owner or its leader");
    const withdrawn = await queue.withdraw(entry.id, "leader", (owner) => owner === "a");
    expect(withdrawn.reason).toContain("leader");
    expect((await submit("a", 2)).entry.state).toBe("pending");
  });

  it("only queues targets with a saved gate", async () => {
    // Opting in is decided by the gate saved on the server, not by anything in the repository.
    await queue.gates.remove(target);
    await expect(submit("a", 1)).rejects.toThrow("No landing gate is saved for takode:jiayi");
    expect((await leases.getStatus(LEASE)).leases).toEqual([]);
    await queue.gates.set(target, { version: 1, steps: [{ name: "check", run: ["true"] }] }, {});
    expect((await submit("a", 1)).entry.state).toBe("pending");
  });

  // A host update must not restart a node while a landing run on that host is
  // under way; a run that stopped reporting no longer holds the update back.
  it("tells whether a change is in an active run and whether a run is under way on a host", async () => {
    await submit("a", 1, { hostId: "devbox" });
    await settle();
    const caller = runner();
    const claim = await queue.claim(caller, target);
    expect(queue.isLandingActive("a")).toBe(true);
    // Classic porters queued behind the queue's lease see it as a holder that is making progress.
    expect(queue.isLandingActive(OWNER)).toBe(true);
    expect(queue.isRunActiveOn("devbox")).toBe(true);
    expect(queue.isRunActiveOn("other-host")).toBe(false);
    now += 6 * 60_000;
    expect(queue.isLandingActive("a")).toBe(false);
    expect(queue.isRunActiveOn("devbox")).toBe(false);
    await queue.heartbeat(claim.run!.id, caller, "gating 1 change(s)");
    expect(queue.isRunActiveOn("devbox")).toBe(true);
    await queue.finish(claim.run!.id, caller, {
      outcomes: [{ entryId: claim.entries[0]!.id, outcome: "landed", mapping: mapping(1) }],
      pushedTip: sha(201),
      summary: "Landed 1 of 1.",
    });
    expect(queue.isRunActiveOn("devbox")).toBe(false);
    expect(queue.isLandingActive("a")).toBe(false);
    expect(queue.isLandingActive(OWNER)).toBe(false);
  });
});
