import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SUPERVISOR = join(REPO_ROOT, "scripts", "relay-tunnel-supervisor.sh");
const PLIST_TEMPLATE = join(REPO_ROOT, "scripts", "com.takode.relay-tunnel.plist.template");
const CONFIG_EXAMPLE = join(REPO_ROOT, "scripts", "relay-tunnel-supervisor.conf.example");
const OPERATIONS_DOC = join(REPO_ROOT, "docs", "relay-tunnel-supervision.md");
const tempDirs: string[] = [];
const runningProcesses = new Set<ChildProcess>();

vi.setConfig({ testTimeout: 30_000 });

interface Fixture {
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

interface StatusSnapshot {
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

async function cleanupTestResources(): Promise<void> {
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

afterEach(cleanupTestResources);

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

describe("relay tunnel supervisor tracked artifacts", () => {
  it("keeps production values runtime-only and renders a valid user LaunchAgent template", async () => {
    const [source, plist, example, operations] = await Promise.all([
      readFile(SUPERVISOR, "utf8"),
      readFile(PLIST_TEMPLATE, "utf8"),
      readFile(CONFIG_EXAMPLE, "utf8"),
      readFile(OPERATIONS_DOC, "utf8"),
    ]);

    expect(source).toContain('SSH_BIN="/usr/bin/ssh"');
    expect(source).toContain("BACKOFF_SECONDS=(2 4 8 16 30)");
    expect(source).toContain("STABLE_RESET_SECONDS=120");
    expect(source).toContain("QUICK_START_LIMIT=8");
    expect(source).toContain("COOLDOWN_SECONDS=300");
    expect(source).not.toMatch(/\b(?:3455|3456|20000)\b/);
    expect(source).not.toContain("takode-relay");
    expect(source).not.toMatch(/\b(?:lsof|pgrep)\b/);

    expect(plist).toContain("com.takode.relay-tunnel");
    expect(plist).toContain("__SUPERVISOR_PATH__");
    expect(plist).toContain("__CONFIG_PATH__");
    expect(plist).toContain("__STATE_DIRECTORY__");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).not.toContain("NetworkState");
    expect(example).not.toContain("takode-relay");
    expect(example).not.toMatch(/\b(?:3455|3456|20000)\b/);
    expect(example).toContain("HEALTHCHECK_URL=http://127.0.0.1:15433/api/health");
    expect(example).not.toContain("HEALTHCHECK_URL=https://");
    expect(operations).toContain("Before every child start");
    expect(operations).toContain("deliberate reload is bootout");
    expect(operations).toContain("state/events.log");
    expect(operations).toContain("unified-log mirror is best-effort");
    const readiness = operations.match(
      /### Thirty-second wall-clock readiness evidence[\s\S]*?```bash\n([\s\S]*?)\n```/,
    )?.[1];
    expect(readiness).toBeDefined();
    expect(spawnSync("/bin/bash", ["-n"], { input: readiness, encoding: "utf8" }).status).toBe(0);
    expect(readiness).toContain("deadline=$(( started_epoch + 30 ))");
    expect(readiness).toContain('launchctl bootstrap "gui/$UID" "$PLIST_PATH"');
    expect(readiness).toContain('-o ClearAllForwardings=yes "$RELAY_HOST"');
    expect(readiness).toContain('"$launchd_pid" = "$status_supervisor_pid"');
    expect(readiness).toContain('"$actual_child_ppid" = "$status_supervisor_pid"');
    expect(readiness).toContain('"$supervisor_count" = 1');
    expect(readiness).toContain('"$child_count" = 1');
    expect(readiness).toContain('"$child_pid" = "$actual_child_pgid"');
    expect(readiness).toContain('"$3" -gt 0');
    expect(readiness).toContain('"$4" = sshd');
    expect(readiness).toContain('"$5" = 1');
    expect(readiness).toContain('"$1" = 1');
    expect(readiness).toContain('"$2" = 0');
    expect(readiness).toContain('"$observed_epoch" -le "$deadline"');
    expect(readiness).toContain("first_ready_epoch=$observed_epoch");
    expect(readiness).toContain('attempt_dir="$EVIDENCE_DIR/readiness-attempt-$attempt_utc-$attempt_token"');
    expect(readiness).toContain('mkdir -m 700 "$attempt_dir"');
    expect(readiness).toContain('trace="$attempt_dir/readiness.tsv"');
    expect(readiness).toContain('first_ready="$attempt_dir/readiness.first-ready.tsv"');

    const evidenceFields = [
      "started_epoch",
      "deadline",
      "observed_epoch",
      "observed_utc",
      "first_ready_epoch",
      "launchd_pid",
      "status_supervisor_pid",
      "actual_child_ppid",
      "child_pid",
      "child_pgid",
      "actual_child_pgid",
      "supervisor_count",
      "child_count",
      "app_listeners",
      "monitor_listeners",
      "app_owner_pid",
      "app_owner_type",
      "app_owner_is_sshd",
      "status_state",
      "local_health",
      "upstream_health",
      "coherent",
    ];
    expect(readiness).toContain(`trace_header=$(printf '${evidenceFields.join("\\t")}')`);
    const pollRow = readiness.match(/poll_row=\$\(printf[\s\S]*?\"\$coherent\"\)/)?.[0];
    expect(pollRow).toBeDefined();
    for (const value of [
      '"$started_epoch"',
      '"$deadline"',
      '"$observed_epoch"',
      '"$observed_utc"',
      '"$first_ready_epoch"',
      '"${launchd_pid:-0}"',
      '"$status_supervisor_pid"',
      '"${actual_child_ppid:-0}"',
      '"$child_pid"',
      '"$child_pgid"',
      '"${actual_child_pgid:-0}"',
      '"$supervisor_count"',
      '"$child_count"',
      '"$1"',
      '"$2"',
      '"$3"',
      '"$4"',
      '"$5"',
      '"$status_state"',
      '"$local_health"',
      '"$6"',
      '"$coherent"',
    ]) {
      expect(pollRow).toContain(value);
    }
    expect(readiness).toContain(`printf '%s\\n%s\\n' "$trace_header" "$poll_row" > "$first_ready_tmp"`);
    expect(readiness).toContain('ln "$first_ready_tmp" "$first_ready"');
    expect(readiness).toContain('[ ! -e "$first_ready" ]');

    if (process.platform === "darwin") {
      const lint = spawnSync("plutil", ["-lint", PLIST_TEMPLATE], { encoding: "utf8" });
      expect(lint.status, lint.stderr).toBe(0);
    }
  });

  it("keeps readiness proof scoped across successive success and failure attempts", async () => {
    const operations = await readFile(OPERATIONS_DOC, "utf8");
    const readiness = operations.match(
      /### Thirty-second wall-clock readiness evidence[\s\S]*?```bash\n([\s\S]*?)\n```/,
    )?.[1];
    expect(readiness).toBeDefined();

    const root = await realpath(await mkdtemp(join(tmpdir(), "relay-readiness-evidence-")));
    tempDirs.push(root);
    const fakeBin = join(root, "bin");
    const evidenceRoot = join(root, "evidence");
    await mkdir(fakeBin, { mode: 0o700 });
    await mkdir(evidenceRoot, { mode: 0o700 });
    await Promise.all([
      writeExecutable(join(fakeBin, "uuidgen"), `#!/bin/bash\nprintf '%s\\n' "$READINESS_ATTEMPT_TOKEN"\n`),
      writeExecutable(
        join(fakeBin, "date"),
        `#!/bin/bash
if [ "$1" = "-u" ]; then
  if [ "$2" = "+%Y%m%dT%H%M%SZ" ]; then
    printf '%s\\n' "$READINESS_ATTEMPT_UTC"
  else
    printf '2026-08-02T01:02:03Z\\n'
  fi
  exit 0
fi
count=0
[ ! -f "$READINESS_DATE_STATE" ] || read -r count < "$READINESS_DATE_STATE"
printf '%s\\n' "$(( count + 1 ))" > "$READINESS_DATE_STATE"
case "$count" in
  0|1) value=$READINESS_EPOCH_BASE ;;
  2) value=$(( READINESS_EPOCH_BASE + 1 )) ;;
  *) value=$(( READINESS_EPOCH_BASE + 31 )) ;;
esac
printf '%s\\n' "$value"
`,
      ),
      writeExecutable(
        join(fakeBin, "launchctl"),
        `#!/bin/bash
case "$1" in
  bootstrap) exit 0 ;;
  print) [ "$READINESS_TEST_MODE" != success ] || printf 'pid = 111\\n' ;;
esac
`,
      ),
      writeExecutable(
        join(fakeBin, "jq"),
        `#!/bin/bash
case "$*" in
  *supervisorPid*) printf '111\\n' ;;
  *childPid*) printf '222\\n' ;;
  *childPgid*) printf '222\\n' ;;
  *state*) printf 'running\\n' ;;
  *healthCode*) printf '200\\n' ;;
  *) exit 1 ;;
esac
`,
      ),
      writeExecutable(
        join(fakeBin, "ps"),
        `#!/bin/bash
case "$*" in
  *ppid=*) printf '111\\n' ;;
  *pgid=*) printf '222\\n' ;;
  *'-axo command='*) printf '/bin/bash %s %s %s\\n' "$SUPERVISOR_PATH" "$CONFIG_PATH" "$STATE_DIR" ;;
  *) exit 1 ;;
esac
`,
      ),
      writeExecutable(join(fakeBin, "pgrep"), `#!/bin/bash\nprintf '222\\n'\n`),
      writeExecutable(join(fakeBin, "ssh"), `#!/bin/bash\nprintf '1 0 333 sshd 1 200\\n'\n`),
      writeExecutable(join(fakeBin, "sleep"), `#!/bin/bash\nexit 0\n`),
    ]);

    const runAttempt = (token: string, mode: "success" | "failure", epochBase: number) =>
      spawnSync("/bin/bash", ["-s"], {
        input: readiness,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          EVIDENCE_DIR: evidenceRoot,
          STATE_FILE: join(root, "status.json"),
          LAUNCHD_LABEL: "com.example.relay-tunnel",
          PLIST_PATH: join(root, "relay.plist"),
          SUPERVISOR_PATH: join(root, "supervisor.sh"),
          CONFIG_PATH: join(root, "runtime.conf"),
          STATE_DIR: join(root, "state"),
          RELAY_HOST: "relay-test",
          RELAY_APPLICATION_PORT: "15432",
          RELAY_MONITOR_PORT: "15433",
          READINESS_ATTEMPT_TOKEN: token,
          READINESS_ATTEMPT_UTC: "20260802T010203Z",
          READINESS_DATE_STATE: join(root, `date-${token}`),
          READINESS_EPOCH_BASE: String(epochBase),
          READINESS_TEST_MODE: mode,
        },
      });
    const attemptPath = (token: string) => join(evidenceRoot, `readiness-attempt-20260802T010203Z-${token}`);
    const firstToken = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const failedToken = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const secondToken = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const first = runAttempt(firstToken, "success", 100);
    expect(first.status, first.stderr).toBe(0);
    const firstDir = attemptPath(firstToken);
    const firstReady = join(firstDir, "readiness.first-ready.tsv");
    expect(first.stdout).toContain(`readiness_attempt=${firstDir}`);
    expect(await pathExists(firstReady)).toBe(true);

    const failed = runAttempt(failedToken, "failure", 200);
    expect(failed.status).toBe(1);
    const failedDir = attemptPath(failedToken);
    expect(failed.stdout).toContain(`readiness_attempt=${failedDir}`);
    expect(failed.stdout).not.toContain(firstDir);
    expect(await pathExists(join(failedDir, "readiness.tsv"))).toBe(true);
    expect(await pathExists(join(failedDir, "readiness.first-ready.tsv"))).toBe(false);
    expect(await pathExists(firstReady)).toBe(true);

    const second = runAttempt(secondToken, "success", 300);
    expect(second.status, second.stderr).toBe(0);
    const secondDir = attemptPath(secondToken);
    const secondReady = join(secondDir, "readiness.first-ready.tsv");
    expect(second.stdout).toContain(`readiness_attempt=${secondDir}`);
    expect(await pathExists(secondReady)).toBe(true);
    expect(new Set([firstDir, failedDir, secondDir]).size).toBe(3);

    const firstRows = (await readFile(firstReady, "utf8")).trim().split("\n");
    const secondRows = (await readFile(secondReady, "utf8")).trim().split("\n");
    expect(firstRows).toHaveLength(2);
    expect(secondRows).toHaveLength(2);
    expect(firstRows[0]).toBe(secondRows[0]);
    expect(firstRows[1]?.split("\t")).toEqual([
      "100",
      "130",
      "101",
      "2026-08-02T01:02:03Z",
      "101",
      "111",
      "111",
      "111",
      "222",
      "222",
      "222",
      "1",
      "1",
      "1",
      "0",
      "333",
      "sshd",
      "1",
      "running",
      "200",
      "200",
      "1",
    ]);
    expect(secondRows[1]?.split("\t").slice(0, 5)).toEqual(["300", "330", "301", "2026-08-02T01:02:03Z", "301"]);
  });

  it("pauses cleanly on fatal configuration without starting a child or looping", async () => {
    const fixture = await createFixture();
    await chmod(fixture.config, 0o644);

    const child = startSupervisor(fixture, { maxChildExits: 1 });
    const result = await waitForExit(child);
    const status = await readStatus(fixture);

    expect(result.code).toBe(0);
    expect(status.state).toBe("paused_fatal");
    expect(status.exitClass).toBe("config_permissions");
    expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
    expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
    expect((await stat(join(fixture.state, "status.json"))).mode & 0o777).toBe(0o600);
  });

  it("renders one effective remote forward and no inherited forward types through ssh -G", async () => {
    const fixture = await createFixture("hold");
    const supervisor = startSupervisor(fixture);
    await waitForStatus(fixture, (status) => status.state === "running");

    const renderedArguments = (await waitForFile(join(fixture.fakeState, "args.1"))).split("\n");
    expectExactForwardContract(renderedArguments);

    supervisor.kill("SIGTERM");
    expect((await waitForExit(supervisor)).code).toBe(0);
  });

  it("fails closed when the explicit SSH config contributes an extra forward", async () => {
    const fixture = await createFixture();
    await appendFile(fixture.sshConfig, "  RemoteForward 15434 127.0.0.1:15435\n", "utf8");
    const supervisor = startSupervisor(fixture, { maxChildExits: 1 });

    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).exitClass).toBe("ssh_forward_contract");
    expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
  });

  it("publishes a discoverable owner-only event sink alongside status and unified best effort", async () => {
    const fixture = await createFixture("exit:255");
    const supervisor = startSupervisor(fixture, { maxChildExits: 1, unifiedLogger: true });
    expect((await waitForExit(supervisor)).code).toBe(0);

    const eventPath = join(fixture.state, "events.log");
    const eventText = await readFile(eventPath, "utf8");
    const testLogText = await readFile(fixture.log, "utf8");
    const unifiedText = await readFile(join(fixture.fakeState, "unified-events"), "utf8");
    const status = await readStatus(fixture);
    expect((await stat(eventPath)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.state)).mode & 0o777).toBe(0o700);
    expect(eventText).toContain("event=wrapper_started");
    expect(eventText).toContain("event=child_started");
    expect(eventText).toContain("event=health_sample");
    expect(eventText).toContain("event=unexpected_child_exit");
    expect(testLogText).toContain("event=wrapper_started");
    expect(unifiedText).toContain("event=wrapper_started");
    expect(status.state).toBe("paused_test_complete");
    for (const line of eventText.trim().split("\n")) expectEventMetadataLine(line);
  });

