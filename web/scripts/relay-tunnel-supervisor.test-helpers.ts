// Shared fixture and process helpers for the relay tunnel supervisor tests. The
// suite is split across several files so Vitest can run them in parallel; each
// test still drives the real supervisor script against a disposable fixture.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const SUPERVISOR = join(REPO_ROOT, "scripts", "relay-tunnel-supervisor.sh");
export const PLIST_TEMPLATE = join(REPO_ROOT, "scripts", "com.takode.relay-tunnel.plist.template");
export const CONFIG_EXAMPLE = join(REPO_ROOT, "scripts", "relay-tunnel-supervisor.conf.example");
export const OPERATIONS_DOC = join(REPO_ROOT, "docs", "relay-tunnel-supervision.md");
export const tempDirs: string[] = [];
export const runningProcesses = new Set<ChildProcess>();

export interface Fixture {
  root: string;
  state: string;
  fakeState: string;
  config: string;
  sshConfig: string;
  identity: string;
  fakeChild: string;
  fakeLogger: string;
  log: string;
}

export interface StatusSnapshot {
  schemaVersion: number;
  state: string;
  ownerToken: string;
  supervisorPid: number;
  childPid: number | null;
  childPgid: number | null;
  attempt: number;
  exitClass: string;
  uptimeSeconds: number;
  backoffSeconds: number;
  healthCode: number | null;
  healthDurationMs: number | null;
  configFingerprint: string;
}

export async function createFixture(mode = "exit:255"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "takode-relay-supervisor-")));
  tempDirs.push(root);
  const state = join(root, "state with spaces");
  const fakeState = join(root, "fake-child-state");
  const config = join(root, "runtime.conf");
  const sshConfig = join(root, "do-not-log-ssh-config");
  const identity = join(root, "do-not-log-identity");
  const fakeChild = join(root, "fake-ssh-child.sh");
  const fakeLogger = join(root, "fake-logger.sh");
  const log = join(root, "metadata-events.log");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(fakeState, { recursive: true, mode: 0o700 });
  await writeFile(join(fakeState, "mode"), `${mode}\n`, "utf8");
  await writeFile(sshConfig, "Host private-relay.example\n  HostName 192.0.2.1\n", { mode: 0o600 });
  await writeFile(identity, "disposable-test-identity\n", { mode: 0o600 });
  await writeFile(
    config,
    [
      "SSH_HOST=private-relay.example",
      `SSH_CONFIG_FILE=${sshConfig}`,
      `SSH_IDENTITY_FILE=${identity}`,
      "REMOTE_BIND_HOST=127.0.0.1",
      "REMOTE_PORT=15432",
      "LOCAL_HOST=127.0.0.1",
      "LOCAL_PORT=15433",
      "HEALTHCHECK_URL=https://do-not-log-health.example/api/health",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(fakeChild, fakeChildSource(), { mode: 0o755 });
  await writeFile(fakeLogger, fakeLoggerSource(), { mode: 0o755 });
  return { root, state, fakeState, config, sshConfig, identity, fakeChild, fakeLogger, log };
}

export async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
}

