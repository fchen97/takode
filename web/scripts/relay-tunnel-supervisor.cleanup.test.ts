import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupTestResources,
  pathExists,
  runningProcesses,
  tempDirs,
  registerSupervisorCleanup,
} from "./relay-tunnel-supervisor.test-helpers.js";

registerSupervisorCleanup();

describe("relay test resource ownership", () => {
  it("keeps newer fixtures and process tracking intact when earlier cleanup finishes late", async () => {
    // Reproduce overlapping hooks without waiting for a real hook deadline or
    // starting a supervisor: the old child exit is controlled by the test.
    const previousDirectory = await mkdtemp(join(tmpdir(), "relay-cleanup-previous-"));
    tempDirs.push(previousDirectory);
    const previousChild = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    runningProcesses.add(previousChild);
    const pendingCleanup = cleanupTestResources();
    try {
      const nextDirectory = await mkdtemp(join(tmpdir(), "relay-cleanup-next-"));
      tempDirs.push(nextDirectory);
      const nextChild = { exitCode: 0, signalCode: null } as ChildProcess;
      runningProcesses.add(nextChild);
      previousChild.emit("exit", 0, null);
      await pendingCleanup;

      expect(await pathExists(previousDirectory)).toBe(false);
      expect(await pathExists(nextDirectory)).toBe(true);
      expect(runningProcesses.has(nextChild)).toBe(true);
      expect(previousChild.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      previousChild.emit("exit", 0, null);
      await pendingCleanup;
    }
  });

  it("preserves fixture evidence when a child exit cannot be confirmed", async () => {
    // An exit-wait error must surface without deleting evidence used by a child
    // whose termination has not been established.
    const directory = await mkdtemp(join(tmpdir(), "relay-cleanup-unconfirmed-"));
    tempDirs.push(directory);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    runningProcesses.add(child);
    const pendingCleanup = cleanupTestResources();
    child.emit("error", new Error("Synthetic exit observation failure"));
    try {
      await expect(pendingCleanup).rejects.toThrow("Preserving relay test fixtures after unconfirmed child exit");
      expect(await pathExists(directory)).toBe(true);
    } finally {
      // No real child was spawned; this test alone owns the retained fixture.
      tempDirs.push(directory);
    }
  });
});
