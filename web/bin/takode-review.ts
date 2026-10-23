import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  MAX_GUIDED_REVIEW_DIFF_BYTES,
  checkGuidedReviewCoverage,
  outlineGuidedReviewDiff,
  parseGuidedReviewDiff,
  parseGuidedReviewMapInput,
  type GuidedReviewRange,
} from "../shared/guided-review.js";
import { apiPost } from "./takode-core.js";

const execFileAsync = promisify(execFile);

export const REVIEW_HELP = `Usage: takode review <map.json> --thread <main|q-N> [--repo <dir>] [--worker <session>] [--json]
       takode review <map.json> --check [--repo <dir>]
       takode review --outline <base>..<head> [--repo <dir>]
       takode review --share <session> [--review <review-id>] --thread <main|q-N> [--json]

Publish a guided review of a git range into your own session: the user walks through its
stops, each showing the exact code from git, and answers its questions inline.
The map is JSON you write; Takode reads the diff of base..head from the repository itself
(--repo, default the current directory) and refuses a map that leaves any changed line out.
--check validates the map against the diff and prints coverage without publishing.
--outline lists each changed file's changed new-file line ranges, to help write the map.
The review keeps only its stops' code; the user opens the full change from git.
--share posts a review already published in your own session or a session you herd (its newest,
or the one --review names) into one of your threads. It needs no copy of the repository: the
copy keeps the saved code, and Full diff still reads git where the review was first published.
The user's answers in the shared copy come to you.

Map format (paths are repository-relative; lines are new-file line numbers, inclusive):
  {
    "base": "<rev>", "head": "<rev>",
    "title": "Short title of the change",
    "overview": "Markdown: what the change does and what you found",
    "stops": [
      { "tier": "decide", "title": "...", "note": "Markdown: why only the user can decide",
        "question": "Keep up to 4 requests?", "answers": ["Keep 4", "Cap at 2"],
        "code": [{ "path": "web/server/x.ts", "lines": [79, 118] }] },
      { "tier": "check", "title": "...", "note": "Why it deserves a careful look", "code": [...] },
      { "tier": "checked", "title": "...", "note": "The evidence it is fine", "code": [...] }
    ],
    "summaries": [{ "title": "Tests", "text": "Markdown summary", "paths": ["web/server/x.test.ts"] }]
  }
Every added or removed line must be in exactly one stop, or in a file listed by exactly one
summary. A code entry without "lines" covers the whole file. Answers come back to your session
as one message. The guided-review skill has the rules for choosing tiers.
`;

