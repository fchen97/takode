import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runMemoryCommand } from "./memory-command.js";
import {
  noteMachines,
  stampExistingMemoryNotes,
  stampExistingMemoryNotesInOwnSpaces,
  stampNoteMachine,
} from "./memory-note-machines.js";
import { configureMachines } from "./remote-host/machines.js";

const execFileAsync = promisify(execFile);

const note = (fields: string[], body = "Body.") =>
  ["---", 'description: "Read when testing."', ...fields, "source:", "  - q-1", "---", "", body, ""].join("\n");

// A memory note's `machines:` list says which machines its facts come from, so
// readers on other machines can map paths and commands to their own environment.
describe("note machine stamps", () => {
  it("reads inline and block lists, and nothing from unstamped notes", () => {
    expect(noteMachines(note(["machines: [laptop, devbox]"]))).toEqual(["laptop", "devbox"]);
    expect(noteMachines(note(["machines:", "  - laptop", "  - devbox"]))).toEqual(["laptop", "devbox"]);
    expect(noteMachines(note(["type: knowledge"]))).toBeUndefined();
    expect(noteMachines("No frontmatter.")).toBeUndefined();
  });

  it("appends the writer's machine once, after `updated:`, rewriting block lists in place", () => {
    const stamped = stampNoteMachine(note(["type: knowledge", "updated: 2026-10-01"]), "laptop");
    expect(stamped.split("\n").slice(0, 5)).toEqual([
      "---",
      'description: "Read when testing."',
      "type: knowledge",
      "updated: 2026-10-01",
      "machines: [laptop]",
    ]);
    expect(stampNoteMachine(stamped, "laptop")).toBe(stamped);
    expect(noteMachines(stampNoteMachine(stamped, "devbox"))).toEqual(["laptop", "devbox"]);

    const block = stampNoteMachine(note(["machines:", "  - laptop", "type: knowledge"]), "devbox");
    expect(block).toContain("machines: [laptop, devbox]\ntype: knowledge\nsource:");
    expect(block).not.toContain("  - laptop");
  });

  it("keeps the previous list when a draft leaves the field out, and trusts a draft that has one", () => {
    const previous = note(["machines: [laptop]"]);
    expect(noteMachines(stampNoteMachine(note([]), "devbox", previous))).toEqual(["laptop", "devbox"]);
    expect(noteMachines(stampNoteMachine(note(["machines: [devbox]"]), "devbox", previous))).toEqual(["devbox"]);
    expect(stampNoteMachine("No frontmatter.", "devbox")).toBe("No frontmatter.");
  });
});

describe("memory write and commit stamp the session's machine", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memory-machines-"));
    configureMachines({
      local: () => ({
        name: "laptop",
        platform: "darwin",
        user: "ana",
        home: "/Users/ana",
      }),
      hostName: (hostId) => (hostId === "h1" ? "devbox" : null),
      hostDetails: () => null,
      sessionHostId: (sessionId) => ({ local: null, remote: "h1" })[sessionId],
    });
  });

  afterEach(async () => {
    configureMachines(null);
    await rm(root, { recursive: true, force: true });
  });

  const run = (args: string[], session?: string, file = "") =>
    runMemoryCommand(args, {
      defaults: { root },
      ...(session ? { session } : {}),
      readTextFile: async () => file,
    });
  const read = (path: string) => readFile(join(root, path), "utf-8");
  // Only the lock's holder may write or commit, so hand the lock to each writing session.
  const holdLock = async (session?: string) => {
    await run(["lock", "release"]);
    expect((await run(["lock", "acquire"], session)).exitCode).toBe(0);
  };

  it("stamps notes on write, keeping earlier machines, but not folder READMEs", async () => {
    await holdLock("local");

    await run(["write", "topic/a.md", "--file", "-"], "local", note(["type: knowledge"]));
    expect(noteMachines(await read("topic/a.md"))).toEqual(["laptop"]);

    // A session on another machine rewrites the note from a draft without the field.
    await holdLock("remote");
    await run(["read", "topic/a.md"], "remote");
    await run(["write", "topic/a.md", "--file", "-"], "remote", note(["type: knowledge"], "Edited."));
    expect(noteMachines(await read("topic/a.md"))).toEqual(["laptop", "devbox"]);

    await run(["write", "topic/README.md", "--file", "-"], "remote", '---\ndescription: "Read for topic."\n---\n');
    expect(await read("topic/README.md")).not.toContain("machines");

    // Without a known session there is no machine to record.
    await holdLock();
    await run(["write", "topic/b.md", "--file", "-"], undefined, note(["type: knowledge"]));
    expect(noteMachines(await read("topic/b.md"))).toBeUndefined();
  });

  it("stamps the committer's machine on notes a commit changes, except repairs", async () => {
    await holdLock("remote");
    // Edited directly in the repo, not through `memory write`.
    await mkdir(join(root, "topic"), { recursive: true });
    await writeFile(join(root, "topic", "a.md"), note(["type: knowledge"]));
    await writeFile(join(root, "topic", "README.md"), '---\ndescription: "Read for topic."\n---\n');
    const commit = await run(["commit", "--message", "Add", "--source", "q-1", "--memory-id", "topic/a.md"], "remote");
    expect(commit.exitCode).toBe(0);
    expect(noteMachines(await read("topic/a.md"))).toEqual(["devbox"]);

    await writeFile(join(root, "topic", "b.md"), note(["type: knowledge"]));
    await holdLock("local");
    await run(
      ["commit", "--message", "Fix", "--source", "q-1", "--memory-id", "topic/b.md", "--operation", "repair"],
      "local",
    );
    expect(noteMachines(await read("topic/b.md"))).toBeUndefined();
  });
});