export function startSupervisor(
  fixture: Fixture,
  options: {
    backoffs?: string;
    maxChildExits?: number;
    stableSeconds?: number;
    quickStartLimit?: number;
    cooldownSeconds?: number;
    handshakeFail?: boolean;
    handshakeTicks?: number;
    ownerInitDelay?: number;
    ownerContentionTicks?: number;
    quarantineLimit?: number;
    omitUserIdentity?: boolean;
    eventMaxBytes?: number;
    unifiedLogger?: boolean;
    backoffGate?: boolean;
  } = {},
): ChildProcess {
  const backoffReadyFile = join(fixture.fakeState, "backoff-ready");
  const backoffReleaseFile = join(fixture.fakeState, "backoff-release");
  const child = spawn("/bin/bash", [SUPERVISOR, fixture.config, fixture.state], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TAKODE_RELAY_SUPERVISOR_TESTING: "1",
      TAKODE_RELAY_SUPERVISOR_TEST_CHILD: fixture.fakeChild,
      TAKODE_RELAY_SUPERVISOR_TEST_STATE: fixture.fakeState,
      TAKODE_RELAY_SUPERVISOR_TEST_LOG_FILE: fixture.log,
      TAKODE_RELAY_SUPERVISOR_TEST_BACKOFFS: options.backoffs ?? "0.01,0.02,0.03,0.04,0.05",
      TAKODE_RELAY_SUPERVISOR_TEST_MAX_CHILD_EXITS: String(options.maxChildExits ?? 0),
      TAKODE_RELAY_SUPERVISOR_TEST_STABLE_SECONDS: String(options.stableSeconds ?? 120),
      TAKODE_RELAY_SUPERVISOR_TEST_WINDOW_SECONDS: "60",
      TAKODE_RELAY_SUPERVISOR_TEST_START_LIMIT: String(options.quickStartLimit ?? 8),
      TAKODE_RELAY_SUPERVISOR_TEST_COOLDOWN_SECONDS: String(options.cooldownSeconds ?? 1),
      TAKODE_RELAY_SUPERVISOR_TEST_HANDSHAKE_FAIL: options.handshakeFail ? "1" : "0",
      TAKODE_RELAY_SUPERVISOR_TEST_HANDSHAKE_TICKS: String(options.handshakeTicks ?? 200),
      TAKODE_RELAY_SUPERVISOR_TEST_HEALTH_RESULT: "200 0.123",
      TAKODE_RELAY_SUPERVISOR_TEST_TERM_TICKS: "20",
      TAKODE_RELAY_SUPERVISOR_TEST_TERM_TICK_SECONDS: "0.01",
      TAKODE_RELAY_SUPERVISOR_TEST_OWNER_INIT_DELAY: String(options.ownerInitDelay ?? 0),
      TAKODE_RELAY_SUPERVISOR_TEST_OWNER_CONTENTION_TICKS: String(options.ownerContentionTicks ?? 50),
      TAKODE_RELAY_SUPERVISOR_TEST_OWNER_CONTENTION_TICK_SECONDS: "0.01",
      TAKODE_RELAY_SUPERVISOR_TEST_QUARANTINE_LIMIT: String(options.quarantineLimit ?? 5),
      TAKODE_RELAY_SUPERVISOR_TEST_EVENT_MAX_BYTES: String(options.eventMaxBytes ?? 262144),
      TAKODE_RELAY_SUPERVISOR_TEST_LOGGER_BIN: options.unifiedLogger ? fixture.fakeLogger : "",
      TAKODE_RELAY_SUPERVISOR_TEST_BACKOFF_READY_FILE: options.backoffGate ? backoffReadyFile : "",
      TAKODE_RELAY_SUPERVISOR_TEST_BACKOFF_RELEASE_FILE: options.backoffGate ? backoffReleaseFile : "",
      ...(options.omitUserIdentity ? { USER: undefined, LOGNAME: undefined } : {}),
    },
  });
  runningProcesses.add(child);
  void child.once("exit", () => runningProcesses.delete(child));
  return child;
}

export async function releaseBackoffGate(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.fakeState, "backoff-release"), "1\n", "utf8");
}

