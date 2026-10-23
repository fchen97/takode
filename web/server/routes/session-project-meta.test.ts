import { describe, expect, it, vi } from "vitest";
import { createSessionProjectMetaBackfill } from "./session-project-meta.js";

describe("session project metadata across hosts", () => {
  // The helper extraction must retain the upstream host boundary: a remote
  // cwd can name a different repository (or no repository) on this machine.
  it("does not infer a remote session's repository from the coordinator filesystem", async () => {
    const getRepoInfo = vi.fn(async () => ({ repoRoot: "/coordinator/repo" }));
    const info = { cwd: "/shared/path", hostId: "remote-host", repoRoot: undefined };

    await createSessionProjectMetaBackfill(getRepoInfo)(info);

    expect(getRepoInfo).not.toHaveBeenCalled();
    expect(info.repoRoot).toBeUndefined();
  });

  // Host-authored bridge metadata remains usable even though local inference
  // is forbidden, including when the launcher has not recovered its cwd yet.
  it("uses remote bridge metadata without querying local git", async () => {
    const getRepoInfo = vi.fn(async () => ({ repoRoot: "/coordinator/repo" }));
    const info = { cwd: "", hostId: "remote-host", repoRoot: undefined };

    await createSessionProjectMetaBackfill(getRepoInfo)(info, {
      state: { cwd: "/remote/repo/subdir", repo_root: "/remote/repo" },
    });

    expect(info).toMatchObject({ cwd: "/remote/repo/subdir", repoRoot: "/remote/repo" });
    expect(getRepoInfo).not.toHaveBeenCalled();
  });
});
