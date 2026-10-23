/**
 * Taking over a session's process that outlived the previous coordinator on a node.
 *
 * Right after a restart the coordinator also updates its nodes to the new build, which
 * restarts them and ends their processes. A takeover still preparing then holds a process
 * that has already exited. Handed to the Agent SDK (or the Codex adapter), it would leave
 * the session waiting on it forever, every message going nowhere, so such a takeover
 * starts the process afresh instead, which resumes the conversation.
 */
import type { HostLinkManager, RemoteProcess, RemoteSpawnOptions } from "./remote-host/host-link-manager.js";
import { replayOpenClaudeRequests, trackOpenClaudeRequests } from "./remote-host/claude-open-requests.js";
import { processHostOf } from "./remote-host/host-registry.js";
import type { SdkSessionInfo } from "./session-info.js";
import { sessionTag } from "./session-tag.js";

/** The process to take over, or undefined (with a log line) when it has ended meanwhile. */
export function liveTakeover(sessionId: string, proc: RemoteProcess | undefined): RemoteProcess | undefined {
  if (!proc?.hasExited) return proc;
  console.log(
    `[cli-launcher] The host process of session ${sessionTag(sessionId)} ended before it was taken over; starting it afresh`,
  );
  return undefined;
}

/**
 * Process spawner for a node, in the shape the Agent SDK's custom spawn hook expects. It
 * hands over `adopted` while it still runs (checked when the SDK asks, which can be well
 * after the takeover began), and otherwise starts a process with `start`.
 */
export function claudeNodeSpawner(
  info: SdkSessionInfo,
  adopted: RemoteProcess | undefined,
  deps: { start: (options: RemoteSpawnOptions) => RemoteProcess; persist: () => void },
): (options: RemoteSpawnOptions) => RemoteProcess {
  return (options) => {
    const taken = liveTakeover(info.sessionId, adopted);
    const proc = taken ?? deps.start(options);
    const unanswered = taken ? (info.hostClaudeRequests ?? []) : [];
    // Saved so a coordinator that restarts while this process keeps running can ask them again.
    trackOpenClaudeRequests(proc, unanswered, (open) => {
      info.hostClaudeRequests = open;
      deps.persist();
    });
    if (!taken) return proc;
    options.signal?.addEventListener("abort", () => taken.kill("SIGTERM"), { once: true });
    queueMicrotask(() => {
      // It started long ago; the SDK still waits for the event.
      taken.emit("spawn");
      replayOpenClaudeRequests(taken, unanswered);
    });
    return taken;
  };
}

export interface HostTakeoversDeps {
  links: () => HostLinkManager | undefined;
  session: (sessionId: string) => SdkSessionInfo | undefined;
  persist: () => void;
  /** Launch the session, which takes over its waiting process. */
  relaunch: (sessionId: string) => void;
  /**
   * Whether the session's recorded instructions are the ones this server builds for it. Asynchronous
   * because the launch adds the private default instructions, which are read from disk.
   */
  runsCurrentInstructions: (info: SdkSessionInfo) => boolean | Promise<boolean>;
}

/**
 * The processes the previous coordinator left running on nodes, waiting for
 * their host to connect so their sessions can take them over, and the
 * taken-over ones that run outdated instructions.
 *
 * A process is taken over even when its instructions are outdated, so no turn
 * is cut off; `onOutdatedTakeover` lets the server restart the session once it
 * is idle. A process on a node about to restart for an update is ended instead,
 * and one that ends before its takeover (its node restarted) stops its session
 * like an idle one; `onLeftoverProcessEnded` lets the server continue a turn it
 * cut off or deliver input that waited for it.
 */
export class HostTakeovers {
  private readonly waiting = new Map<string, RemoteProcess>();
  private readonly outdated = new Set<string>();
  /** Instruction checks started when a process was taken, read when its takeover finishes. */
  private readonly instructionChecks = new Map<string, Promise<void>>();
  /**
   * A process that outlived the previous server ended without being taken over. A turn it was in was
   * cut off, and input sent while it waited for its host is still queued, so the server continues or
   * relaunches the session.
   */
  onLeftoverProcessEnded: ((sessionId: string) => void) | null = null;
  /** A process with outdated instructions was taken over, so the server can restart the session once it is idle. */
  onOutdatedTakeover: ((sessionId: string) => void) | null = null;

  constructor(private readonly deps: HostTakeoversDeps) {}

  /** Wait for the session's host to connect, then take over the process the previous coordinator left there. */
  await(sessionId: string, hostId: string, procId: string): void {
    const proc = this.deps.links()!.adopt(hostId, procId);
    this.waiting.set(sessionId, proc);
    proc.once("exit", () => {
      if (this.waiting.get(sessionId) !== proc) return;
      // The host lost it, e.g. its node restarted or was updated before anything used it.
      this.waiting.delete(sessionId);
      console.log(`[cli-launcher] Host process of session ${sessionTag(sessionId)} is gone`);
      this.leftoverProcessEnded(sessionId);
    });
  }

