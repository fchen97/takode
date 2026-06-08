import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPrivateDefaultInstructions } from "./private-instructions.js";

const tempDirs: string[] = [];

async function makePrivateDocsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "takode-private-docs-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPrivateDefaultInstructions", () => {
  it("returns undefined when no configured private instruction doc exists", async () => {
    // Missing local docs should be a soft no-op so fresh Takode installs launch normally.
    const dir = await makePrivateDocsDir();

    await expect(loadPrivateDefaultInstructions({ privateDocsDir: dir })).resolves.toBeUndefined();
  });

  it("loads the conventional default guidance doc when no manifest exists", async () => {
    // The fallback lets a user opt in with one markdown file and no JSON manifest.
    const dir = await makePrivateDocsDir();
    await writeFile(join(dir, "default-agent-guidance.md"), "Always confirm dangerous operations.", "utf-8");

    const result = await loadPrivateDefaultInstructions({ privateDocsDir: dir });

    expect(result).toContain("## Private Default Instructions");
    expect(result).toContain("### default-agent-guidance.md");
    expect(result).toContain("Always confirm dangerous operations.");
  });

  it("uses a manifest include list without injecting unrelated private docs", async () => {
    // A manifest keeps sensitive docs such as cluster or Condor notes private until explicitly included.
    const dir = await makePrivateDocsDir();
    await writeFile(
      join(dir, "default-instructions.json"),
      JSON.stringify({ include: ["dangerous-operation-safeguard.md"] }),
      "utf-8",
    );
    await writeFile(join(dir, "dangerous-operation-safeguard.md"), "Ask first before broad rm commands.", "utf-8");
    await writeFile(join(dir, "condor.md"), "CONDOR_PRIVATE_MARKER", "utf-8");

    const result = await loadPrivateDefaultInstructions({ privateDocsDir: dir });

    expect(result).toContain("Ask first before broad rm commands.");
    expect(result).not.toContain("CONDOR_PRIVATE_MARKER");
  });

  it("truncates loaded docs to the configured prompt budget", async () => {
    // Private docs should not accidentally balloon every future session prompt.
    const dir = await makePrivateDocsDir();
    await writeFile(join(dir, "default-agent-guidance.md"), "1234567890abcdefTAIL", "utf-8");

    const result = await loadPrivateDefaultInstructions({ privateDocsDir: dir, maxBytes: 12 });

    expect(result).toContain("1234567890ab");
    expect(result).toContain("Truncated by Takode private-instruction loader");
    expect(result).not.toContain("TAIL");
  });
});
