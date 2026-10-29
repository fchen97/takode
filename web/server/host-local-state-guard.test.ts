/**
 * Host-local state guard: code that runs on a Takode host takes Takode
 * settings and data from the coordinator, never from this machine's
 * `~/.companion` (CLAUDE.md, "Takode config and data live on the coordinator").
 *
 * Host-side files are the agent CLIs and helpers in `bin/` (installed on every
 * host) and the `takode node` agent's entry modules. The test lists every way
 * they reach `~/.companion` directly: a path they name themselves, or a server
 * module they import that names one or keeps coordinator data. Each one must be
 * in the inventory below with the reason it is allowed, usually because it is
 * a fact of this machine (where tools and checkouts live, its name, its own
 * credentials) rather than Takode configuration. A new entry fails until it is
 * either moved to the coordinator or added here with its reason; an entry that
 * no longer exists fails too, so the inventory stays accurate.
 *
 * The check covers host-side files and their direct imports, not everything
 * those modules import in turn: deeper code is reviewed against the rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_DIR = resolve(__dirname, "..");

/** Host-side entry modules outside `bin/`. */
const HOST_SERVER_MODULES = ["server/remote-host/host-agent.ts", "server/remote-host/host-operations.ts"];

/**
 * Modules that keep coordinator data without naming its paths themselves, so
 * importing them counts like importing the store they wrap.
 */
const COORDINATOR_DATA_WRAPPERS = ["server/stream-command.ts", "server/workstream-memory-service.ts"];

const LOCAL_READ_FALLBACK =
  "Read fallback to this machine's store, only when no server answers on the server's own machine and never on a " +
  "remote host (TAKODE_REMOTE_HOST); every write goes to the server";
const CODEX_QUEST_WORKER =
  "The server's own Codex Quest command worker writes the store directly; other quest reads fall back here only " +
  "when no server answers on the server's own machine, never on a remote host";
const SESSION_CREDENTIALS = "Session credentials the server wrote on this machine: identity, not configuration";
const SERVER_LAUNCHER = "Starts and manages the Takode server on this machine; it is not run for another coordinator";
const LATENCY_LOGS = "Latency logs of commands run on this machine (diagnostics)";
const LANDING_RUNNERS =
  "Starts the landing queue's runners on this machine, with their logs under its ~/.companion/landing like `takode land`";