export async function waitForExit(
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await Promise.race([
    new Promise<{ code: number | null; signal: string | null }>((resolveExit, rejectExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
      child.once("error", rejectExit);
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for process ${child.pid ?? "unknown"}`);
    }),
  ]);
}

export async function waitForStatus(
  fixture: Fixture,
  predicate: (status: StatusSnapshot) => boolean,
): Promise<StatusSnapshot> {
  let latest: StatusSnapshot | undefined;
  await waitFor(async () => {
    try {
      latest = JSON.parse(await readFile(join(fixture.state, "status.json"), "utf8"));
      return predicate(latest!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
  return latest!;
}

export async function readStatus(fixture: Fixture): Promise<StatusSnapshot> {
  return JSON.parse(await readFile(join(fixture.state, "status.json"), "utf8"));
}

export async function replaceConfigValue(fixture: Fixture, key: string, value: string): Promise<void> {
  const source = await readFile(fixture.config, "utf8");
  await writeFile(fixture.config, source.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`), { mode: 0o600 });
}

export async function expectPausedFatal(fixture: Fixture, exitClass: string): Promise<void> {
  const supervisor = startSupervisor(fixture, { maxChildExits: 1 });
  expect((await waitForExit(supervisor)).code).toBe(0);
  const status = await readStatus(fixture);
  expect(status.state).toBe("paused_fatal");
  expect(status.exitClass).toBe(exitClass);
  expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
  expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
}

export async function waitForFile(path: string): Promise<string> {
  let value = "";
  await waitFor(async () => {
    try {
      value = (await readFile(path, "utf8")).trim();
      return value.length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  return value;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processStartIdentity(pid: number): string {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return createHash("sha256").update(`${pid}:${result.stdout.trim()}`).digest("hex");
}

export function expectExactForwardContract(renderedArguments: string[]): void {
  const effective = spawnSync("/usr/bin/ssh", ["-G", ...renderedArguments], { encoding: "utf8" });
  expect(effective.status, effective.stderr).toBe(0);
  const forwards = effective.stdout.split("\n").filter((line) => /^(?:remote|local|dynamic)forward\s/.test(line));
  expect(forwards).toEqual(["remoteforward [127.0.0.1]:15432 [127.0.0.1]:15433"]);
  expect(effective.stdout).toContain("clearallforwardings no\n");
}

export function expectEventMetadataLine(line: string): void {
  const allowedKeys = new Set([
    "component",
    "schema",
    "event",
    "state",
    "attempt",
    "exit_class",
    "backoff_seconds",
    "health_code",
    "health_duration_ms",
    "owner_token",
    "supervisor_pid",
    "child_pid",
    "child_pgid",
    "config_fingerprint",
  ]);
  for (const field of line.split(" ")) expect(allowedKeys).toContain(field.split("=", 1)[0]);
  for (const forbidden of [
    "private-relay.example",
    "do-not-log-identity",
    "do-not-log-ssh-config",
    "do-not-log-health.example",
    "15432",
    "15433",
    "-R",
    "prompt",
    "credential",
    "payload",
  ]) {
    expect(line).not.toContain(forbidden);
  }
}

export async function snapshotEventLedger(fixture: Fixture, names?: string[]): Promise<Record<string, string>> {
  const selected = names ?? (await readdir(fixture.state)).filter((name) => /^events[.]log(?:[.].+)?$/.test(name));
  const snapshot: Record<string, string> = {};
  for (const name of selected) {
    const content = await readFile(join(fixture.state, name));
    snapshot[name] = `${content.byteLength}:${createHash("sha256").update(content).digest("hex")}`;
  }
  return snapshot;
}

export async function writeOwnerLock(path: string, pid: number, token: string, startIdentity: string): Promise<void> {
  await writeFile(
    path,
    `${["protocol=1", "phase=initializing", `pid=${pid}`, `token=${token}`, `start_identity=${startIdentity}`].join(
      "\n",
    )}\n`,
    { mode: 0o600 },
  );
  await appendFile(path, `lock_inode=${(await stat(path)).ino}\n`, "utf8");
}

export function readProcessGroup(pid: number): number {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

export function findFixtureProcesses(root: string): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(root) && line.includes("fake-ssh-child.sh"))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter(Number.isFinite);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fakeChildSource(): string {
  return `#!/bin/bash
set -u
state=\${TAKODE_RELAY_SUPERVISOR_TEST_STATE:?}
counter_file="$state/child-attempts"
counter=$(cat "$counter_file" 2>/dev/null || echo 0)
counter=$((counter + 1))
printf '%s\\n' "$counter" > "$counter_file"
printf '%s\\n' "$@" > "$state/args.$counter"
env | sort > "$state/env.$counter"
mode=$(sed -n "\${counter}p" "$state/sequence" 2>/dev/null || true)
if [ -z "$mode" ]; then mode=$(cat "$state/mode"); fi
case "$mode" in
  hold)
    trap 'exit 0' TERM INT
    sleep 60
    ;;
  hold-with-child)
    sleep 60 &
    nested=$!
    printf '%s\\n' "$nested" > "$state/nested-pid"
    trap 'kill "$nested" 2>/dev/null || true; wait "$nested" 2>/dev/null || true; exit 0' TERM INT
    wait "$nested"
    ;;
  exit:*) exit "\${mode#exit:}" ;;
  signal:*) kill -"\${mode#signal:}" $$ ;;
  sleep:*)
    rest=\${mode#sleep:}
    duration=\${rest%%:*}
    code=\${rest#*:}
    sleep "$duration"
    exit "$code"
    ;;
  *) exit 64 ;;
esac
`;
}

function fakeLoggerSource(): string {
  return `#!/bin/bash
set -u
printf '%s\\n' "$*" >> "\${TAKODE_RELAY_SUPERVISOR_TEST_STATE:?}/unified-events"
`;
}

export async function cleanupTestResources(): Promise<void> {
  // A hook can outlive its deadline. Detach this test's ownership before awaiting
  // exits so late cleanup cannot clear or remove a subsequent test's resources.
  const children = [...runningProcesses];
  const directories = tempDirs.splice(0);
  runningProcesses.clear();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  try {
    await Promise.all(children.map((child) => waitForExit(child)));
  } catch (cause) {
    throw new Error(`Preserving relay test fixtures after unconfirmed child exit: ${directories.join(", ")}`, {
      cause,
    });
  }
  await Promise.all(directories.map((dir) => rm(dir, { force: true, recursive: true })));
}


/** Registers the per-test cleanup that stops supervisors and removes fixtures. */
export function registerSupervisorCleanup(): void {
  afterEach(cleanupTestResources);
}
