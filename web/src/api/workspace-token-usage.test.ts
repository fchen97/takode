import { describe, expect, it, vi } from "vitest";
import { createWorkspaceTokenUsageApi } from "./workspace-token-usage.js";
import type { WorkspaceTokenUsageByModelSummary } from "./workspace-token-usage-types.js";

describe("createWorkspaceTokenUsageApi", () => {
  it("uses the shared API transport and forwards cancellation", async () => {
    // Keep the extracted domain client on the same transport contract as the main API facade.
    const summary: WorkspaceTokenUsageByModelSummary = {
      models: [],
      totalTokens: 0,
      history: { ranges: [], limited: false, limitedReasons: [] },
      generatedAt: 123,
    };
    const get = vi.fn(async () => summary);
    const signal = new AbortController().signal;

    await expect(createWorkspaceTokenUsageApi(get).getWorkspaceTokenUsageByModel(signal)).resolves.toBe(summary);
    expect(get).toHaveBeenCalledWith("/sessions/token-usage-by-model", signal);
  });
});
