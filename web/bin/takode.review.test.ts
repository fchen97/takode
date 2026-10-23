import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A throwaway Git repository with two commits: base adds a.ts, head edits it and adds b.ts. */
async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "review-command-"));
  roots.push(root);
  const repo = join(root, "widgets");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await git("init", "-q");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  await writeFile(join(repo, "b.ts"), "export const d = 5;\n");
  await git("add", ".");
  await git("commit", "-qm", "feat: change b and add c");
  const map = {
    base: "HEAD~1",
    head: "HEAD",
    title: "Change b",
    overview: "Changes b and adds c and d.",
    stops: [
      {
        tier: "decide",
        title: "b changes",
        note: "b goes from 2 to 3.",
        question: "Change b?",
        answers: ["Yes", "No"],
        code: [{ path: "a.ts", lines: [2, 3] }],
      },
    ],
    summaries: [{ title: "New file", text: "Adds d.", paths: ["b.ts"] }],
  };
  const mapPath = join(root, "map.json");
  await writeFile(mapPath, JSON.stringify(map));
  return { root, repo, mapPath, map };
}

async function runTakode(args: string[], port?: number) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./takode.ts", import.meta.url)), ...args, ...(port ? ["--port", String(port)] : [])],
    {
      env: { ...process.env, COMPANION_SESSION_ID: "host", COMPANION_AUTH_TOKEN: "fixture-token" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

it("checks a map against the real git diff without publishing", async () => {
  const { repo, mapPath } = await makeRepo();
  const ok = await runTakode(["review", mapPath, "--check", "--repo", repo]);
  expect(ok.stderr).toBe("");
  expect(ok.stdout.trim()).toBe(
    "Map OK: 2 files, +3 -1. 3 changed lines in stops (decide 3, check 0, checked 0), 1 summarized.",
  );
});

it("outlines each changed file's line ranges to help write a map", async () => {
  const { repo } = await makeRepo();
  const result = await runTakode(["review", "--outline", "HEAD~1..HEAD", "--repo", repo]);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toEqual(["a.ts  +2 -1", "  2-3", "b.ts  +1 -0", "  1"]);
});

it("reports the lines a map leaves out", async () => {
  const { root, repo, map } = await makeRepo();
  const mapPath = join(root, "partial.json");
  await writeFile(mapPath, JSON.stringify({ ...map, summaries: [] }));
  const result = await runTakode(["review", mapPath, "--check", "--repo", repo]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("b.ts: added lines 1 are in no stop; add the file to a summary or a stop.");
});

/** Publishes a guided review through a local fixture server; returns the CLI result and the request body it sent. */
async function publishReview(args: string[]) {
  // All HTTP effects go to this local fixture server.
  let received: any;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/takode/me") return res.end(JSON.stringify({ sessionId: "host", isOrchestrator: true }));
    if (req.url !== "/api/takode/reviews") {
      res.statusCode = 404;
      return res.end("{}");
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.end(
      JSON.stringify({
        reviewId: "r1",
        threadKey: "q-7",
        files: 2,
        additions: 3,
        deletions: 1,
        linesInStops: 3,
        questions: 1,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const result = await runTakode(args, (server.address() as AddressInfo).port);
    return { result, received };
  } finally {
    server.close();
  }
}

it("publishes the map with the diff and range read from git", async () => {
  const { repo, mapPath, map } = await makeRepo();
  const { result, received } = await publishReview(["review", mapPath, "--thread", "q-7", "--repo", repo]);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).toBe("Published guided review to q-7: 1 question, 2 files, 3 lines in stops.");
  expect(received.map).toEqual(map);
  expect(received.threadKey).toBe("q-7");
  expect(received.diff).toContain("+export const c = 4;");
  expect(received.range).toMatchObject({ repo: "widgets", commits: [{ subject: "feat: change b and add c" }] });
  expect(received.range.base).toMatch(/^[0-9a-f]{40}$/);
  // The full change is read later from this checkout.
  expect(received.range.repoPaths).toEqual([await realpath(repo)]);
});

// Git reports the checkout with symlinks resolved, so a repository reached
// through a symlinked path (macOS's /var, or any link) must still be listed
// once, not once per spelling of the same folder.
it("lists a checkout reached through a symlink only once", async () => {
  const { root, repo, mapPath } = await makeRepo();
  const link = join(root, "widgets-link");
  await symlink(repo, link);
  const { result, received } = await publishReview(["review", mapPath, "--thread", "q-7", "--repo", link]);
  expect(result.stderr).toBe("");
  expect(received.range.repoPaths).toEqual([await realpath(repo)]);
});

it("shares a review from another session into a thread without any repository", async () => {
  // Only the fixture server is contacted; no git repository is involved.
  let received: any;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/takode/me") return res.end(JSON.stringify({ sessionId: "host", isOrchestrator: true }));
    if (req.url !== "/api/takode/reviews/share") {
      res.statusCode = 404;
      return res.end("{}");
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.end(JSON.stringify({ reviewId: "r2", threadKey: "q-7", title: "Change b", questions: 1 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const result = await runTakode(
      ["review", "--share", "#3178", "--thread", "q-7"],
      (server.address() as AddressInfo).port,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe('Shared guided review "Change b" to q-7: 1 question. Answers come to you.');
    expect(received).toEqual({ from: "3178", threadKey: "q-7" });
  } finally {
    server.close();
  }
});