  it("rotates the canonical event sink within fixed size and retention bounds", async () => {
    const fixture = await createFixture("exit:255");
    const supervisor = startSupervisor(fixture, {
      backoffs: "0.01,0.01,0.01,0.01,0.01",
      maxChildExits: 4,
      quickStartLimit: 99,
      eventMaxBytes: 512,
    });
    expect((await waitForExit(supervisor, 45_000)).code).toBe(0);

    const eventFiles = (await readdir(fixture.state)).filter((name) => name.startsWith("events.log")).sort();
    expect(eventFiles).toEqual(["events.log", "events.log.1", "events.log.2", "events.log.3"]);
    for (const name of eventFiles) {
      const path = join(fixture.state, name);
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.size).toBeLessThanOrEqual(900);
      const text = await readFile(path, "utf8");
      for (const line of text.trim().split("\n").filter(Boolean)) expectEventMetadataLine(line);
    }
  }, 60_000);

  it("accepts an existing canonical current ledger plus exactly three bounded rotations", async () => {
    const fixture = await createFixture("exit:255");
    for (const name of ["events.log", "events.log.1", "events.log.2", "events.log.3"]) {
      await writeFile(join(fixture.state, name), `canonical=${name}\n`, { mode: 0o600 });
    }
    const rotatedBefore = await snapshotEventLedger(fixture, ["events.log.1", "events.log.2", "events.log.3"]);

    const supervisor = startSupervisor(fixture, { maxChildExits: 1 });
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).state).toBe("paused_test_complete");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await snapshotEventLedger(fixture, ["events.log.1", "events.log.2", "events.log.3"])).toEqual(rotatedBefore);
    expect(await readFile(join(fixture.state, "events.log"), "utf8")).toContain("event=wrapper_started");
  });

  it.each([
    "leading-zero",
    "out-of-range",
    "oversized-current",
    "oversized-rotated",
  ])("rejects noncanonical or oversized restart ledger state: %s", async (variant) => {
    const fixture = await createFixture();
    if (variant === "leading-zero") {
      await writeFile(join(fixture.state, "events.log.01"), "sentinel-leading-zero\n", { mode: 0o600 });
    } else if (variant === "out-of-range") {
      await writeFile(join(fixture.state, "events.log.4"), "sentinel-out-of-range\n", { mode: 0o600 });
    } else if (variant === "oversized-current") {
      await writeFile(join(fixture.state, "events.log"), "x".repeat(262145), { mode: 0o600 });
    } else {
      await writeFile(join(fixture.state, "events.log.2"), "x".repeat(262145), { mode: 0o600 });
    }
    const before = await snapshotEventLedger(fixture);

    const supervisor = startSupervisor(fixture, { maxChildExits: 1, unifiedLogger: true });
    expect((await waitForExit(supervisor)).code).toBe(0);
    const status = await readStatus(fixture);
    expect(status.state).toBe("paused_fatal");
    expect(status.exitClass).toBe("event_sink_untrusted");
    expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
    expect(await snapshotEventLedger(fixture)).toEqual(before);
    expect((await readdir(fixture.state)).filter((name) => /^events[.]log(?:[.].+)?$/.test(name)).sort()).toEqual(
      Object.keys(before).sort(),
    );
  });

  it("fails closed without following an untrusted event-sink symlink", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-event-target");
    const eventPath = join(fixture.state, "events.log");
    await writeFile(outside, "sentinel\n", { mode: 0o600 });
    await symlink(outside, eventPath);

    const supervisor = startSupervisor(fixture, { maxChildExits: 1, unifiedLogger: true });
    expect((await waitForExit(supervisor)).code).toBe(0);
    const status = await readStatus(fixture);
    expect(status.state).toBe("paused_fatal");
    expect(status.exitClass).toBe("event_sink_untrusted");
    expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
    expect((await lstat(eventPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("sentinel\n");
    expect(await readFile(fixture.log, "utf8")).toContain("event=event_sink_untrusted");
    expect(await readFile(join(fixture.fakeState, "unified-events"), "utf8")).toContain("event=event_sink_untrusted");
  });

  it("pauses before child 2 when SSH config gains an extra forward during backoff", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nhold\n", "utf8");
    const supervisor = startSupervisor(fixture, { backoffs: "0.01,0.01,0.01,0.01,0.01", backoffGate: true });
    await waitForFile(join(fixture.fakeState, "backoff-ready"));

    await appendFile(fixture.sshConfig, "  RemoteForward 15434 127.0.0.1:15435\n", "utf8");
    await releaseBackoffGate(fixture);
    expect((await waitForExit(supervisor)).code).toBe(0);
    const status = await readStatus(fixture);
    expect(status.state).toBe("paused_fatal");
    expect(status.exitClass).toBe("ssh_config_changed");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await pathExists(join(fixture.fakeState, "args.2"))).toBe(false);
    expect(findFixtureProcesses(fixture.root)).toEqual([]);

    const metadata = `${JSON.stringify(status)}\n${await readFile(fixture.log, "utf8")}`;
    for (const forbidden of [
      "private-relay.example",
      "RemoteForward",
      "do-not-log-ssh-config",
      "15432",
      "15434",
      "127.0.0.1",
    ]) {
      expect(metadata).not.toContain(forbidden);
    }
  }, 30_000);

  it("pauses before child 2 when SSH config becomes a direct symlink during backoff", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nhold\n", "utf8");
    const supervisor = startSupervisor(fixture, { backoffs: "0.01,0.01,0.01,0.01,0.01", backoffGate: true });
    await waitForFile(join(fixture.fakeState, "backoff-ready"));

    const original = `${fixture.sshConfig}.original`;
    await rename(fixture.sshConfig, original);
    await symlink(original, fixture.sshConfig);
    await releaseBackoffGate(fixture);
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).exitClass).toBe("ssh_config_untrusted_path");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await pathExists(join(fixture.fakeState, "args.2"))).toBe(false);
  }, 30_000);

  it("pauses before child 2 when identity ancestry becomes a symlink during backoff", async () => {
    const fixture = await createFixture();
    const identityParent = join(fixture.root, "identity-parent");
    const identityPath = join(identityParent, "identity");
    await mkdir(identityParent, { mode: 0o700 });
    await writeFile(identityPath, "disposable-test-identity\n", { mode: 0o600 });
    await replaceConfigValue(fixture, "SSH_IDENTITY_FILE", identityPath);
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nhold\n", "utf8");
    const supervisor = startSupervisor(fixture, { backoffs: "0.01,0.01,0.01,0.01,0.01", backoffGate: true });
    await waitForFile(join(fixture.fakeState, "backoff-ready"));

    const originalParent = `${identityParent}.original`;
    await rename(identityParent, originalParent);
    await symlink(originalParent, identityParent);
    await releaseBackoffGate(fixture);
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).exitClass).toBe("identity_untrusted_path");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await pathExists(join(fixture.fakeState, "args.2"))).toBe(false);
  }, 30_000);

  it("pauses before child 2 when identity content changes during backoff", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nhold\n", "utf8");
    const supervisor = startSupervisor(fixture, { backoffs: "0.01,0.01,0.01,0.01,0.01", backoffGate: true });
    await waitForFile(join(fixture.fakeState, "backoff-ready"));

    await writeFile(fixture.identity, "changed-disposable-test-identity\n", { mode: 0o600 });
    await releaseBackoffGate(fixture);
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).exitClass).toBe("identity_changed");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await pathExists(join(fixture.fakeState, "args.2"))).toBe(false);
  }, 30_000);

  it("keeps parsed runtime values stable and pauses when runtime config changes during backoff", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nhold\n", "utf8");
    const supervisor = startSupervisor(fixture, { backoffs: "0.01,0.01,0.01,0.01,0.01", backoffGate: true });
    await waitForFile(join(fixture.fakeState, "backoff-ready"));

    await replaceConfigValue(fixture, "REMOTE_PORT", "15434");
    await releaseBackoffGate(fixture);
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect((await readStatus(fixture)).exitClass).toBe("runtime_config_changed");
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(1);
    expect(await pathExists(join(fixture.fakeState, "args.2"))).toBe(false);
  }, 30_000);

  it("revalidates an unchanged retry and launches child 2 with the exact forward contract", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nexit:255\n", "utf8");
    const supervisor = startSupervisor(fixture, {
      backoffs: "0.01,0.01,0.01,0.01,0.01",
      maxChildExits: 2,
    });

    expect((await waitForExit(supervisor)).code).toBe(0);
    expect(Number(await readFile(join(fixture.fakeState, "child-attempts"), "utf8"))).toBe(2);
    for (const attempt of [1, 2]) {
      const renderedArguments = (await readFile(join(fixture.fakeState, `args.${attempt}`), "utf8")).trim().split("\n");
      expectExactForwardContract(renderedArguments);
    }
  }, 30_000);

  it("quarantines a dead owner, rejects a live duplicate, and removes only its own token", async () => {
    const fixture = await createFixture("hold");
    const staleLock = join(fixture.state, "owner.lock");
    await writeOwnerLock(staleLock, 999999, "dead-owner", "0".repeat(64));

    const owner = startSupervisor(fixture);
    const running = await waitForStatus(fixture, (status) => status.state === "running");
    const originalToken = running.ownerToken;
    const duplicate = startSupervisor(fixture);
    const duplicateResult = await waitForExit(duplicate);

    expect(duplicateResult.code).toBe(0);
    expect(processIsAlive(owner.pid!)).toBe(true);
    expect((await readStatus(fixture)).ownerToken).toBe(originalToken);
    const quarantines = (await readdir(fixture.state)).filter((name) => name.startsWith("owner.lock.quarantine."));
    expect(quarantines).toHaveLength(1);
    expect((await stat(join(fixture.state, quarantines[0]))).mode & 0o777).toBe(0o600);
    expect(await readFile(fixture.log, "utf8")).toContain("event=live_owner_rejected");

    owner.kill("SIGTERM");
    expect((await waitForExit(owner)).code).toBe(0);
    expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
    expect((await readStatus(fixture)).state).toBe("stopped");
  });

  it("rejects an exact live initializing owner without signalling it", async () => {
    const fixture = await createFixture();
    const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
    runningProcesses.add(unrelated);
    await waitFor(() => processIsAlive(unrelated.pid!));
    const lock = join(fixture.state, "owner.lock");
    await writeOwnerLock(lock, unrelated.pid!, "unrelated-live-owner", processStartIdentity(unrelated.pid!));

    const contender = startSupervisor(fixture);
    expect((await waitForExit(contender)).code).toBe(0);
    expect(processIsAlive(unrelated.pid!)).toBe(true);
    expect(await readFile(lock, "utf8")).toContain("token=unrelated-live-owner\n");
  });

  it("publishes initializing ownership atomically under deterministic concurrent acquisition", async () => {
    const fixture = await createFixture("hold");
    // Hold the winner between immutable initializing publication and its ready
    // record so the contender exercises the former mkdir-before-metadata race.
    const first = startSupervisor(fixture, { ownerInitDelay: 0.1 });
    await waitForFile(join(fixture.state, "owner.lock"));
    const second = startSupervisor(fixture, { ownerContentionTicks: 5 });

    expect((await waitForExit(second)).code).toBe(0);
    await waitForStatus(fixture, (status) => status.state === "running");
    expect(Number(await waitForFile(join(fixture.fakeState, "child-attempts")))).toBe(1);
    expect(findFixtureProcesses(fixture.root)).toHaveLength(1);

    first.kill("SIGTERM");
    expect((await waitForExit(first)).code).toBe(0);
    expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
  });

  it("quarantines a PID-reused stale claim without signalling the unrelated process", async () => {
    const fixture = await createFixture("hold");
    const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
    runningProcesses.add(unrelated);
    await waitFor(() => processIsAlive(unrelated.pid!));
    await writeOwnerLock(join(fixture.state, "owner.lock"), unrelated.pid!, "reused-pid", "f".repeat(64));

    const supervisor = startSupervisor(fixture);
    await waitForStatus(fixture, (status) => status.state === "running");
    expect(processIsAlive(unrelated.pid!)).toBe(true);
    expect((await readdir(fixture.state)).filter((name) => name.startsWith("owner.lock.quarantine."))).toHaveLength(1);

    supervisor.kill("SIGTERM");
    expect((await waitForExit(supervisor)).code).toBe(0);
    expect(processIsAlive(unrelated.pid!)).toBe(true);
  });

  it("bounds contention on an incomplete lock without quarantine or a duplicate child", async () => {
    const fixture = await createFixture("hold");
    const incompleteLock = join(fixture.state, "owner.lock");
    await writeFile(incompleteLock, "", { mode: 0o600 });
    const supervisor = startSupervisor(fixture, { ownerContentionTicks: 2 });

    expect((await waitForExit(supervisor)).code).toBe(0);
    expect(await pathExists(incompleteLock)).toBe(true);
    expect((await readdir(fixture.state)).filter((name) => name.startsWith("owner.lock.quarantine."))).toEqual([]);
    expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
    expect(findFixtureProcesses(fixture.root)).toEqual([]);
  });

  it("rejects token and inode replacement while preserving one live owner and exact cleanup", async () => {
    const fixture = await createFixture("hold");
    const owner = startSupervisor(fixture);
    const status = await waitForStatus(
      fixture,
      (snapshot) => snapshot.state === "running" && snapshot.healthCode === 200,
    );
    const lock = join(fixture.state, "owner.lock");
    const original = await readFile(lock, "utf8");

    // Mutate content on the same inode, then replace the pathname with a new
    // inode. Neither identity change may let a contender create a child.
    await writeFile(lock, original.replace(`token=${status.ownerToken}`, "token=replaced-token"), { mode: 0o600 });
    const tokenContender = startSupervisor(fixture);
    expect(
      (await waitForExit(tokenContender).catch((error) => Promise.reject(new Error(`token contender: ${error}`)))).code,
    ).toBe(0);
    await writeFile(lock, original, { mode: 0o600 });

    const savedLock = join(fixture.state, "owner.lock.saved");
    await rename(lock, savedLock);
    await copyFile(savedLock, lock);
    await chmod(lock, 0o600);
    const inodeContender = startSupervisor(fixture);
    expect(
      (await waitForExit(inodeContender).catch((error) => Promise.reject(new Error(`inode contender: ${error}`)))).code,
    ).toBe(0);
    await rm(lock);
    await rename(savedLock, lock);

    expect(processIsAlive(owner.pid!)).toBe(true);
    expect(findFixtureProcesses(fixture.root)).toHaveLength(1);
    owner.kill("SIGTERM");
    expect((await waitForExit(owner).catch((error) => Promise.reject(new Error(`owner stop: ${error}`)))).code).toBe(0);
    expect(await pathExists(lock)).toBe(false);
    expect(findFixtureProcesses(fixture.root)).toEqual([]);
    expect((await readdir(fixture.state)).filter((name) => name.startsWith("owner.ready."))).toEqual([]);
    expect((await readdir(fixture.state)).filter((name) => name.startsWith(".owner-claim."))).toEqual([]);
  });

  it("retains only the newest five verified stale-owner quarantines", async () => {
    const fixture = await createFixture("exit:255");
    for (let index = 0; index < 7; index += 1) {
      await writeFile(join(fixture.state, `owner.lock.quarantine.000000000${index}.retained`), `stale=${index}\n`, {
        mode: 0o600,
      });
    }
    await writeOwnerLock(join(fixture.state, "owner.lock"), 900001, "new-stale", "0".repeat(64));
    const supervisor = startSupervisor(fixture, { maxChildExits: 1, quickStartLimit: 99, quarantineLimit: 5 });
    expect((await waitForExit(supervisor)).code).toBe(0);
    const quarantines = (await readdir(fixture.state)).filter((name) => name.startsWith("owner.lock.quarantine."));
    expect(quarantines).toHaveLength(5);
    for (const name of quarantines) expect((await stat(join(fixture.state, name))).mode & 0o777).toBe(0o600);
  }, 60_000);

  it("records a verified child process-group handshake before exact deliberate cleanup", async () => {
    for (let iteration = 0; iteration < 1; iteration += 1) {
      const fixture = await createFixture("hold-with-child");
      const supervisor = startSupervisor(fixture);
      const status = await waitForStatus(fixture, (snapshot) => snapshot.state === "running");
      expect(status.childPid).toBeTypeOf("number");
      expect(status.childPgid).toBe(status.childPid);
      expect(readProcessGroup(status.childPid!)).toBe(status.childPgid);
      const nestedPid = Number(await waitForFile(join(fixture.fakeState, "nested-pid")));

      supervisor.kill("SIGTERM");
      expect((await waitForExit(supervisor)).code).toBe(0);
      expect(processIsAlive(status.childPid!)).toBe(false);
      expect(processIsAlive(nestedPid)).toBe(false);
      expect((await readStatus(fixture)).exitClass).toBe("deliberate_stop");
    }
  }, 30_000);

  it("exits nonzero and leaves no child or lock when the PGID handshake fails", async () => {
    const fixture = await createFixture("hold");
    const supervisor = startSupervisor(fixture, { handshakeFail: true, handshakeTicks: 3 });
    const result = await waitForExit(supervisor);
    const status = await readStatus(fixture);

    expect(result.code).toBe(70);
    expect(status.state).toBe("crashed");
    expect(status.exitClass).toBe("wrapper_error");
    expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
    expect(findFixtureProcesses(fixture.root)).toEqual([]);
  }, 30_000);

  it.each([
    ["exit:0", "exit_0"],
    ["exit:255", "exit_255"],
    ["signal:15", "signal_15"],
  ])(
    "classifies unexpected child behavior %s as %s",
    async (mode, expectedClass) => {
      const fixture = await createFixture(mode);
      const supervisor = startSupervisor(fixture, { maxChildExits: 1 });
      expect((await waitForExit(supervisor)).code).toBe(0);
      const status = await readStatus(fixture);
      expect(status.state).toBe("paused_test_complete");
      expect(status.exitClass).toBe(expectedClass);
    },
    30_000,
  );

  it("uses bounded backoff and resets the attempt after a stable child", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.fakeState, "sequence"), "exit:255\nexit:255\nexit:255\n", "utf8");
    const fast = startSupervisor(fixture, {
      backoffs: "0.01,0.02,0.03,0.04,0.05",
      maxChildExits: 3,
    });
    expect((await waitForExit(fast)).code).toBe(0);
    const firstLog = await readFile(fixture.log, "utf8");
    expect(firstLog).toContain("backoff_seconds=0.01");
    expect(firstLog).toContain("backoff_seconds=0.02");
    expect(firstLog).toContain("backoff_seconds=0.03");

    const stableFixture = await createFixture();
    await writeFile(join(stableFixture.fakeState, "sequence"), "sleep:1.1:255\nexit:255\n", "utf8");
    const stable = startSupervisor(stableFixture, {
      backoffs: "0.01,0.02,0.03,0.04,0.05",
      maxChildExits: 2,
      stableSeconds: 1,
    });
    const stableResult = await waitForExit(stable);
    const stableDebug = {
      result: stableResult,
      status: await readStatus(stableFixture),
      log: await readFile(stableFixture.log, "utf8"),
    };
    expect(stableResult.code, JSON.stringify(stableDebug, null, 2)).toBe(0);
    const stableLog = await readFile(stableFixture.log, "utf8");
    expect(stableLog).toContain("event=stable_child_reset");
    expect((await readStatus(stableFixture)).attempt).toBe(1);
  }, 30_000);

  it("persists wrapper start history so a launchd restart cannot reset cooldown", async () => {
    const fixture = await createFixture("exit:255");
    const sharedOptions = {
      backoffs: "0.01,0.01,0.01,0.01,0.01",
      maxChildExits: 1,
      quickStartLimit: 2,
      cooldownSeconds: 1,
    };
    const first = startSupervisor(fixture, sharedOptions);
    expect((await waitForExit(first)).code).toBe(0);

    const startedAt = Date.now();
    const second = startSupervisor(fixture, sharedOptions);
    expect((await waitForExit(second)).code).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(await readFile(fixture.log, "utf8")).toContain("event=restart_storm_cooldown");
  }, 30_000);

  it("rate-limits a quick child restart storm before allowing retries to resume", async () => {
    const fixture = await createFixture("exit:255");
    const startedAt = Date.now();
    const supervisor = startSupervisor(fixture, {
      backoffs: "0.01,0.01,0.01,0.01,0.01",
      maxChildExits: 2,
      quickStartLimit: 2,
      cooldownSeconds: 1,
    });

    expect((await waitForExit(supervisor)).code).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(await readFile(fixture.log, "utf8")).toContain("event=restart_storm_cooldown");
  }, 30_000);

  it.each([
    "wrong-owner",
    "wrong-mode",
    "direct-symlink",
    "parent-symlink",
  ])("fails closed on untrusted input path: %s", async (variant) => {
    const fixture = await createFixture();

    if (variant === "wrong-owner") {
      expect(await pathExists("/etc/ssh/ssh_config")).toBe(true);
      await replaceConfigValue(fixture, "SSH_CONFIG_FILE", "/private/etc/ssh/ssh_config");
      await expectPausedFatal(fixture, "ssh_config_owner");
    } else if (variant === "wrong-mode") {
      await chmod(fixture.sshConfig, 0o644);
      await expectPausedFatal(fixture, "ssh_config_permissions");
    } else if (variant === "direct-symlink") {
      const realSshConfig = `${fixture.sshConfig}.real`;
      await rename(fixture.sshConfig, realSshConfig);
      await symlink(realSshConfig, fixture.sshConfig);
      await expectPausedFatal(fixture, "ssh_config_untrusted_path");
    } else {
      const trustedParent = join(fixture.root, "trusted-parent");
      const linkedParent = join(fixture.root, "linked-parent");
      await mkdir(trustedParent, { mode: 0o700 });
      const linkedIdentity = join(trustedParent, "identity");
      await writeFile(linkedIdentity, "disposable\n", { mode: 0o600 });
      await symlink(trustedParent, linkedParent);
      await replaceConfigValue(fixture, "SSH_IDENTITY_FILE", join(linkedParent, "identity"));
      await expectPausedFatal(fixture, "identity_untrusted_path");
    }
  });

  it("never chmods an untrusted existing state path and rejects direct or parent state symlinks", async () => {
    const wrongMode = await createFixture();
    await chmod(wrongMode.state, 0o755);
    const wrongModeResult = await waitForExit(startSupervisor(wrongMode));
    expect(wrongModeResult.code).toBe(0);
    expect((await stat(wrongMode.state)).mode & 0o777).toBe(0o755);
    expect(await pathExists(join(wrongMode.state, "status.json"))).toBe(false);

    const direct = await createFixture();
    const actualState = `${direct.state}.actual`;
    await rename(direct.state, actualState);
    await symlink(actualState, direct.state);
    expect((await waitForExit(startSupervisor(direct))).code).toBe(0);
    expect((await lstat(direct.state)).isSymbolicLink()).toBe(true);
    expect(await pathExists(join(actualState, "status.json"))).toBe(false);

    const parent = await createFixture();
    const actualParent = join(parent.root, "actual-state-parent");
    const linkedParent = join(parent.root, "linked-state-parent");
    await mkdir(actualParent, { mode: 0o700 });
    await mkdir(join(actualParent, "state"), { mode: 0o700 });
    await symlink(actualParent, linkedParent);
    const linkedFixture = { ...parent, state: join(linkedParent, "state") };
    expect((await waitForExit(startSupervisor(linkedFixture))).code).toBe(0);
    expect(await pathExists(join(actualParent, "state", "status.json"))).toBe(false);
  });

  it("derives USER and LOGNAME for the sparse child environment when both are absent", async () => {
    const fixture = await createFixture("exit:255");
    const supervisor = startSupervisor(fixture, { maxChildExits: 1, omitUserIdentity: true });
    expect((await waitForExit(supervisor)).code).toBe(0);
    const expectedUser = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).stdout.trim();
    const environment = await readFile(join(fixture.fakeState, "env.1"), "utf8");
    expect(environment).toContain(`USER=${expectedUser}\n`);
    expect(environment).toContain(`LOGNAME=${expectedUser}\n`);
  }, 30_000);

  it("keeps status and logs atomic, bounded to metadata keys, and child environment sparse", async () => {
    const fixture = await createFixture("exit:255");
    const supervisor = startSupervisor(fixture, {
      backoffs: "0.01,0.01,0.01,0.01,0.01",
      maxChildExits: 3,
    });
    const parsedSnapshots: StatusSnapshot[] = [];
    while (supervisor.exitCode === null && supervisor.signalCode === null) {
      try {
        parsedSnapshots.push(JSON.parse(await readFile(join(fixture.state, "status.json"), "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(2);
    }
    await waitForExit(supervisor);
    const statusText = await readFile(join(fixture.state, "status.json"), "utf8");
    const logText = await readFile(fixture.log, "utf8");
    const combined = `${statusText}\n${logText}`;
    expect(parsedSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of parsedSnapshots) {
      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot).toHaveProperty("healthCode");
      expect(snapshot).toHaveProperty("healthDurationMs");
      expect(snapshot).toHaveProperty("configFingerprint");
      expect(snapshot.healthCode === null || snapshot.healthCode === 200).toBe(true);
      expect(snapshot.healthDurationMs === null || snapshot.healthDurationMs === 123).toBe(true);
      expect(snapshot.configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }

    const allowedLogKeys = new Set([
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
    for (const line of logText.trim().split("\n")) {
      for (const field of line.split(" ")) expect(allowedLogKeys).toContain(field.split("=", 1)[0]);
    }
    for (const forbidden of [
      "private-relay.example",
      "do-not-log-identity",
      "do-not-log-ssh-config",
      "do-not-log-health.example",
      "15432",
      "15433",
      "-R",
      "SSH_IDENTITY_FILE",
      "prompt",
      "credential",
      "payload",
    ]) {
      expect(combined).not.toContain(forbidden);
    }

    const envText = await readFile(join(fixture.fakeState, "env.1"), "utf8");
    expect(envText).not.toContain("SSH_AUTH_SOCK=");
    expect(envText).not.toContain("TAKODE_RELAY_SUPERVISOR_TEST_CHILD=");
    const argsText = await readFile(join(fixture.fakeState, "args.1"), "utf8");
    for (const option of [
      "BatchMode=yes",
      "ConnectTimeout=10",
      "ServerAliveInterval=10",
      "ServerAliveCountMax=3",
      "ExitOnForwardFailure=yes",
      "TCPKeepAlive=no",
      "ControlMaster=no",
      "IdentityAgent=none",
      "StrictHostKeyChecking=yes",
    ]) {
      expect(argsText).toContain(option);
    }
    expect((await stat(join(fixture.state, "status.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.state)).mode & 0o777).toBe(0o700);
    const finalStatus: StatusSnapshot = JSON.parse(statusText);
    expect(finalStatus.healthCode).toBe(200);
    expect(finalStatus.healthDurationMs).toBe(123);
  }, 30_000);
});

async function createFixture(mode = "exit:255"): Promise<Fixture> {
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

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o700 });
}

function startSupervisor(
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

async function releaseBackoffGate(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.fakeState, "backoff-release"), "1\n", "utf8");
}

async function waitForExit(
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

async function waitForStatus(
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

async function readStatus(fixture: Fixture): Promise<StatusSnapshot> {
  return JSON.parse(await readFile(join(fixture.state, "status.json"), "utf8"));
}

async function replaceConfigValue(fixture: Fixture, key: string, value: string): Promise<void> {
  const source = await readFile(fixture.config, "utf8");
  await writeFile(fixture.config, source.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`), { mode: 0o600 });
}

async function expectPausedFatal(fixture: Fixture, exitClass: string): Promise<void> {
  const supervisor = startSupervisor(fixture, { maxChildExits: 1 });
  expect((await waitForExit(supervisor)).code).toBe(0);
  const status = await readStatus(fixture);
  expect(status.state).toBe("paused_fatal");
  expect(status.exitClass).toBe(exitClass);
  expect(await pathExists(join(fixture.fakeState, "child-attempts"))).toBe(false);
  expect(await pathExists(join(fixture.state, "owner.lock"))).toBe(false);
}

async function waitForFile(path: string): Promise<string> {
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStartIdentity(pid: number): string {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return createHash("sha256").update(`${pid}:${result.stdout.trim()}`).digest("hex");
}

function expectExactForwardContract(renderedArguments: string[]): void {
  const effective = spawnSync("/usr/bin/ssh", ["-G", ...renderedArguments], { encoding: "utf8" });
  expect(effective.status, effective.stderr).toBe(0);
  const forwards = effective.stdout.split("\n").filter((line) => /^(?:remote|local|dynamic)forward\s/.test(line));
  expect(forwards).toEqual(["remoteforward [127.0.0.1]:15432 [127.0.0.1]:15433"]);
  expect(effective.stdout).toContain("clearallforwardings no\n");
}

function expectEventMetadataLine(line: string): void {
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

async function snapshotEventLedger(fixture: Fixture, names?: string[]): Promise<Record<string, string>> {
  const selected = names ?? (await readdir(fixture.state)).filter((name) => /^events[.]log(?:[.].+)?$/.test(name));
  const snapshot: Record<string, string> = {};
  for (const name of selected) {
    const content = await readFile(join(fixture.state, name));
    snapshot[name] = `${content.byteLength}:${createHash("sha256").update(content).digest("hex")}`;
  }
  return snapshot;
}

async function writeOwnerLock(path: string, pid: number, token: string, startIdentity: string): Promise<void> {
  await writeFile(
    path,
    `${["protocol=1", "phase=initializing", `pid=${pid}`, `token=${token}`, `start_identity=${startIdentity}`].join(
      "\n",
    )}\n`,
    { mode: 0o600 },
  );
  await appendFile(path, `lock_inode=${(await stat(path)).ino}\n`, "utf8");
}

function readProcessGroup(pid: number): number {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

function findFixtureProcesses(root: string): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(root) && line.includes("fake-ssh-child.sh"))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter(Number.isFinite);
}

async function pathExists(path: string): Promise<boolean> {
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