// The one-time migration stamps notes written before stamps existed with the
// coordinator's machine, as one Git commit that can be reverted.
describe("stampExistingMemoryNotes", () => {
  let root: string;

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), "memory-machine-migration-")), "repo");
    await mkdir(join(root, "topic"), { recursive: true });
    await writeFile(join(root, "topic", "README.md"), '---\ndescription: "Read for topic."\n---\n');
    await writeFile(join(root, "topic", "old.md"), note(["type: knowledge", "updated: 2026-01-01"]));
    await writeFile(join(root, "topic", "stamped.md"), note(["type: knowledge", "machines: [devbox]"]));
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("add", "-A");
    await git("commit", "-q", "-m", "Seed");
  });

  afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  const git = async (...args: string[]) => String((await execFileAsync("git", ["-C", root, ...args])).stdout);
  const read = (path: string) => readFile(join(root, path), "utf-8");

  it("stamps unstamped notes in one repair commit, once, without touching `updated:`", async () => {
    const result = await stampExistingMemoryNotes("laptop", { root });
    expect(result).toMatchObject({ outcome: "stamped", notes: 1 });

    const old = await read("topic/old.md");
    expect(noteMachines(old)).toEqual(["laptop"]);
    expect(old).toContain("updated: 2026-01-01");
    expect(noteMachines(await read("topic/stamped.md"))).toEqual(["devbox"]);
    expect(await read("topic/README.md")).not.toContain("machines");

    expect(await git("status", "--short")).toBe("");
    const message = await git("log", "-1", "--format=%B");
    expect(message).toContain("Record that existing notes were written on laptop");
    expect(message).toContain("Memory-Operation: repair");
    expect(await git("rev-parse", "--short", "HEAD")).toContain(result.commit);
    // The lock is released and the marker records the run, so it never repeats.
    await expect(readFile(join(root, ".git", "takode-memory.lock", "owner.json"))).rejects.toThrow();
    expect(JSON.parse(await read(".git/takode-machine-stamps.json"))).toMatchObject({ machine: "laptop", notes: 1 });
    await writeFile(join(root, "topic", "later.md"), note(["type: knowledge"]));
    await git("add", "-A");
    await git("commit", "-q", "-m", "Later");
    expect(await stampExistingMemoryNotes("laptop", { root })).toMatchObject({
      outcome: "done",
      reason: "already run",
    });
    expect(noteMachines(await read("topic/later.md"))).toBeUndefined();

    // Reversible with Git.
    await git("revert", "--no-edit", result.commit!);
    expect(noteMachines(await read("topic/old.md"))).toBeUndefined();
  });

  it("leaves a dirty or locked repo alone and tries again next time", async () => {
    await writeFile(join(root, "topic", "old.md"), note(["type: knowledge"], "Pending edit."));
    expect(await stampExistingMemoryNotes("laptop", { root })).toMatchObject({
      outcome: "skipped",
      notes: 0,
    });
    expect(await read("topic/old.md")).toContain("Pending edit.");
    expect(noteMachines(await read("topic/old.md"))).toBeUndefined();
    await git("checkout", "--", "topic/old.md");

    await runMemoryCommand(["lock", "acquire", "--owner", "someone"], {
      defaults: { root },
      readTextFile: async () => "",
    });
    expect(await stampExistingMemoryNotes("laptop", { root })).toMatchObject({
      outcome: "skipped",
    });
    expect((await read(".git/takode-memory.lock/owner.json")).includes("someone")).toBe(true);
    await runMemoryCommand(["lock", "release"], {
      defaults: { root },
      readTextFile: async () => "",
    });

    expect(await stampExistingMemoryNotes("laptop", { root })).toMatchObject({
      outcome: "stamped",
      notes: 1,
    });
  });
});