  /** The host connected: launch the sessions waiting for it, unless its node is updated first. */
  hostOnline(hostId: string): void {
    // A node updated before use ends these processes itself; their sessions start once, on its new build.
    if (this.deps.links()?.updatesFirst(hostId)) return;
    for (const sessionId of this.waiting.keys()) {
      const info = this.deps.session(sessionId);
      if (info && processHostOf(info) === hostId) this.deps.relaunch(sessionId);
    }
  }

  /** Whether the session waits for its host to connect so it can take over its still-running process. */
  isAwaiting(sessionId: string): boolean {
    return this.waiting.has(sessionId);
  }

  /**
   * Take the session's waiting process for a launch. Taken before any await, so
   * a second launch cannot take it as well. Undefined when there is none, or
   * when it runs on a node about to restart for an update, which ends it.
   */
  take(info: SdkSessionInfo): RemoteProcess | undefined {
    const proc = this.waiting.get(info.sessionId);
    this.waiting.delete(info.sessionId);
    if (!proc) return undefined;
    const host = processHostOf(info);
    if (host && this.deps.links()?.updatesFirst(host)) {
      console.log(
        `[cli-launcher] Session ${sessionTag(info.sessionId)} runs on a node about to restart for an update; ending its process instead of taking it over`,
      );
      proc.kill("SIGTERM");
      return undefined;
    }
    // Cleared again if the process is started afresh after all (see `startedAfresh`).
    this.checkInstructions(info);
    return proc;
  }

  /** A launch could not use the taken process; it waits for its host again. */
  putBack(sessionId: string, proc: RemoteProcess): void {
    this.waiting.set(sessionId, proc);
  }

  /** The session is being stopped: end the process still waiting for its host. */
  endWaiting(sessionId: string): void {
    this.waiting.get(sessionId)?.kill("SIGTERM");
    this.waiting.delete(sessionId);
  }

  /** Whether the session's process is one taken over after a restart that runs outdated instructions. */
  runsOutdatedInstructions(sessionId: string): boolean {
    return this.outdated.has(sessionId) && this.deps.session(sessionId)?.state !== "exited";
  }

  /** The session got a fresh process, which runs the current instructions. */
  startedAfresh(sessionId: string): void {
    this.instructionChecks.delete(sessionId);
    this.outdated.delete(sessionId);
  }

  /**
   * A launch that took over a process finished; report it when the process runs outdated instructions.
   * The check started when the process was taken has usually settled by now (a launch builds the same
   * instructions); otherwise the report waits for it.
   */
  tookOver(sessionId: string): void {
    const check = this.instructionChecks.get(sessionId);
    if (check) {
      void check.then(() => this.reportOutdatedTakeover(sessionId));
      return;
    }
    this.reportOutdatedTakeover(sessionId);
  }

  /**
   * Compare the taken process's instructions with the current ones. A process found outdated is marked
   * unless it was started afresh meanwhile; a failed check leaves it unmarked, like a current one.
   */
  private checkInstructions(info: SdkSessionInfo): void {
    const sessionId = info.sessionId;
    let current: boolean | Promise<boolean>;
    try {
      current = this.deps.runsCurrentInstructions(info);
    } catch {
      return;
    }
    if (typeof current === "boolean") {
      if (!current) this.outdated.add(sessionId);
      return;
    }
    const check: Promise<void> = current.then(
      (isCurrent) => {
        if (this.instructionChecks.get(sessionId) !== check) return;
        this.instructionChecks.delete(sessionId);
        if (!isCurrent) this.outdated.add(sessionId);
      },
      () => {
        if (this.instructionChecks.get(sessionId) === check) this.instructionChecks.delete(sessionId);
      },
    );
    this.instructionChecks.set(sessionId, check);
  }

  private reportOutdatedTakeover(sessionId: string): void {
    if (!this.runsOutdatedInstructions(sessionId)) return;
    console.log(
      `[cli-launcher] Session ${sessionTag(sessionId)} runs outdated instructions; took over its process and will restart it once it is idle`,
    );
    this.onOutdatedTakeover?.(sessionId);
  }

  /**
   * A process the previous server left running ended without being taken over. The session is
   * stopped like an idle one, so it starts afresh on its next message (or now, when work waits for it).
   */
  private leftoverProcessEnded(sessionId: string): void {
    const info = this.deps.session(sessionId);
    if (!info) return;
    info.state = "exited";
    info.exitCode = -1;
    this.deps.persist();
    this.onLeftoverProcessEnded?.(sessionId);
  }
}
