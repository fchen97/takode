import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCliWriteServer, type CliWriteServer } from "./test-fixtures/cli-write-server-harness.js";

async function runStream(
  args: string[],
  env: Record<string, string | undefined>,
  stdinText?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const streamPath = fileURLToPath(new URL("../bin/stream.ts", import.meta.url));
  const child = spawn(process.execPath, [streamPath, ...args], {
    env: {
      ...env,
      BUN_INSTALL_CACHE_DIR:
        env.BUN_INSTALL_CACHE_DIR ||
        process.env.BUN_INSTALL_CACHE_DIR ||
        join(process.env.HOME || "", ".bun/install/cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  if (stdinText !== undefined) child.stdin?.write(stdinText);
  child.stdin?.end();
  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

// The stream CLI sends its commands to the Takode server, which alone keeps
// stream data. `home` is the server's HOME (where streams live); the CLI runs
// over a separate, empty HOME, as an agent on a remote host would.
describe("stream CLI", () => {
  let home: string;
  let cliHome: string;
  let server: CliWriteServer;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "stream-cli-"));
    cliHome = mkdtempSync(join(tmpdir(), "stream-cli-caller-"));
    server = await startCliWriteServer(home);
    env = {
      ...process.env,
      HOME: cliHome,
      COMPANION_PORT: String(server.port),
      COMPANION_SERVER_ID: "server-test",
      COMPANION_SESSION_ID: "session-test",
      TAKODE_REMOTE_HOST: undefined,
    };
  });

  afterEach(async () => {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  });

  function scopeFile(scope: string): string {
    const digest = createHash("sha1").update(scope).digest("hex").slice(0, 16);
    return join(home, ".companion", "streams", `${digest}.json`);
  }

  it("creates, updates, shows, searches, and archives a stream", async () => {
    const create = await runStream(
      [
        "create",
        "AI judging",
        "--summary",
        "4-lane monitor active",
        "--tags",
        "ml,judging",
        "--quest",
        "q-645",
        "--owner",
        "993",
        "--steering-mode",
        "leader-steered",
        "--pin",
        "canonical output root: /mnt/vast/judged",
        "--json",
      ],
      env,
    );
    expect(create.status).toBe(0);
    const created = JSON.parse(create.stdout) as { slug: string; current: { summary: string } };
    expect(created.slug).toBe("ai-judging");
    expect(created.current.summary).toBe("4-lane monitor active");

    const update = await runStream(
      [
        "update",
        "ai-judging",
        "--type",
        "contradiction",
        "--entry-file",
        "-",
        "--state",
        "Client and inference pool reports reconciled",
        "--source",
        "session:989:3077",
        "--session",
        "989",
        "--worker",
        "986",
        "--health",
        "healthy",
      ],
      env,
      "Client saw 0 healthy backends while inference worker verified 8/8 healthy.",
    );
    expect(update.status).toBe(0);
    expect(update.stdout).toContain("Updated stream");

    const show = await runStream(["show", "ai-judging"], env);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Current State:");
    expect(show.stdout).toContain("Client and inference pool reports reconciled");
    expect(show.stdout).toContain("[contradiction]");
    expect(show.stdout).toContain("source: session:989:3077");
    expect(show.stdout).toContain("quest:q-645");

    const search = await runStream(["search", "reconciled"], env);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain("ai-judging");

    const archive = await runStream(["archive", "ai-judging", "--reason", "done"], env);
    expect(archive.status).toBe(0);
    const list = await runStream(["list"], env);
    expect(list.stdout).toContain("No streams found.");
    const archived = await runStream(["list", "--archived"], env);
    expect(archived.stdout).toContain("ai-judging (archived)");
    // Everything was written by the server; the caller's machine keeps no copy.
    expect(existsSync(join(cliHome, ".companion", "streams"))).toBe(false);
  });

  // Without a reachable server, reads may answer from this machine's streams
  // (the server's own machine), but writes never touch them.
  it("reads this machine's streams when no server is named, and refuses writes", async () => {
    expect((await runStream(["create", "Local read", "--summary", "kept"], env)).status).toBe(0);
    const local = { ...env, HOME: home, COMPANION_PORT: undefined };

    const show = await runStream(["show", "local-read"], local);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("kept");

    const write = await runStream(["update", "local-read", "--entry", "offline"], local);
    expect(write.status).toBe(1);
    expect(write.stderr).toContain("No Takode server is configured");
  });

  // On a remote host the coordinator holds the only copy of the streams, so a
  // stale copy on that machine is never read, even when the server is away.
  it("never reads local streams on a remote host", async () => {
    expect((await runStream(["create", "Host stale", "--summary", "stale copy"], env)).status).toBe(0);
    const unreachablePort = String(server.port);
    await server.stop();
    const onHost = { ...env, HOME: home, COMPANION_PORT: unreachablePort, TAKODE_REMOTE_HOST: "1" };

    const show = await runStream(["show", "host-stale"], onHost);
    expect(show.status).toBe(1);
    expect(show.stderr).toContain("Cannot reach the Takode server");
    expect(show.stdout).not.toContain("stale copy");

    const unnamed = await runStream(["list"], { ...onHost, COMPANION_PORT: undefined });
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain("No Takode server is configured");
  });

  // A host session whose Takode variables did not reach it looks like a CLI with
  // no server named. With no streams of its own, it fails clearly and loading the
  // stream store never creates an empty one.
  it("fails clearly and creates nothing when no server is named and this machine keeps no streams", async () => {
    const show = await runStream(["list"], { ...env, COMPANION_PORT: undefined });
    expect(show.status).toBe(1);
    expect(show.stderr).toContain("keeps no streams of its own");
    expect(existsSync(join(cliHome, ".companion", "streams"))).toBe(false);
  });

  it("prints a compact handoff for reviewer usability checks", async () => {
    await runStream(["create", "Nebius salvage", "--summary", "Canonical artifact repaired", "--owner", "1014"], env);
    await runStream(
      [
        "update",
        "nebius-salvage",
        "--type",
        "artifact",
        "--entry",
        "Repaired canonical artifact promoted",
        "--artifact",
        "/mnt/vast/data/nebius_swe_rebench.lance",
        "--operational-status",
        "done",
      ],
      env,
    );

    const handoff = await runStream(["handoff", "nebius-salvage"], env);
    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toContain("Handoff for");
    expect(handoff.stdout).toContain("Canonical artifact repaired");
    expect(handoff.stdout).toContain("Operational status: done");
    expect(handoff.stdout).toContain("Owners: 1014");
  });

  it("rejects invalid confidence values before persisting an update", async () => {
    await runStream(["create", "Confidence check", "--summary", "active"], env);

    const update = await runStream(
      ["update", "confidence-check", "--entry", "Bad confidence", "--confidence", "maybe"],
      env,
    );

    expect(update.status).toBe(1);
    expect(update.stderr).toContain("--confidence must be one of");
  });

  it("fails on corrupt scope files without replacing the existing file", async () => {
    const scope = "server-test:explicit-corrupt";
    const create = await runStream(["create", "Corrupt CLI", "--scope", scope, "--summary", "preserved"], env);
    expect(create.status).toBe(0);
    const file = scopeFile(scope);
    writeFileSync(file, "{broken", "utf-8");

    const secondCreate = await runStream(["create", "Should not overwrite", "--scope", scope], env);
    expect(secondCreate.status).toBe(1);
    expect(secondCreate.stderr).toContain("Failed to load stream scope");
    expect(readFileSync(file, "utf-8")).toBe("{broken");
  });
});