// At server start the migration finds this server's repos through the usual space discovery.
describe("stampExistingMemoryNotesInOwnSpaces", () => {
  let home: string;
  const saved = {
    HOME: process.env.HOME,
    id: process.env.COMPANION_SERVER_ID,
    slug: process.env.COMPANION_SERVER_SLUG,
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "memory-machine-spaces-"));
    process.env.HOME = home;
    process.env.COMPANION_SERVER_ID = "server-1";
    process.env.COMPANION_SERVER_SLUG = "prod";
  });

  afterEach(async () => {
    for (const [key, value] of [
      ["HOME", saved.HOME],
      ["COMPANION_SERVER_ID", saved.id],
      ["COMPANION_SERVER_SLUG", saved.slug],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("stamps the notes of this server's default repo", async () => {
    const { workstreamMemoryService } = await import("./workstream-memory-service.js");
    const repo = await workstreamMemoryService.ensureRepo();
    expect(repo.root.startsWith(home)).toBe(true);
    await mkdir(join(repo.root, "topic"), { recursive: true });
    await writeFile(join(repo.root, "topic", "a.md"), note(["type: knowledge"]));
    const git = (...args: string[]) => execFileAsync("git", ["-C", repo.root, ...args]);
    await git("add", "-A");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "Seed");

    const results = await stampExistingMemoryNotesInOwnSpaces("laptop");
    expect(results).toEqual([
      expect.objectContaining({
        root: repo.root,
        outcome: "stamped",
        notes: 1,
      }),
    ]);
    expect(noteMachines(await readFile(join(repo.root, "topic", "a.md"), "utf-8"))).toEqual(["laptop"]);
  });

  // A process that once ran under another server identity (a test's mocked id read from a
  // leaked settings file) left index entries claiming this server's repos. They must not make
  // those repos look foreign, which would silently skip stamping them. The index is read in
  // directory order, so several stale identities make it near certain one is read before ours.
  it("stamps this server's repos even when stale index entries from other identities claim them", async () => {
    const { workstreamMemoryService } = await import("./workstream-memory-service.js");
    const roots: string[] = [];
    for (const sessionSpaceSlug of ["Takode", "Slack"]) {
      const repo = await workstreamMemoryService.ensureRepo({ sessionSpaceSlug });
      await mkdir(join(repo.root, "topic"), { recursive: true });
      await writeFile(join(repo.root, "topic", "a.md"), note(["type: knowledge"]));
      const git = (...args: string[]) => execFileAsync("git", ["-C", repo.root, ...args]);
      await git("add", "-A");
      await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "Seed");
      roots.push(repo.root);
    }
    for (const staleId of ["0-stale", "a-stale", "test-uuid", "zz-stale"]) {
      const dir = join(home, ".companion", "memory", ".servers", staleId);
      await mkdir(dir, { recursive: true });
      for (const [sessionSpaceSlug, root] of [
        ["Takode", roots[0]],
        ["Slack", roots[1]],
      ]) {
        const entry = { serverId: staleId, serverSlug: "prod", sessionSpaceSlug, root, updatedAt: "2026-09-11" };
        await writeFile(join(dir, `${sessionSpaceSlug}.json`), JSON.stringify(entry));
      }
    }

    const spaces = await workstreamMemoryService.spaces();
    expect(spaces.filter((space) => roots.includes(space.root)).map((space) => space.serverId)).toEqual([
      "server-1",
      "server-1",
    ]);
    const results = await stampExistingMemoryNotesInOwnSpaces("laptop");
    expect(results.map((result) => [result.root, result.outcome]).sort()).toEqual(
      roots.map((root) => [root, "stamped"]).sort(),
    );
  });
});