/** Every allowed direct reach into `~/.companion`, keyed `<file>: <entry>` or `<file> -> <module>`. */
const INVENTORY: Record<string, string> = {
  "bin/agent-browser.ts: bin": "Skips Takode's own wrapper directory to find the real agent-browser on this machine",
  "bin/agent-browser.ts -> server/cli-wrapper-paths.ts": "Location of Takode's wrapper directory on this machine",
  "bin/cli.ts: logs": SERVER_LAUNCHER,
  "bin/cli.ts -> server/migration.ts": SERVER_LAUNCHER,
  "bin/cli.ts -> server/service.ts": SERVER_LAUNCHER,
  "bin/cli-latency.ts -> server/latency-log.ts": LATENCY_LOGS,
  "bin/takode-latency.ts -> server/latency-log.ts": LATENCY_LOGS,
  "bin/memory.ts -> server/memory-command.ts": LOCAL_READ_FALLBACK,
  "bin/memory.ts -> server/settings-manager.ts":
    "Reads (never writes) the slug of the server on this machine, for the local read fallback",
  "bin/stream.ts: streams":
    "Checks, without creating it, whether this machine keeps streams before the local read fallback loads the store",
  "bin/stream.ts -> server/stream-command.ts": LOCAL_READ_FALLBACK,
  "bin/quest.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest.ts -> server/session-names.ts": CODEX_QUEST_WORKER,
  "bin/quest-codex-local.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest-commit-links.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest-image-input.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest-ownership-command.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest-ownership-command.ts -> server/session-names.ts": CODEX_QUEST_WORKER,
  "bin/quest-status-mutation.ts -> server/quest-store.ts": CODEX_QUEST_WORKER,
  "bin/quest-companion-credentials.ts: session-auth.json": SESSION_CREDENTIALS,
  "bin/quest-help.ts: session-auth.json": SESSION_CREDENTIALS,
  "bin/takode-core.ts: session-auth.json": SESSION_CREDENTIALS,
  "bin/quest-codex-rpc.ts -> server/codex-sidecar-auth.ts":
    "Credentials for the Takode server on this machine, used by a standalone Codex task",
  "bin/takode-sidecar-client.ts: integrations":
    "Discovery file through which a standalone Codex task finds the Takode server on this machine",
  "bin/takode-sidecar-client.ts -> server/codex-sidecar-auth.ts":
    "Credentials for the Takode server on this machine, used by a standalone Codex task",
  "bin/takode-land.ts: landing": "Checkouts, scratch space and logs of landing runs on this machine",
  "bin/takode-node.ts -> server/landing-runner-launcher.ts": LANDING_RUNNERS,
  "bin/takode-node.ts -> server/machine-identity.ts":
    "This machine's name belongs to the machine; the node reports it to the coordinator",
  "bin/takode-node.ts -> server/quest-integration.ts":
    "Installs CLI wrappers and skills from this machine's Takode checkout (code, not configuration)",
  "bin/takode-node.ts -> server/quest-journey-phases.ts":
    "Installs Quest Journey phase briefs from this machine's Takode checkout (code, not configuration)",
  "server/remote-host/host-agent.ts -> server/cli-launcher-codex.ts":
    "Prepares Codex launches with this machine's Codex install and session homes; settings come from the coordinator",
  "server/remote-host/host-agent.ts -> server/latency-log.ts": LATENCY_LOGS,
  "server/remote-host/host-agent.ts -> server/machine-identity.ts":
    "Reports this machine's platform, user and home to the coordinator",
  "server/remote-host/host-agent.ts -> server/path-resolver.ts": "Finds programs on this machine's PATH",
  "server/remote-host/host-operations.ts -> server/git-utils.ts":
    "Session worktrees are checkouts on this machine, under its ~/.companion/worktrees",
  "server/remote-host/host-operations.ts -> server/migration.ts": "Recreates a session's checkout on this machine",
  "server/remote-host/host-operations.ts -> server/landing-runner-launcher.ts": LANDING_RUNNERS,
  "server/remote-host/host-operations.ts -> server/path-resolver.ts":
    "Finds programs on this machine's PATH for the New Session backend picker",
  "server/remote-host/host-operations.ts -> server/user-content-install.ts":
    "This machine's copy of the user's skills, which files Takode wrote here, and backups of files it replaced; the content itself comes from the coordinator",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(join(WEB_DIR, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-fixtures" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Source without comments, so prose that mentions `~/.companion` does not count. */
function code(file: string): string {
  return readFileSync(join(WEB_DIR, file), "utf-8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

/** The `~/.companion` entries a file names, e.g. `settings.json` or `(root)` for the directory itself. */
function companionEntries(file: string): string[] {
  const source = code(file);
  const entries = new Set<string>();
  for (const match of source.matchAll(/["'`]\.companion["'`](\s*,\s*["'`]([^"'`]+)["'`])?/g)) {
    entries.add(match[2] ?? "(root)");
  }
  for (const match of source.matchAll(/\.companion\/([\w.${}-]+)/g)) entries.add(match[1]!);
  return [...entries];
}

/** Modules a file loads at runtime: value imports and awaited dynamic imports, not type-only ones. */
function valueImports(file: string): string[] {
  const source = readFileSync(join(WEB_DIR, file), "utf-8");
  const pattern =
    /^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+["'](\.[^"']+)["']|(?:await|void|return)\s+import\(\s*["'](\.[^"']+)["']\s*\)/gm;
  return [...source.matchAll(pattern)].map((match) =>
    relative(WEB_DIR, resolve(WEB_DIR, dirname(file), match[1] ?? match[2]!).replace(/\.js$/, ".ts")),
  );
}

function hostLocalReaches(): Set<string> {
  const companionModules = new Set([
    ...sourceFiles("server").filter((file) => companionEntries(file).length > 0),
    ...COORDINATOR_DATA_WRAPPERS,
  ]);
  const reaches = new Set<string>();
  for (const file of [...sourceFiles("bin"), ...HOST_SERVER_MODULES]) {
    for (const entry of companionEntries(file)) reaches.add(`${file}: ${entry}`);
    for (const target of valueImports(file)) {
      if (companionModules.has(target)) reaches.add(`${file} -> ${target}`);
    }
  }
  return reaches;
}

describe("host-local state guard", () => {
  it("lists every way host-side code reaches ~/.companion, with the reason it is allowed", () => {
    const actual = hostLocalReaches();
    const unlisted = [...actual].filter((key) => !(key in INVENTORY)).sort();
    const gone = Object.keys(INVENTORY)
      .filter((key) => !actual.has(key))
      .sort();
    expect(
      unlisted,
      "Host-side code reaches ~/.companion in a new way. Takode settings and data come from the coordinator " +
        "(settings pushed over the host link, the API through the node's proxy). Move it there, or, if it is a " +
        "genuine fact of this machine, add it to INVENTORY with the reason.",
    ).toEqual([]);
    expect(gone, "These INVENTORY entries no longer exist; remove them.").toEqual([]);
  });

  // The coordinator-only modules that matter most must stay detected, so a
  // change in detection cannot silently empty the inventory.
  it("detects reaches into coordinator stores", () => {
    const actual = hostLocalReaches();
    expect(actual.has("bin/memory.ts -> server/settings-manager.ts")).toBe(true);
    expect(actual.has("bin/quest.ts -> server/quest-store.ts")).toBe(true);
    expect(actual.has("bin/stream.ts -> server/stream-command.ts")).toBe(true);
    expect(companionEntries("server/settings-manager.ts")).toContain("settings-${port}.json");
  });
});