/** `takode review`: validate a review map against git and publish it as a guided review. */
export async function handleReview(base: string, args: string[]): Promise<void> {
  let mapPath: string | undefined;
  let threadKey: string | undefined;
  let repo = ".";
  let responsibleWorkerId: string | undefined;
  let json = false;
  let checkOnly = false;
  let outline: string | undefined;
  let shareFrom: string | undefined;
  let shareReviewId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--check") checkOnly = true;
    else if (["--thread", "--repo", "--worker", "--outline", "--share", "--review"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--outline") outline = value;
      else if (arg === "--share") shareFrom = value;
      else if (arg === "--review") shareReviewId = value;
      else if (arg === "--thread") threadKey = value;
      else if (arg === "--repo") repo = value;
      else responsibleWorkerId = value;
    } else if (!arg.startsWith("--") && !mapPath) mapPath = arg;
    else throw new Error(REVIEW_HELP);
  }
  if (shareFrom !== undefined) {
    if (!threadKey || mapPath) throw new Error(REVIEW_HELP);
    const shared = (await apiPost(base, "/takode/reviews/share", {
      from: shareFrom.replace(/^#/, ""),
      threadKey,
      ...(shareReviewId ? { reviewId: shareReviewId } : {}),
    })) as { reviewId: string; threadKey: string; title: string; questions: number };
    console.log(
      json
        ? JSON.stringify(shared)
        : `Shared guided review "${shared.title}" to ${shared.threadKey}: ${shared.questions} question${shared.questions === 1 ? "" : "s"}. Answers come to you.`,
    );
    return;
  }
  if (outline !== undefined) {
    const [baseRev, headRev] = outline.split("..");
    if (!baseRev || !headRev) throw new Error("--outline takes a range: <base>..<head>");
    const { diff } = await readGitRange(resolve(repo), baseRev, headRev);
    console.log(outlineGuidedReviewDiff(parseGuidedReviewDiff(diff)));
    return;
  }
  if (!mapPath || (!checkOnly && !threadKey)) throw new Error(REVIEW_HELP);

  const sourcePath = resolve(mapPath);
  let rawMap: unknown;
  try {
    rawMap = JSON.parse(await readFile(sourcePath, "utf-8"));
  } catch (error) {
    throw new Error(`Cannot read the map ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const input = parseGuidedReviewMapInput(rawMap);
  const { diff, range } = await readGitRange(resolve(repo), input.base, input.head);

  if (checkOnly) {
    const { problems, stats } = checkGuidedReviewCoverage(input, parseGuidedReviewDiff(diff));
    if (problems.length) throw new Error(`The review map does not match the change:\n- ${problems.join("\n- ")}`);
    const summarized = stats.additions + stats.deletions - stats.linesInStops;
    console.log(
      `Map OK: ${stats.files} files, +${stats.additions} -${stats.deletions}. ` +
        `${stats.linesInStops} changed lines in stops (decide ${stats.linesByTier.decide}, check ${stats.linesByTier.check}, checked ${stats.linesByTier.checked}), ${summarized} summarized.`,
    );
    return;
  }

  const receipt = (await apiPost(base, "/takode/reviews", {
    map: rawMap,
    diff,
    range,
    sourcePath,
    threadKey,
    ...(responsibleWorkerId ? { responsibleWorkerId } : {}),
  })) as {
    reviewId: string;
    threadKey: string;
    files: number;
    additions: number;
    deletions: number;
    linesInStops: number;
    questions: number;
  };
  console.log(
    json
      ? JSON.stringify(receipt)
      : `Published guided review to ${receipt.threadKey}: ${receipt.questions} question${receipt.questions === 1 ? "" : "s"}, ${receipt.files} files, ${receipt.linesInStops} lines in stops.`,
  );
}

/** The diff of base..head and the range's identity, read with git in `repo`. */
async function readGitRange(
  repo: string,
  baseRev: string,
  headRev: string,
): Promise<{ diff: string; range: GuidedReviewRange }> {
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
        maxBuffer: MAX_GUIDED_REVIEW_DIFF_BYTES * 2,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`git ${args[0]} failed in ${repo}: ${stderr || (error as Error).message}`);
    }
  };
  const base = (await git("rev-parse", "--verify", `${baseRev}^{commit}`)).trim();
  const head = (await git("rev-parse", "--verify", `${headRev}^{commit}`)).trim();
  const diff = await git("diff", "--no-color", "--no-ext-diff", "--find-renames", base, head);
  if (Buffer.byteLength(diff, "utf8") > MAX_GUIDED_REVIEW_DIFF_BYTES) {
    throw new Error("The diff is over 8 MiB; review a smaller range.");
  }
  const log = await git("log", "--reverse", "--format=%H%x09%s", `${base}..${head}`);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
  // A worktree's own folder name says little; name the repository its shared Git folder belongs to.
  // Absolute and symlink-resolved, like --show-toplevel below, so the same folder is not listed twice.
  const commonDir = (await git("rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
  const mainCheckout = basename(commonDir) === ".git" ? dirname(commonDir) : null;
  const name = mainCheckout ? basename(mainCheckout) : basename(commonDir).replace(/\.git$/, "");
  // Where the full change is read from later: this checkout, then the main one, which keeps the
  // commits if this worktree is removed.
  const toplevel = (await git("rev-parse", "--show-toplevel")).trim();
  const repoPaths = [...new Set([toplevel, ...(mainCheckout ? [mainCheckout] : [])])];
  return { diff, range: { repo: name, base, head, commits, repoPaths } };
}
